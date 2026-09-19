/**
 * 纯函数：节点 → 世界书条目字段补丁
 *
 * 设计纪律（沿用 CardLore 踩过的坑）：
 *  1. 这里只产出「补丁」，不产出完整条目。
 *     真正的条目由 ST 的 createWorldInfoEntry() 从 newWorldInfoEntryTemplate 克隆而来，
 *     补丁再覆盖上去 —— 这样 ST 未来新增字段时会自动继承其默认值，而不是被插件写死一套老默认值。
 *  2. 字段名与取值以 ST 1.18.0 的 newWorldInfoEntryDefinition 为准（见需求文档 §1.2/§2.5）。
 *
 * 本文件不 import 任何 ST 模块。
 */

/** position 枚举（world-info.js L855） */
export const POSITION = {
    before_char: 0,
    after_char: 1,
    ANTop: 2,
    ANBottom: 3,
    atDepth: 4,
    EMTop: 5,
    EMBottom: 6,
    outlet: 7,
};

/** role 枚举（仅 atDepth 生效） */
export const ROLE = { system: 0, user: 1, assistant: 2, instruct: 3 };

/** order 阶梯：越大越先吃预算（sortFn 是降序） */
export const TIER_ORDER = { skeleton: 900, main: 500, side: 300, detail: 100 };
export const TIER_LABEL = { skeleton: '骨架', main: '主线', side: '支线', detail: '细节' };

/**
 * 允许的生成类型触发器（constants.js L36–43）。
 * 记忆条目一律排除 'quiet' —— 否则插件自己的摘要请求又会触发世界书，白花一笔。
 */
export const TRIGGERS_NO_QUIET = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate'];

/**
 * 节点条目的字段补丁。
 * @param {object} node { title, keys, content, tier, status, from, to, id }
 * @param {object} settings 插件设置
 * @returns {object} 待覆盖到条目上的字段
 */
export function nodeEntryPatch(node, settings = {}) {
    const sticky = numOrNull(settings.sticky, 4);
    const cooldown = numOrNull(settings.cooldown, 16);
    const hot = node.hot === true;

    return {
        // 编辑器里的人类可读名 —— 人工审计的唯一入口
        comment: commentFor(node),
        addMemo: true,
        // 主关键词：命中即候选
        key: Array.isArray(node.keys) ? node.keys.map(String).filter(Boolean) : [],
        keysecondary: [],
        selective: true,
        selectiveLogic: 0,
        content: String(node.content || ''),
        constant: false,
        disable: node.status === 'disabled' || node.status === 'archived' || node.status === 'needs_review',
        // 优先级阶梯：骨架 900 / 主线 500 / 支线 300 / 细节 100
        order: TIER_ORDER[node.tier] ?? TIER_ORDER.side,
        position: POSITION.before_char,
        depth: 4,
        role: ROLE.system,
        // 节流：命中后保持几楼，之后冷却几楼不重复注入
        sticky,
        cooldown,
        delay: null,
        // 递归一律关闭，防级联注入把预算冲爆
        excludeRecursion: true,
        preventRecursion: true,
        delayUntilRecursion: 0,
        // 概率不用于节流（我们设 100，节流交给 sticky/cooldown）
        probability: 100,
        useProbability: true,
        // 中文无空格：整词匹配会让命中率暴跌
        caseSensitive: null,
        matchWholeWords: null,
        // 条目级扫描深度：高频人物节点可调高（不动全局设置）
        scanDepth: hot ? numOrNull(settings.scanDepthHot, 8) : null,
        group: groupFor(node),
        groupWeight: 100,
        groupOverride: false,
        useGroupScoring: null,
        ignoreBudget: false,
        vectorized: false,
        // 关键：排除 quiet，摘要请求自身不再触发世界书
        triggers: [...TRIGGERS_NO_QUIET],
        automationId: '',
        outletName: '',
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario: false,
        matchCreatorNotes: false,
        matchPersonaDescription: false,
    };
}

/**
 * 骨架条目（"现状卡"）的字段补丁。
 * 全书唯一一条 constant:true，落在 atDepth 位置 —— 离当前最近，模型最重视。
 * @param {object} settings
 * @param {number} revision 第几版，用于 comment
 */
export function skeletonEntryPatch(settings = {}, revision = 1) {
    return {
        comment: `骨架 · 现状卡 v${revision}`,
        addMemo: true,
        key: [],
        keysecondary: [],
        selective: true,
        selectiveLogic: 0,
        content: '',
        constant: true,
        disable: false,
        order: TIER_ORDER.skeleton,
        position: POSITION.atDepth,
        depth: 4,
        role: ROLE.system,
        sticky: null,
        cooldown: null,
        delay: null,
        excludeRecursion: true,
        preventRecursion: true,
        delayUntilRecursion: 0,
        probability: 100,
        useProbability: true,
        caseSensitive: null,
        matchWholeWords: null,
        scanDepth: null,
        group: '',
        groupWeight: 100,
        groupOverride: false,
        useGroupScoring: null,
        ignoreBudget: false,
        vectorized: false,
        triggers: [...TRIGGERS_NO_QUIET],
        automationId: '',
        outletName: '',
    };
}

/** 人类可读的条目名：N003 · 41-55楼 · 魔界狩猎场初战 */
export function commentFor(node) {
    const id = node.id || 'N???';
    const range = (Number.isFinite(node.from) && Number.isFinite(node.to)) ? `${node.from}-${node.to}楼` : '';
    const title = String(node.title || '').trim();
    return [id, range, title].filter(Boolean).join(' · ');
}

/**
 * 同一 arc 的节点归组，避免一次注入好几条同段内容。
 *
 * ⚠️ 实测结论（ST 1.18.0）：inclusion group 是**组内竞争、赢家通吃** ——
 * `filterByInclusionGroups()` 在组内按评分排序后只保留一条，其余直接出局。
 * 演示默认**关闭分组**：只有 5 条节点时，分组会让"提到了 A 却注入了同组的 B"这种
 * 反直觉结果出现（本插件第一次端到端跑通时就踩到了：提到「魔界」注入的却是 N004）。
 * 需求文档 §2.5 建议按 arc 归组，那是节点多到需要抢预算时的策略，故保留开关、默认关。
 */
function groupFor(node) {
    return node.groupWithArc && node.arc ? `arc:${node.arc}` : '';
}

function numOrNull(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 判定一条被激活的条目「为什么被注入」。
 * 优先级：constant > forced > sticky > key
 * @param {object} entry 世界书条目
 * @param {{forcedUids?:Set<number>, timed?:object}} ctx
 * @returns {'constant'|'forced'|'sticky'|'key'}
 */
export function inferReason(entry, ctx = {}) {
    if (entry && entry.constant) return 'constant';
    const uid = entry && entry.uid;
    if (ctx.forcedUids && ctx.forcedUids.has(uid)) return 'forced';
    const timed = ctx.timed && uid !== undefined ? ctx.timed[uid] : null;
    if (timed && Number(timed.sticky) > 0) return 'sticky';
    return 'key';
}

export const REASON_LABEL = {
    constant: '常驻',
    forced: '钉选',
    sticky: '粘滞延续',
    key: '关键词命中',
};
