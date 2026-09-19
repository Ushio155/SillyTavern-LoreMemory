/**
 * 纯函数：插件私有状态的形状、默认值、归一化与查询
 *
 * 状态挂在 chat_metadata.loreMemory 上 —— 与聊天一一对应，换聊天天然隔离。
 * 本文件不 import 任何 ST 模块，可在 Node 里直接跑回归。
 */

export const STATE_VERSION = 2;
export const STATE_KEY = 'loreMemory';

/** 全新的空状态 */
export function createState(bookName = '') {
    return {
        version: STATE_VERSION,
        bookName,
        skeletonUid: null,
        skeletonAt: 0,        // 上次刷新骨架时的消息数
        cursor: 0,            // 已消化到第几条消息（0 基、开区间上界）
        demo: false,          // 是否已灌入演示剧本
        needsReview: 0,       // 待人工确认的节点数（面板提示用）
        nodes: [],
        ledger: [],           // { turn, injected: [{id,title,tokens,reason}], tokens }
    };
}

/**
 * 把磁盘上读到的（可能是旧版/残缺的）状态补齐成当前形状。
 * 永不抛异常 —— 用户手改过 chat_metadata 也不能让插件崩。
 * @param {any} raw
 * @param {string} bookName 当前应当使用的书名
 * @returns {object} 归一化后的状态
 */
export function normalizeState(raw, bookName = '') {
    const base = createState(bookName);
    if (!raw || typeof raw !== 'object') return base;

    const out = {
        ...base,
        ...raw,
        version: STATE_VERSION,
        nodes: Array.isArray(raw.nodes) ? raw.nodes.filter(isPlainObject).map(normalizeNode) : [],
        ledger: Array.isArray(raw.ledger) ? raw.ledger.filter(isPlainObject).slice(-200) : [],
    };
    // 生成相关的参数（promptInterval / 提示词 / 扫描范围…）自 v2 起统一放在扩展的**全局设置**里，
    // 不再随聊天走；旧版可能存在 raw.settings，这里刻意忽略（不对它做任何读取）。
    delete out.settings;
    // 书名以调用方给的为准（可能因 getFreeWorldName 的 "(1)" 尾巴而变化）
    out.bookName = bookName || raw.bookName || '';
    out.cursor = Number.isFinite(Number(raw.cursor)) ? Math.max(0, Number(raw.cursor)) : 0;
    out.skeletonAt = Number.isFinite(Number(raw.skeletonAt)) ? Math.max(0, Number(raw.skeletonAt)) : 0;
    out.skeletonUid = Number.isInteger(raw.skeletonUid) ? raw.skeletonUid : null;
    out.needsReview = Number(raw.needsReview) || 0;
    out.demo = !!raw.demo;
    return out;
}

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function normalizeNode(n) {
    return {
        id: String(n.id || ''),
        uid: Number.isInteger(n.uid) ? n.uid : null,
        from: Number(n.from) || 0,
        to: Number(n.to) || 0,
        title: String(n.title || '(未命名节点)'),
        keys: Array.isArray(n.keys) ? n.keys.map(String).filter(Boolean) : [],
        content: String(n.content || ''),
        tokens: Number(n.tokens) || 0,
        tier: ['skeleton', 'main', 'side', 'detail'].includes(n.tier) ? n.tier : 'side',
        status: ['pending', 'active', 'disabled', 'needs_review', 'archived'].includes(n.status) ? n.status : 'active',
        hits: Number(n.hits) || 0,
        lastHitAt: Number.isInteger(n.lastHitAt) ? n.lastHitAt : null,
        source: n.source === 'llm' ? 'llm' : 'demo',
        // 被判别力闸门剔掉的关键词（面板要如实显示，不然"我的词去哪了"没法解释）
        droppedKeys: Array.isArray(n.droppedKeys) ? n.droppedKeys.map(String).filter(Boolean) : [],
        // 重摘要前的上一版正文。注意：这里原本没有登记它，所以 index.js 写的 prevContent
        // 每次重载都会被这个白名单丢掉 —— FR-11「可撤销」连数据都没留住。
        prevContent: typeof n.prevContent === 'string' ? n.prevContent : '',
    };
}

/** 生成下一个节点 id：N001 / N002 … */
export function allocNodeId(nodes) {
    let max = 0;
    for (const n of nodes || []) {
        const m = /^N(\d+)$/.exec(String(n && n.id));
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `N${String(max + 1).padStart(3, '0')}`;
}

/** 按 uid 找节点 */
export function nodeByUid(state, uid) {
    return (state.nodes || []).find(n => n.uid === uid) || null;
}

/** 按 id 或标题模糊找节点 */
export function findNode(state, needle) {
    const q = String(needle || '').trim();
    if (!q) return null;
    const nodes = state.nodes || [];
    return nodes.find(n => n.id === q)
        || nodes.find(n => n.id.toLowerCase() === q.toLowerCase())
        || nodes.find(n => n.title.includes(q))
        || null;
}

/** 统计：活跃节点数 / 总节点数 */
export function countActive(state) {
    const nodes = state.nodes || [];
    return nodes.filter(n => n.status === 'active' || n.status === 'disabled' || n.status === 'pending').length;
}

/**
 * 记账：把本回合的注入写入 ledger，并累加节点的命中次数。
 * 同一个 uid 在一回合内只记一次。
 * @param {object} state
 * @param {number} turn
 * @param {Array<{uid:number,title:string,tokens:number,reason:string,id:string}>} items
 */
export function recordTurn(state, turn, items) {
    const seen = new Set();
    const uniq = [];
    for (const it of items || []) {
        const k = `${it.uid}`;
        if (seen.has(k)) continue;
        seen.add(k);
        uniq.push(it);
        const node = nodeByUid(state, it.uid);
        if (node) {
            node.hits = (Number(node.hits) || 0) + 1;
            node.lastHitAt = turn;
        }
    }
    const tokens = uniq.reduce((a, b) => a + (Number(b.tokens) || 0), 0);
    state.ledger = Array.isArray(state.ledger) ? state.ledger : [];
    state.ledger.push({ turn, injected: uniq, tokens });
    if (state.ledger.length > 200) state.ledger = state.ledger.slice(-200);
    return { turn, injected: uniq, tokens };
}

/** 近 N 回合的平均注入 token（用于面板曲线） */
export function avgInjectedTokens(state, n = 20) {
    const led = (state.ledger || []).slice(-n);
    if (!led.length) return 0;
    return Math.round(led.reduce((a, b) => a + (Number(b.tokens) || 0), 0) / led.length);
}

/** Top N 常命中节点 */
export function topHitNodes(state, n = 5) {
    return [...(state.nodes || [])]
        .filter(x => (Number(x.hits) || 0) > 0)
        .sort((a, b) => (b.hits - a.hits))
        .slice(0, n);
}
