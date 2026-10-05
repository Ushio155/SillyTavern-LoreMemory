/**
 * 纯函数：生成结果的「硬闸门」—— 不依赖模型配合的确定性兜底
 *
 * 两层守卫，同一原则（提示词只能"请求"模型守规矩，守卫才"保证"）：
 *   ① 骨架现状卡 `enforceSkeleton()` —— 结构过滤 + 超长裁剪 + 完全不合法就拒收
 *   ② 节点摘要 `inspectOutput()` / `needsSummaryRepair()` / `pickBetterSummary()` / `capNodeBody()`
 *
 * 为什么需要它（实测证据，41 楼真实聊天 + deepseek-flash）：
 *   骨架提示词要求「正文总长不超过 {{words}}=200 字」，模型实际输出 **665 字（3.3 倍）**，
 *   并把一张状态表写成了小说（场景描写 / 对白 / 心理独白，17 段里 0 段来自聊天记录）。
 *   而插件此前对生成结果**没有任何结构或长度校验**：
 *     · `refreshSkeleton` 只拒绝「空内容」，其余原样落库；
 *     · 设置项 `skeletonTokenCap` 在全仓库**没有任何代码读它**（死设置，探针实测 0 处）。
 *   于是坏输出原样进入世界书，并在下一轮作为 `{{previous}}` 再喂回给模型 —— 错误自我叠加。
 *
 * 节点的第二份实测证据（v3 补的，就在用户的真实聊天书上量的）：
 *   21 条条目里有 **7 条**正文是 1.5k–4.1k 字的小说体、关键词是 2–6 字碎片，
 *   全部被标「待确认」禁用 —— 而节点侧当时**只有"降级"没有"拒绝"**：
 *   `parseSummaryOutput` 找不到 JSON 就把整篇小说当正文收下，一次坏采样直接进书。
 *   对照 CardLore §8.3「输出守卫与自动修复」：客户端必须能断定"这次输出不合格"并重试。
 *
 * 本文件不 import 任何模块（估 token 由调用方注入），可在 Node 里直接跑回归。
 */

/** 骨架允许的字段（与默认骨架提示词的 4 行模板一致；顺序即展示顺序） */
export const SKELETON_FIELDS = ['当前阶段', '在场', '状态变化', '未结钩子'];

/**
 * 字段别名 —— 模型很爱换说法（"当前状态""在场人物""伏笔"…）。
 * 不认别名的话，一份**内容完全正确**的卡会因为标签不同被整张拒收：
 * 这是我们自己的模板要求太窄，不该由用户承担。
 * 匹配时**先精确名、再按别名长度降序**，避免「状态」抢走「状态变化」。
 */
export const SKELETON_ALIASES = {
    当前阶段: ['当前状态', '现状', '当前局面', '局面', '阶段'],
    在场: ['在场人物', '在场者', '人物', '角色'],
    状态变化: ['状态更新', '变化', '状态'],
    未结钩子: ['未结伏笔', '未解钩子', '钩子', '伏笔', '悬念', '未结'],
};

/** 别名 → 标准字段名（含标准名自身） */
export function canonicalField(name, fields = SKELETON_FIELDS, aliases = SKELETON_ALIASES) {
    const raw = String(name ?? '').trim();
    if (fields.includes(raw)) return raw;
    const pairs = [];
    for (const f of fields) {
        for (const a of (aliases[f] || [])) pairs.push([a, f]);
    }
    pairs.sort((x, y) => y[0].length - x[0].length);   // 长的先匹配
    for (const [alias, field] of pairs) {
        if (raw === alias) return field;
    }
    return null;
}

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
    const field = canonicalField(m[1].trim(), fields);
    if (!field) return null;
    return { field, body: m[2].trim().replace(/[\s。；;]+$/, '') };
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
    // 别名也参与切分，且**长的排前面**，否则「状态」会抢走「状态变化」
    const names = [];
    for (const f of fields) {
        names.push(f);
        for (const a of (SKELETON_ALIASES[f] || [])) names.push(a);
    }
    names.sort((a, b) => b.length - a.length);
    const re = new RegExp(`(${names.join('|')})\\s*[：:]`, 'g');
    const marks = [...line.matchAll(re)];
    if (marks.length < 2) return [];
    const out = [];
    for (let i = 0; i < marks.length; i++) {
        const field = canonicalField(marks[i][1], fields);
        if (!field) continue;
        const start = marks[i].index + marks[i][0].length;
        const end = i + 1 < marks.length ? marks[i + 1].index : line.length;
        out.push({ field, body: line.slice(start, end).trim().replace(/[\s。；;]+$/, '') });
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

// ═══════════════════════════════════════════════════════════════════════════════
// 节点输出守卫（v3）
//
// 与骨架守卫的分工：骨架是"结构对不对"（字段行），节点是"作业交没交"（是不是那个 JSON）。
// 节点守卫**不重做 JSON 解析** —— 解析由 src/settings.js 的 `parseSummaryOutput` 负责，
// 这里只拿它的结果 + 原文来做三件事，避免两处各写一份解析逻辑而慢慢漂移：
//   ① 判定形状（json / text / narrative / empty）② 决定要不要带着"格式纠错"重试 ③ 多次取优
// ═══════════════════════════════════════════════════════════════════════════════

/** 默认节点提示词要求的小节标题（出现得多 ⇒ 更像"归档"，而不是"在写小说"） */
export const SUMMARY_SECTIONS = ['发生了什么', '谁在场', '状态变化', '未结钩子', '关键设定'];

/** 单次总结最多尝试几次（第一次 + 最多两次纠错重试）。费用只在**不合格**时才产生。 */
export const MAX_SUMMARY_ATTEMPTS = 3;

/**
 * 一轮总结（含纠错重试）的总时间预算。
 * 超过就不再重试：index.js 的 `SUMMARIZING_STALE_MS`（150 秒）会把"正在生成"判成卡死，
 * 3 次慢生成足以撞上它，那会表现成"面板忽然说没在生成、自动总结又能重入"的诡异现象。
 */
export const RETRY_BUDGET_MS = 120000;

/**
 * 格式纠错后缀：拼在**原提示词之后**再发一次。
 *
 * 为什么不改写系统提示：ST 把 quiet 提示词放在整段上下文的最后一条消息
 * （`scripts/openai.js` L1211-1227「This should always be last」），
 * 所以"最后那句话"权重最高 —— 纠错必须落在这个位置上，而不是塞进已经被淹没的开头。
 */
export const REPAIR_JSON_SUFFIX = `【格式纠错】你上一次的回复不是要求的 JSON 对象，而是一段叙述 / 剧情文字。
那整段是**待归档的材料**，不是要你写的东西 —— 不要复述它、不要续写它、不要写对白。
现在只输出那一个 JSON 对象：第一个字符必须是 { ，且只包含 title / tier / keywords / summary 四个字段。`;

/** 空输出后缀（推理模型把预算烧在思维链上时的现场对策，对照 CardLore 的 EMPTY_OUTPUT_SUFFIX） */
export const EMPTY_OUTPUT_SUFFIX = `【立即动笔】不要分析任务、不要输出思考过程、不要解释。
直接从 { 开始，把那一个 JSON 对象写出来。`;

/**
 * 提示词自己声明了要 JSON 吗？
 *
 * 用来区分两种"没给 JSON"：违约（我们要求的）还是本意（用户自己改的提示词）。
 * 拿提示词**模板**判断，不看模型输出 —— 这样"用户故意让提示词输出纯文本"不会被我们硬拗成 JSON。
 *
 * 难点全在中文否定上（写这条时踩了个真坑）：`/json/i` 会把「**不要** JSON」也判成"要 JSON"，
 * 于是"尊重用户意图"那条策略直接失效。所以先认否定、再认正向：
 *   · 正向优先：「只输出 JSON」「必须输出 JSON」这类强要求，直接算要 JSON；
 *   · 否定：「不要 / 无需 / 不用 / 别 / 禁止（输出）JSON」⇒ 不要 —— 但「不要输出 JSON **以外的**内容」
 *     显然是要 JSON，所以否定后面跟着"以外/之外"时不算否定。
 * 判错的代价是**不对称**的：漏判只会少重试一次（坏输出照样降级+截断，不会更糟），
 * 误判才会去跟用户的提示词对着干。所以这里的取向是"宁可漏判"。
 */
export function promptWantsJson(template) {
    const t = String(template ?? '');
    if (!t) return false;
    if (/(只|仅|必须|一定|请)\s*(输出\s*)?(那?一?个?\s*)?json/i.test(t)) return true;
    if (/(不要|无需|不用|别|禁止)\s*(输出\s*)?json(?!\s*(以外|之外))/i.test(t)) return false;
    return /json/i.test(t) || /\{\s*"/.test(t);
}

/** 正文"远远超长"的阈值：目标字数的 2 倍，下限 400 字 */
export function overlongLimit(words) {
    const w = Number(words) > 0 ? Number(words) : 200;
    return Math.max(2 * w, 400);
}

/**
 * 判定一次生成结果的形状。**廉价且不可欺骗**（只做字面统计，不做语义判断）。
 *
 * ⚠️ v3.1 修的洞（用户实测"写完 JSON 还是写小说"）：判据必须看**将要落库的那段正文**
 * （`parsed.summary`），而不是只看"整段输出是不是 JSON"。原来的写法是
 * `degraded === false ⇒ 立刻 return shape:'json'`，于是当模型**老老实实交了 JSON、
 * 却把一整篇小说塞进 `summary` 字段**时：既不算 narrative（根本没跑那些特征检测）、
 * 也不算超长（没有长度判据），守卫直接放行，`nodeTokenCap` 也只管降级路径 ——
 * 结果就是"格式完全正确的小说"原样进书，而且因为关键词解析成功还标成 active。
 * 这是 v3 提示词的**副作用**：提示词越强调"只输出 JSON"，模型越可能用 JSON 包装续写。
 *
 * @param {{ok:boolean, degraded:boolean, format:string, keywords?:string[], summary?:string}} parsed
 *        `parseSummaryOutput` 的结果（JSON 解析的唯一来源）
 * @param {string} raw 模型原始输出
 * @param {{words?:number}} [opts] words = 目标字数，用来判"远远超长"
 * @returns {{shape:'json'|'text'|'narrative'|'empty', ok:boolean, trust:boolean, chars:number,
 *            bodyChars:number, overlong:boolean, narrative:boolean, lines:number, sections:number,
 *            keywords:number, signals:string[]}}
 */
export function inspectOutput(parsed, raw, opts = {}) {
    const text = stripFence(raw);
    const words = Number(opts.words) > 0 ? Number(opts.words) : 200;
    // parseSummaryOutput 只在**真的解析出了 JSON 对象**时才 degraded=false
    const shaped = !!parsed && parsed.degraded === false;
    const body = String(parsed?.summary ?? '').trim();
    // 判据看"要落库的正文"；连正文都没有（空输出）时才退回看整段原文
    const subject = shaped && body ? body : text;
    const lines = subject.split(/\r?\n/).map(s => s.trim()).filter(Boolean).length;
    const sections = SUMMARY_SECTIONS.filter(s => subject.includes(s)).length;
    const keywords = Array.isArray(parsed?.keywords) ? parsed.keywords.length : 0;
    const bodyChars = body.length || text.length;
    const overlong = bodyChars > overlongLimit(words);

    const signals = [];
    if (overlong) signals.push(`${bodyChars} 字远超目标 ${words} 字`);
    const dialogue = (subject.match(/「[^」]{2,}」/g) || []).length;
    if (dialogue >= 2) signals.push(`成句对白 ${dialogue} 处`);
    const inner = (subject.match(/【[^】]{6,}】/g) || []).length;
    if (inner >= 1) signals.push(`方括号独白/板块 ${inner} 处`);
    const blanks = (subject.match(/\n[ \t]*\n/g) || []).length;
    if (blanks >= 3 || lines >= 12) signals.push(`多段叙述（${lines} 段 / ${blanks} 处空行）`);
    if (sections === 0) signals.push('一个规定小节标题都没有');

    // 至少两条独立特征、且没有我们的结构化小节 ⇒ 判"在写小说"（单条特征太容易误伤正常摘要）
    const narrative = signals.length >= 2 && sections <= 1;
    const ok = parsed?.ok === true;

    const base = {
        ok, chars: text.length, bodyChars, overlong, narrative, lines, sections, keywords, signals,
        // trust = "这段正文可以原样进书"：不超长、不像小说、而且真的是 JSON 交上来的
        trust: shaped && ok && !overlong && !narrative,
    };

    if (!text.length) return { ...base, shape: 'empty', trust: false, signals: ['空输出'] };
    if (shaped) return { ...base, shape: 'json' };
    return { ...base, shape: narrative ? 'narrative' : 'text' };
}

/** 这次输出要不要带着纠错后缀重试？（策略见 REPAIR_JSON_SUFFIX / promptWantsJson 的注释） */
export function needsSummaryRepair(insp, template) {
    if (!insp) return false;
    if (insp.shape === 'empty') return true;               // 空输出：多半是推理把预算烧光了
    // 是 JSON：除了"解析不出正文"，还要求正文本身合格 —— 否则"JSON 包装的小说"会被放行（v3.1 的洞）
    if (insp.shape === 'json') return insp.ok === false || insp.overlong === true || insp.narrative === true;
    if (insp.shape === 'narrative') return true;           // 写小说：无论提示词怎么写都算坏
    return promptWantsJson(template);                      // 纯文本：只有"提示词自己要过 JSON"才算违约
}

/**
 * 候选正文的"坏度"：超长最致命（2 分），像小说次之（1 分），0 分才是可以进书的。
 * 为什么不用 `trust` 直接排序：纯文本候选（没按 JSON 交作业）的 trust 也是 false，
 * 单看 trust 会让"JSON 包装的小说"和"短纯文本"打平，接着被 SHAPE_RANK 判成 JSON 更优 —— 灾难。
 */
function bodyBadness(insp) {
    if (!insp) return 4;
    if (insp.shape === 'empty') return 3;
    return (insp.overlong ? 2 : 0) + (insp.narrative ? 1 : 0);
}

const SHAPE_RANK = { json: 2, text: 1, narrative: 0, empty: -1 };

/**
 * 多次尝试里取优（对照 CardLore 的 `pickBetterOutput`：先比字段命中数，再比保留率）。
 * 我们比的东西必须**廉价**：坏度（超长/像小说）→ 形状 → 关键词个数 → 更短（小说越长越是灾难）。
 * 完全同分取**后者**（它带着纠错后缀重来过，更可能是"想对了但没说完"）。
 *
 * @param {Array<{raw:string, insp:object}>} cands
 * @returns {{raw:string, insp:object}|null}
 */
export function pickBetterSummary(cands) {
    const list = Array.isArray(cands) ? cands.filter(Boolean) : [];
    let best = null;
    for (const c of list) {
        if (!best) { best = c; continue; }
        const ba = bodyBadness(c.insp);
        const bb = bodyBadness(best.insp);
        if (ba !== bb) { if (ba < bb) best = c; continue; }
        const ra = SHAPE_RANK[c.insp?.shape] ?? -1;
        const rb = SHAPE_RANK[best.insp?.shape] ?? -1;
        if (ra !== rb) { if (ra > rb) best = c; continue; }
        const ka = Number(c.insp?.keywords) || 0;
        const kb = Number(best.insp?.keywords) || 0;
        if (ka !== kb) { if (ka > kb) best = c; continue; }
        const ca = Number(c.insp?.chars) || 0;
        const cb = Number(best.insp?.chars) || 0;
        if (ca < cb) best = c;
        else if (ca === cb) best = c;   // 同分取后者
    }
    return best;
}

/**
 * 降级正文的长度闸门：模型没按格式返回时，**绝不把一整篇小说原样写进书里**
 * （世界书条目是要被注入上下文的；节点此时虽然标了「待确认」并禁用，
 *  但用户随时可能点"启用"，而且 4 KB 的正文在面板里也读不出任何信息）。
 *
 * 截断点尽量落在句读 / 换行上；被切掉的原文由调用方存进 `prevContent`，
 * 面板上的「回滚正文」能取回 —— 所以这是"默认不给"，不是"删掉"。
 *
 * @param {string} text
 * @param {{maxChars:number, note?:boolean}} opts
 * @returns {{content:string, truncated:boolean, chars:number, kept:number}}
 */
export function capNodeBody(text, opts = {}) {
    const src = String(text ?? '');
    const maxChars = Number(opts.maxChars) > 0 ? Math.floor(Number(opts.maxChars)) : 0;
    if (!maxChars || src.length <= maxChars) {
        return { content: src, truncated: false, chars: src.length, kept: src.length };
    }
    let head = src.slice(0, maxChars);
    const cut = Math.max(...['。', '！', '？', '；', '\n'].map(c => head.lastIndexOf(c)));
    if (cut >= Math.floor(maxChars * 0.5)) head = head.slice(0, cut + 1);
    head = head.trimEnd();
    const note = opts.note === false
        ? ''
        : `\n\n（模型没有按 JSON 格式返回，原文 ${src.length} 字：以上是前 ${head.length} 字，未采纳；点「回滚正文」可取回完整原文）`;
    return { content: head + note, truncated: true, chars: src.length, kept: head.length };
}
