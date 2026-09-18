/**
 * 纯函数：生成结果的「硬闸门」—— 不依赖模型配合的确定性兜底
 *
 * 为什么需要它（实测证据，41 楼真实聊天 + deepseek-flash）：
 *   骨架提示词要求「正文总长不超过 {{words}}=200 字」，模型实际输出 **665 字（3.3 倍）**，
 *   并把一张状态表写成了小说（场景描写 / 对白 / 心理独白，17 段里 0 段来自聊天记录）。
 *   而插件此前对生成结果**没有任何结构或长度校验**：
 *     · `refreshSkeleton` 只拒绝「空内容」，其余原样落库；
 *     · 设置项 `skeletonTokenCap` 在全仓库**没有任何代码读它**（死设置，探针实测 0 处）。
 *   于是坏输出原样进入世界书，并在下一轮作为 `{{previous}}` 再喂回给模型 —— 错误自我叠加。
 *
 * 提示词只能"请求"模型守规矩，不能"保证"。所以这里做两件确定性的事：
 *   ① 结构化过滤：只保留状态字段行，丢弃叙述体（丢掉的内容不进上下文 = 真正省 token）
 *   ② 硬长度上限：超过 tokenCap 时按字段优先级裁剪，**绝不原样放行**
 * 结构完全不合法时明确返回 ok:false，由调用方保留旧卡 —— 宁可留着上一版，也不写入垃圾。
 *
 * 本文件不 import 任何模块（估 token 由调用方注入），可在 Node 里直接跑回归。
 */

/** 骨架允许的字段（与默认骨架提示词的 4 行模板一致；顺序即展示顺序） */
export const SKELETON_FIELDS = ['当前阶段', '在场', '状态变化', '未结钩子'];

/**
 * 裁剪优先级：越靠前越先被牺牲。
 * 「当前阶段」不在名单里 —— 一张不知道当下在哪的现状卡没有意义，它只允许被截断，不允许被丢。
 */
export const SKELETON_DROP_ORDER = ['状态变化', '未结钩子', '在场'];

/** 中文字/token 的经验系数，与 src/tokens.js 保持一致（那里的注释解释了为什么取保守侧） */
const CJK_PER_TOKEN = 1.2;

/** 字段正文裁剪后至少保留的字数 */
const MIN_BODY = 4;

/** 套在输出外面的代码围栏（骨架此前没有这一步，节点侧由 stripCodeFence 处理） */
export function stripFence(text) {
    let s = String(text ?? '').trim();
    s = s.replace(/^```[a-zA-Z0-9-]*\s*/, '').replace(/```\s*$/, '');
    return s.trim();
}

/**
 * 解析单行是否为「字段：正文」。
 * 容忍 `【未结钩子】：x` / `状态变化: x`（半角冒号）/ 前置 markdown 装饰。
 * @returns {{field:string, body:string}|null}
 */
function parseFieldLine(line, fields) {
    const m = /^[\s>#*\-–—•【\[（(]*([^：:]{1,10}?)[\s】\]）)]*[：:]\s*([\s\S]*)$/.exec(line);
    if (!m) return null;
    const name = m[1].trim();
    if (!fields.includes(name)) return null;
    return { field: name, body: m[2].trim().replace(/[\s。；;]+$/, '') };
}

/**
 * 把模型输出解析成字段行。
 *
 * 两条路径：先按行解析（字段正文 = 该行剩余部分，**不跨行**，避免把下一段的叙述体吞进字段里）；
 * 一行都没解析出来时，退化成"行内切分"（模型把整张卡挤在一行是很常见的）。
 *
 * @returns {{lines:Array<{field:string,body:string}>, droppedLines:string[], duplicates:number}}
 */
export function parseSkeleton(text, fields = SKELETON_FIELDS) {
    const lines = [];
    const droppedLines = [];
    let duplicates = 0;

    const push = (field, body) => {
        if (lines.some(l => l.field === field)) { duplicates++; return; }
        lines.push({ field, body });
    };

    const rawLines = stripFence(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (const line of rawLines) {
        // 行内切分必须排在按行解析**之前**：整张卡挤在一行时，"当前阶段" 会以
        // "按行解析成功" 的姿态把后面三个字段全吞进自己的正文里（回归用例第 5 组守住它）。
        const inline = splitInline(line, fields);
        if (inline.length >= 2) { for (const it of inline) push(it.field, it.body); continue; }
        const hit = parseFieldLine(line, fields);
        if (hit) { push(hit.field, hit.body); continue; }
        droppedLines.push(line);
    }
    return { lines, droppedLines, duplicates };
}

/** 行内切分：按字段标记把一行拆成多段，正文止于下一个字段标记 */
function splitInline(line, fields) {
    const re = new RegExp(`(${fields.join('|')})\\s*[：:]`, 'g');
    const marks = [...line.matchAll(re)];
    if (marks.length < 2) return [];
    const out = [];
    for (let i = 0; i < marks.length; i++) {
        const start = marks[i].index + marks[i][0].length;
        const end = i + 1 < marks.length ? marks[i + 1].index : line.length;
        out.push({ field: marks[i][1], body: line.slice(start, end).trim().replace(/[\s。；;]+$/, '') });
    }
    return out;
}

/** 按 fields 的固定顺序渲染，保证面板里的观感稳定 */
function joinLines(lines, fields = SKELETON_FIELDS) {
    return [...lines]
        .sort((a, b) => fields.indexOf(a.field) - fields.indexOf(b.field))
        .map(l => `${l.field}：${l.body}`)
        .join('\n');
}

/** 整段丢弃一个字段（按优先级） */
function dropNext(lines, dropOrder, actions) {
    for (const f of dropOrder) {
        const i = lines.findIndex(l => l.field === f && l.body.length > 0);
        if (i !== -1) { actions.push(`丢弃「${f}」`); lines.splice(i, 1); return true; }
    }
    return false;
}

/** 截断最长的字段正文，尽量切在句读处 */
function cutLongest(lines, cutChars, actions) {
    const cand = lines
        .map((l, i) => ({ i, len: l.body.length }))
        .filter(c => c.len > MIN_BODY)
        .sort((a, b) => b.len - a.len)[0];
    if (!cand) return false;

    const body = lines[cand.i].body;
    let keep = Math.max(MIN_BODY, body.length - cutChars);
    let head = body.slice(0, keep);
    const boundary = Math.max(...['。', '！', '？', '；'].map(c => head.lastIndexOf(c)));
    if (boundary >= MIN_BODY) head = head.slice(0, boundary + 1);
    lines[cand.i].body = `${head.replace(/[，、,；;]\s*$/, '')}…`;
    actions.push(`截断「${lines[cand.i].field}」`);
    return true;
}

/**
 * 硬闸门入口。
 *
 * @param {string} raw 模型原始输出
 * @param {{tokenCap:number, estimate:(t:string)=>number, fields?:string[], dropOrder?:string[]}} opts
 *        estimate 由调用方注入（通常是 src/tokens.js 的 estimateTokens），本模块保持零依赖。
 * @returns {{
 *   ok:boolean, reason?:string,
 *   content:string, tokens:number,
 *   rawTokens:number, rawChars:number,
 *   dropped:string[], truncated:string[], actions:string[],
 *   changed:boolean, overCapRemain:boolean
 * }}
 */
export function enforceSkeleton(raw, opts = {}) {
    const fields = Array.isArray(opts.fields) && opts.fields.length ? opts.fields : SKELETON_FIELDS;
    const dropOrder = Array.isArray(opts.dropOrder) && opts.dropOrder.length ? opts.dropOrder : SKELETON_DROP_ORDER;
    const estimate = typeof opts.estimate === 'function' ? opts.estimate : (t => Math.ceil(String(t ?? '').length / CJK_PER_TOKEN));
    const cap = Number(opts.tokenCap) > 0 ? Number(opts.tokenCap) : 350;

    const rawText = stripFence(raw);
    const rawTokens = estimate(rawText);
    const rawChars = rawText.length;

    const { lines, droppedLines, duplicates } = parseSkeleton(rawText, fields);
    if (!lines.length) {
        return {
            ok: false, reason: 'no-fields',
            content: '', tokens: 0, rawTokens, rawChars,
            dropped: droppedLines, truncated: [], actions: [],
            changed: false, overCapRemain: false,
        };
    }

    const actions = [];
    if (droppedLines.length) actions.push(`丢弃 ${droppedLines.length} 行非字段内容`);
    if (duplicates) actions.push(`合并 ${duplicates} 处重复字段`);

    const dropped = [];
    const truncated = [];
    let tokens = estimate(joinLines(lines, fields));

    // ① 先按优先级整段丢弃 ② 丢不动了再截断最长正文 ③ 都不行了就停（守卫防止死循环）
    let guard = 0;
    while (tokens > cap && guard++ < 40) {
        const before = tokens;
        if (!dropNext(lines, dropOrder, actions)) {
            const cut = Math.ceil((tokens - cap) * CJK_PER_TOKEN) + 2;
            if (!cutLongest(lines, cut, actions)) break;
        }
        tokens = estimate(joinLines(lines, fields));
        if (tokens >= before) break;
    }

    const content = joinLines(lines, fields);
    for (const f of dropOrder) if (!lines.some(l => l.field === f) && !dropped.includes(f)) dropped.push(f);
    if (actions.some(a => a.startsWith('截断'))) {
        for (const m of actions) { const g = /截断「(.+?)」/.exec(m); if (g && !truncated.includes(g[1])) truncated.push(g[1]); }
    }

    return {
        ok: true,
        content,
        tokens,
        rawTokens,
        rawChars,
        dropped,
        truncated,
        actions,
        changed: actions.length > 0,
        overCapRemain: tokens > cap,
    };
}
