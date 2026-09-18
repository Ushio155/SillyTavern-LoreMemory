/**
 * 纯函数：插件设置、转录构建、提示词渲染、模型输出解析、关键词兜底抽取
 *
 * 设置存 `extension_settings.LoreMemory`（**全局**，对所有聊天生效）——
 * 与 ST 自带 memory 扩展的做法一致，用户预期也是"设置一次到处生效"。
 * 每聊天独有的东西（书、游标、节点、账本）仍然只存在 chat_metadata 里。
 *
 * 本文件不 import 任何 ST 模块，可在 Node 里直接跑回归。
 */

export const SETTINGS_VERSION = 2;

/** 默认提示词的版本号：改默认提示词时 +1，老用户保存过的会自动迁移（沿用 CardLore 的做法） */
export const DEFAULT_PROMPT_VERSION = 2;

/**
 * 默认摘要提示词。
 *
 * 三个硬性设计（都由实测教训而来，不是随便写的）：
 *  1. 「禁止把主角名当关键词」——ST 默认把发言人名拼进扫描缓冲，主角名做 key = 每回合必中。
 *  2. 结构化小标题 —— 便于压缩、便于人工审阅、便于后续按小节做预算裁剪。
 *  3. 只输出 JSON —— 插件要靠它填 title / keywords / content 三个字段。
 *     用户改写提示词后若不产出 JSON，插件会退化成"整段当正文 + 关键词待确认"，不会崩。
 */
export const DEFAULT_PROMPT = `你在为一段角色扮演聊天做「记忆归档」。把下面的聊天记录压缩成一条结构化记忆节点。

要求：
- 只记录**已经发生的事实**，不要推测、不要续写、不要评价。
- 正文用五个固定小标题组织：发生了什么 / 谁在场 / 状态变化 / 未结钩子 / 关键设定。
- 正文总长不超过 {{words}} 个字。
- 关键词给 3–6 个，必须**同时**满足下面三条：
  ① 是**只在这段剧情里才会出现的具体事物**（地名、物品、组织、事件、称谓、别名、专有名词）；
  ② 不是主角名、不是用户名——ST 会把发言人名拼进扫描文本，用主角名做关键词等于每回合必中；
  ③ 在最近 10 条消息里出现过 3 条以上的词，一律不要用。
- **绝对不要把角色卡里的数值/变量名/机制名当关键词**——例如「好感度」「等级」「状态」「能力名」，
  以及你自己在正文里写出的那些数值字段名。这类词几乎每回合都会出现，一旦做成关键词，
  这个节点就会在**所有**不相干的场景里被误触发。
- 宁可只给 2 个精准关键词，也不要给 5 个会误触发的词。
- tier 只填 main / side / detail 之一：主线剧情的推进填 main，支线或插曲填 side，一次性细节填 detail。

只输出一个 JSON 对象，不要解释、不要代码围栏：
{"title":"不超过14个字的短标题","tier":"main|side|detail","keywords":["关键词"],"summary":"结构化正文"}

—— 聊天记录开始（共 {{count}} 条，第 {{from}}-{{to}} 楼）——
{{messages}}
—— 聊天记录结束 ——`;

/** 提示词里可用的占位符（未知占位符会原样保留，并在 UI 上告警） */
export const PLACEHOLDERS = {
    messages: '按设置筛选后的聊天记录正文',
    words: '摘要目标长度（对应「摘要目标长度」设置）',
    skeletonWords: '骨架目标长度（对应「骨架目标长度」设置，只有骨架提示词用得到）',
    count: '本次参与总结的消息条数',
    from: '本次区间的起始楼号',
    to: '本次区间的结束楼号',
    char: '角色名',
    user: '用户名',
    previous: '上一版骨架现状卡的内容（只有骨架提示词用得到）',
};

/**
 * 骨架（现状卡）提示词。
 * 骨架是全书唯一 `constant: true` 的条目，永远注入，所以它必须**短且是当前状态**，
 * 不能变成历史流水——否则它自己就把预算吃光了。
 */
export const DEFAULT_SKELETON_PROMPT = `你在维护一张「现状卡」。它是这本记忆之书里唯一每回合都注入的条目。
它是一张**状态表**，不是小说。

【绝对禁止】
- 禁止场景描写：天气、光线、动作、神态、衣着、环境
- 禁止对白、禁止【】或括号里的内心独白
- 禁止续写故事、禁止编造没发生过的对话
- 只允许写"事实字段"

【输出格式：严格只输出下面这 4 行，一行不多】
当前阶段：＜一句话，≤20 字＞
在场：＜只写名字，≤5 个，用、分隔＞
状态变化：＜只写已经发生的变化，≤3 条，用；分隔＞
未结钩子：＜≤3 条，用；分隔；没有就写"无"＞

【硬性要求】
1. **全文不超过 {{skeletonWords}} 个字。** 输出前自己数一遍，超了就删到只剩最关键的字段。
2. 上一版只作参考。如果上一版描述的场景和最近对话已经对不上，**整张卡全部重写**，
   不要保留上一版的任何内容。
3. 未结钩子必须能在最近对话里找到依据。已经解决或已经过期的，必须删掉；
   宁可写"无"，也不许留旧钩子。
4. 不要标题、不要 JSON、不要代码围栏、不要解释、不要总结过程。

—— 上一版现状卡（仅供参考，可以整段丢弃）——
{{previous}}

—— 最近的对话（第 {{from}}-{{to}} 楼）——
{{messages}}`;

const SCAN_SCOPES = ['all', 'char', 'user'];

export const DEFAULT_SETTINGS = {
    // 自动化
    autoMemory: false,          // 默认关：自动摘要会真的调 API 花 token，必须用户显式打开
    promptInterval: 12,         // 每 N 条消息总结一次
    skeletonEvery: 24,          // 每 N 条刷新一次骨架现状卡（0 = 不自动刷新）
    // 扫描范围
    scanScope: 'all',           // all = 角色+用户 / char = 仅角色 / user = 仅用户
    includeSpeakerNames: true,  // 转录里是否带「角色名: 」前缀
    // 摘要
    promptWords: 200,
    skeletonWords: 120,         // 骨架独立目标长度：它每回合都注入，必须比节点短
    prompt: DEFAULT_PROMPT,
    skeletonPrompt: DEFAULT_SKELETON_PROMPT,
    promptVersion: DEFAULT_PROMPT_VERSION,
    skipWIAN: true,             // 摘要请求不带世界书/作者注：省 token，也避免记忆自己触发自己
    // 条目字段
    nodeTokenCap: 200,
    skeletonTokenCap: 350,
    sticky: 4,
    cooldown: 16,
    scanDepthHot: 8,
    // 面板
    budgetWarnPct: 10,
};

/** 每个设置的元信息 —— UI 直接按它渲染，避免界面和默认值各写一份 */
export const SETTINGS_META = {
    autoMemory: { type: 'boolean', label: '自动记忆', hint: '打开后：进入聊天自动建书；每满 N 条消息自动总结成节点（会调用你所配置的 API，消耗 token）' },
    promptInterval: { type: 'number', min: 1, max: 200, step: 1, label: '每多少条消息总结一次', hint: '对应 memory 扩展的「Update every N messages」。数值越小节点越细、摘要调用越频繁' },
    skeletonEvery: { type: 'number', min: 0, max: 500, step: 1, label: '每多少条消息刷新骨架', hint: '骨架是那条常驻的「现状卡」，0 = 不自动刷新' },
    scanScope: {
        type: 'select', label: '总结时扫描哪些消息',
        options: [['all', '角色 + 用户（默认）'], ['char', '仅角色对话'], ['user', '仅用户输入']],
        hint: '仅角色 = 只把角色说的话喂给摘要（叙事更聚焦）；仅用户 = 只记录玩家做了什么',
    },
    includeSpeakerNames: { type: 'boolean', label: '转录里带发言人名', hint: '关闭后只留正文，摘要会更难分辨谁在说话，但更省 token' },
    promptWords: { type: 'number', min: 30, max: 1000, step: 10, label: '摘要目标长度（字）', hint: '替换提示词里的 {{words}}；同时用于长度告警' },
    skeletonWords: { type: 'number', min: 20, max: 1000, step: 10, label: '骨架目标长度（字）', hint: '替换骨架提示词里的 {{skeletonWords}}。骨架每回合都注入，建议明显小于节点' },
    skipWIAN: { type: 'boolean', label: '摘要时不带世界书与作者注', hint: '省 token，并且避免记忆条目自己触发自己' },
    nodeTokenCap: { type: 'number', min: 50, max: 1000, step: 10, label: '单条节点上限（token）', hint: '超出会在面板标红' },
    skeletonTokenCap: { type: 'number', min: 50, max: 2000, step: 10, label: '骨架条目上限（token）', hint: '' },
    sticky: { type: 'number', min: 0, max: 50, step: 1, label: '命中后粘滞（楼）', hint: 'sticky：命中一次后继续保持几楼，避免同话题反复重扫' },
    cooldown: { type: 'number', min: 0, max: 200, step: 1, label: '之后冷却（楼）', hint: 'cooldown：冷却期内不再重复注入，这是省 token 的主武器' },
    scanDepthHot: { type: 'number', min: 1, max: 50, step: 1, label: '热点节点扫描深度', hint: '条目级 scanDepth，只影响标为「热点」的节点，不动全局设置' },
    budgetWarnPct: { type: 'number', min: 1, max: 100, step: 1, label: '注入占比告警线（%）', hint: '本回合记忆注入超过上下文的这个比例时，面板告警' },
};

function clamp(n, min, max) {
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
}

function coerce(key, value) {
    const meta = SETTINGS_META[key];
    if (!meta) return value;
    if (meta.type === 'boolean') return value === true || value === 'true' || value === 1;
    if (meta.type === 'number') {
        const n = Number(value);
        return clamp(Number.isFinite(n) ? n : DEFAULT_SETTINGS[key], meta.min ?? -Infinity, meta.max ?? Infinity);
    }
    if (meta.type === 'select') {
        return meta.options.some(o => o[0] === value) ? value : DEFAULT_SETTINGS[key];
    }
    return value;
}

/**
 * 把任意（可能是旧版本 / 手改过的）设置补齐成当前形状。永不抛异常。
 */
export function normalizeSettings(raw) {
    const out = { ...DEFAULT_SETTINGS };
    if (raw && typeof raw === 'object') {
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            if (key === 'prompt' || key === 'skeletonPrompt') continue; // 文本单独处理
            if (raw[key] !== undefined && raw[key] !== null) out[key] = coerce(key, raw[key]);
        }
        if (typeof raw.prompt === 'string' && raw.prompt.trim()) out.prompt = raw.prompt;
        if (typeof raw.skeletonPrompt === 'string' && raw.skeletonPrompt.trim()) out.skeletonPrompt = raw.skeletonPrompt;
        const v = Number(raw.promptVersion);
        out.promptVersion = Number.isFinite(v) ? v : 0;
    }

    // 默认提示词升级：用户手上那份如果是"某个旧版本的默认值"，就替换成新默认值；
    // 用户自己改过的（不等于任何历史默认值）绝对不动。
    if (out.promptVersion < DEFAULT_PROMPT_VERSION) {
        if (HISTORIC_DEFAULT_PROMPTS.has(out.prompt)) out.prompt = DEFAULT_PROMPT;
        if (HISTORIC_SKELETON_PROMPTS.has(out.skeletonPrompt)) out.skeletonPrompt = DEFAULT_SKELETON_PROMPT;
        out.promptVersion = DEFAULT_PROMPT_VERSION;
    }

    if (!SCAN_SCOPES.includes(out.scanScope)) out.scanScope = 'all';
    return out;
}

/**
 * 历史默认提示词：用于判断"用户这份是不是没改过的旧默认值"（新默认值发布时把旧的塞进来）。
 *
 * v2 升级把两份默认提示词都换了（骨架：改成 4 行模板 + 禁令；节点：关键词判据可机械执行 + tier）。
 * 只有**逐字等于这里的旧默认值**的那份才会被替换 —— 用户自己改过的一个字都不动。
 */
export const HISTORIC_DEFAULT_PROMPTS = new Set([`你在为一段角色扮演聊天做「记忆归档」。把下面的聊天记录压缩成一条结构化记忆节点。

要求：
- 只记录**已经发生的事实**，不要推测、不要续写、不要评价。
- 正文用五个固定小标题组织：发生了什么 / 谁在场 / 状态变化 / 未结钩子 / 关键设定。
- 正文总长不超过 {{words}} 个字。
- 关键词给 3–8 个，必须是**专有名词或独特称谓**（地名、物品、组织、事件、称谓、别名）。
  禁止使用主角名与用户名——ST 会把发言人名拼进扫描文本，用主角名做关键词等于每回合必中；
  也禁止「剑」「人」「这里」这类高频词。宁可少给，也不要给会误触发的词。

只输出一个 JSON 对象，不要解释、不要代码围栏：
{"title":"不超过14个字的短标题","keywords":["关键词"],"summary":"结构化正文"}

—— 聊天记录开始（共 {{count}} 条，第 {{from}}-{{to}} 楼）——
{{messages}}
—— 聊天记录结束 ——`]);

export const HISTORIC_SKELETON_PROMPTS = new Set([`你在维护一张「现状卡」。它是这本记忆之书里唯一常驻注入的条目，
作用是让模型随时知道"现在是什么局面"。

输入是上一版现状卡（可能为空）和最近的对话记录。

要求：
- 输出**当前状态**，不是历史流水。已经过时的信息要删掉，不要越写越长。
- 上一版里"未结钩子"中、这段对话没有解决的，必须原样保留下来。
- 正文总长不超过 {{words}} 个字。
- 用四个固定小节：当前阶段 / 在场人物 / 状态变化 / 未结钩子。

只输出正文本身，不要 JSON、不要解释、不要代码围栏。

—— 上一版现状卡 ——
{{previous}}

—— 最近的对话（第 {{from}}-{{to}} 楼）——
{{messages}}`]);

/** 用户有没有改过提示词 */
export function isCustomPrompt(settings) {
    return String(settings?.prompt ?? '') !== DEFAULT_PROMPT;
}

/** 用户有没有改过骨架提示词 */
export function isCustomSkeletonPrompt(settings) {
    return String(settings?.skeletonPrompt ?? '') !== DEFAULT_SKELETON_PROMPT;
}

/** 提示词里用了哪些未知占位符（UI 告警用） */
export function unknownPlaceholders(template) {
    const found = new Set();
    for (const m of String(template ?? '').matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
        if (!Object.prototype.hasOwnProperty.call(PLACEHOLDERS, m[1])) found.add(m[1]);
    }
    return [...found];
}

/** 把 {{占位符}} 替换成实际值；未知占位符原样保留（让用户看得见自己打错了） */
export function renderPrompt(template, vars) {
    return String(template ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key) => {
        return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole;
    });
}

/**
 * 按「扫描范围」筛选消息并拼成转录文本。
 * @param {Array<{is_user:boolean,name?:string,mes?:string}>} messages 本次区间内的消息
 * @param {{scope?:string, includeSpeakerNames?:boolean, startIndex?:number}} opts
 *   startIndex：本条消息在**整个聊天**里的 0 基下标，用来算楼号
 * @returns {{text:string, used:number, skipped:number}}
 */
export function buildTranscript(messages, opts = {}) {
    const scope = SCAN_SCOPES.includes(opts.scope) ? opts.scope : 'all';
    const includeNames = opts.includeSpeakerNames !== false;
    const startIndex = Number.isFinite(opts.startIndex) ? opts.startIndex : 0;

    const lines = [];
    let skipped = 0;
    (messages || []).forEach((m, i) => {
        if (!m) return;
        if (scope === 'char' && m.is_user) { skipped++; return; }
        if (scope === 'user' && !m.is_user) { skipped++; return; }
        const floor = startIndex + i + 1;
        const body = String(m.mes ?? '').trim();
        const who = String(m.name || (m.is_user ? 'User' : 'Char'));
        lines.push(includeNames ? `[${floor}] ${who}: ${body}` : `[${floor}] ${body}`);
    });

    return { text: lines.join('\n'), used: lines.length, skipped };
}

/** 还没被总结的消息条数 */
export function pendingCount(chatLength, cursor) {
    const len = Number(chatLength) || 0;
    const cur = Number(cursor) || 0;
    return Math.max(0, len - cur);
}

/** 是否该自动总结了 */
export function shouldSummarize(chatLength, cursor, settings) {
    const every = Number(settings?.promptInterval) || 0;
    if (every <= 0) return false;
    return pendingCount(chatLength, cursor) >= every;
}

/** 是否该刷新骨架了 */
export function shouldRefreshSkeleton(chatLength, skeletonAt, settings) {
    const every = Number(settings?.skeletonEvery) || 0;
    if (every <= 0) return false;
    return (Number(chatLength) || 0) - (Number(skeletonAt) || 0) >= every;
}

/** 剥掉模型习惯性套的代码围栏 */
export function stripCodeFence(text) {
    let s = String(text ?? '').trim();
    s = s.replace(/^```(?:json|JSON)?\s*/, '').replace(/```\s*$/, '');
    return s.trim();
}

/** 常见中文功能词/虚词——兜底抽词时必须排除，否则会抽出一堆"我们""这个" */
const ZH_STOPWORDS = new Set([
    '什么', '我们', '你们', '他们', '她们', '这个', '那个', '这些', '那些', '自己', '已经', '还有',
    '然后', '因为', '所以', '但是', '如果', '一个', '一起', '现在', '时候', '这样', '那样', '知道',
    '可以', '没有', '不是', '就是', '感觉', '似乎', '仿佛', '终于', '突然', '依然', '只是', '而且',
    '于是', '不过', '其实', '确实', '或者', '以及', '对于', '关于', '一直', '一下', '出来', '起来',
    '过去', '过来', '下去', '进去', '什么', '怎么', '为什么', '哪里', '这里', '那里', '多久', '多少',
]);

/**
 * 兜底关键词抽取（只在模型没按 JSON 输出、或 keywords 为空时使用）。
 *
 * 不引入中文分词库（需求文档 FR-4 明确不要），用的是"重复出现的 2–6 字 CJK 片段"这个廉价启发式。
 * 它**一定会犯错**，所以调用方必须把结果标成 needs_review，让用户确认。
 *
 * 两个参数都是踩过坑才定下来的：
 *  · MAX_GRAM = 6：上限取 4 时，「魔界狩猎场」这种 5 字词**永远抽不出来**——
 *    句子被句号切成了多个 CJK 片段，5 字词根本不在候选集里，只会产出「魔界狩猎」「界狩猎场」
 *    两个互相重叠的 4 字碎片。中文专有名词常有 5–6 字，所以上限必须够。
 *  · 重叠抑制：上面那两个碎片不是彼此的**子串**，光靠"长词覆盖短词"去不掉，
 *    得额外判断"后缀==前缀"式的重叠。
 *
 * @param {string} text
 * @param {{exclude?:string[], max?:number}} opts exclude 通常是主角名/用户名
 * @returns {string[]}
 */
const MAX_GRAM = 6;

/** a 与 b 是否首尾重叠（如「魔界狩猎」与「界狩猎场」） */
function gramsOverlap(a, b) {
    const min = Math.min(a.length, b.length);
    for (let k = min - 1; k >= 2; k--) {
        if (a.slice(-k) === b.slice(0, k) || b.slice(-k) === a.slice(0, k)) return true;
    }
    return false;
}

export function extractKeywordsHeuristic(text, opts = {}) {
    const exclude = (opts.exclude || []).filter(Boolean);
    const max = Number(opts.max) || 6;
    const src = String(text ?? '');
    const counts = new Map();

    for (const run of src.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
        const s = run[0];
        for (let len = 2; len <= MAX_GRAM; len++) {
            for (let i = 0; i + len <= s.length; i++) {
                const gram = s.slice(i, i + len);
                if (ZH_STOPWORDS.has(gram)) continue;
                if (exclude.some(name => name && (gram.includes(name) || name.includes(gram)))) continue;
                counts.set(gram, (counts.get(gram) || 0) + 1);
            }
        }
    }

    const candidates = [...counts.entries()]
        .filter(([, n]) => n >= 2)
        .map(([gram, n]) => ({ gram, n }))
        // 先偏向更长（更具体）的词，同长度按出现次数
        .sort((a, b) => (b.gram.length - a.gram.length) || (b.n - a.n));

    const picked = [];
    for (const c of candidates) {
        if (picked.length >= max) break;
        // 已被更长的词覆盖就跳过（"魔界狩猎场" 命中后不再要 "魔界"）
        if (picked.some(p => p.includes(c.gram) || c.gram.includes(p))) continue;
        // 首尾重叠的碎片也跳过（"界狩猎场" vs "魔界狩猎场" 之外的同类情形）
        if (picked.some(p => gramsOverlap(p, c.gram))) continue;
        picked.push(c.gram);
    }
    return picked;
}

/**
 * 解析模型输出 → 节点字段。永不抛异常。
 *
 * 两种形态都接受：
 *  - JSON（默认提示词要求的）：拿到 title / keywords / summary
 *  - 纯文本（用户把提示词改成不输出 JSON 时）：整段当正文，关键词走兜底抽取
 *
 * @param {string} raw 模型原始输出
 * @param {{exclude?:string[]}} opts
 * @returns {{ok:boolean, format:'json'|'text'|'empty', title:string, tier:string, keywords:string[], summary:string, degraded:boolean}}
 */
export function parseSummaryOutput(raw, opts = {}) {
    const text = stripCodeFence(raw);
    if (!text) {
        return { ok: false, format: 'empty', title: '', tier: 'side', keywords: [], summary: '', degraded: false };
    }

    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a !== -1 && b > a) {
        let obj = null;
        try { obj = JSON.parse(text.slice(a, b + 1)); } catch { obj = null; }
        if (obj && typeof obj === 'object') {
            const summary = String(obj.summary ?? obj.content ?? '').trim();
            const title = String(obj.title ?? '').trim();
            const keywords = Array.isArray(obj.keywords)
                ? obj.keywords.map(String).map(s => s.trim()).filter(Boolean).slice(0, 8)
                : [];
            // tier 由模型建议，但只接受白名单里的值；模型不说就退化成 side（FR-15 的阶梯靠它）
            const rawTier = String(obj.tier ?? '').trim().toLowerCase();
            const tier = ['main', 'side', 'detail'].includes(rawTier) ? rawTier : 'side';
            if (summary || keywords.length) {
                return {
                    ok: !!summary,
                    format: 'json',
                    title: title || firstLineTitle(summary),
                    tier,
                    keywords,
                    summary: summary || text,
                    degraded: false,
                };
            }
        }
    }

    // 退化成纯文本：整段当正文，关键词靠兜底
    const summary = text;
    return {
        ok: true,
        format: 'text',
        title: firstLineTitle(summary),
        tier: 'side',
        keywords: extractKeywordsHeuristic(summary, opts),
        summary,
        degraded: true,
    };
}

/** 从正文里取一个短标题 */
export function firstLineTitle(text) {
    const line = String(text ?? '').split('\n').map(s => s.trim()).find(Boolean) || '';
    const cleaned = line.replace(/^[#*\-\s【\[（(]+/, '').replace(/[】\]）)]$/, '').trim();
    if (!cleaned) return '未命名节点';
    return cleaned.length > 14 ? `${cleaned.slice(0, 14)}…` : cleaned;
}
