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

// ───────────────────────── 角色索引与实体召回（按需触发的那一半） ─────────────────────────

/**
 * 为什么需要这一层（2026-09-19，用真实闸门函数实测出来的）：
 *
 * 关键词判别力闸门（`seed.js` 的 `dropIndiscriminativeKeys`）拿**出现频率**当证据，
 * 而频率对两类词的含义正好**相反**：对「敏感度」这种每回合都吐的机制词，高频是噪声的证据；
 * 对一个反复出场的配角，高频恰恰是"这是核心人物"的证据。同一个判据对它们给出同一个判决 ——
 *   配角每 2 楼露一次面（60 楼）  → 总出现 30/60，区间外 28 → 剔除(omnipresent)
 *   机制词「敏感度」每 2 楼        → 总出现 30/60，区间外 28 → 剔除(omnipresent)
 * 于是"多配角轮换"的聊天里，配角名既不会被模型写进关键词（提示词要求"只在这段剧情里出现"），
 * 写进去了也会被闸门剔掉；之后无论怎么提到这个配角，他的旧记忆都召不回来 ——
 * `/lm-recall 缇娜` 也救不了，因为它只是把词塞进扫描缓冲，**前提是某个条目的 key 里还有这个词**。
 *
 * 这里给的不是"放宽闸门"（那等于把噪声词一起放进来），而是**换一条召回通道**：
 * 不看 key，只看**正文里提到了谁** —— 由用户点一下面板上的角色 chip、或打一条
 * `/lm-recall 人名` 触发。代价当场可见（注入几条、约多少 token），且完全不依赖模型配合。
 */

/**
 * 「谁在场」那一行的标签有两种写法，因为它们是**两份不同的默认提示词**产出的：
 *  · 节点：`【谁在场】{{user}}、林晚、独眼（左眼覆铁片）` —— 方括号后面**没有冒号**
 *  · 骨架：`在场：林晚、缇娜` —— 有冒号
 * 所以不能共用一个「标签 + 冒号」的正则。
 */
const CAST_BRACKETED = /【\s*(?:谁在场|在场人物|在场)\s*】\s*([^\n【]*)/;
const CAST_PLAIN = /^[^\S\n]*[>#*•●\-–—]*[^\S\n]*(?:谁在场|在场人物|在场)[^\S\n]*[：:][^\S\n]*([^\n]*)/m;

/** 取出「谁在场」那一行的正文（取不到就返回空串） */
export function castLineOf(content) {
    const text = String(content ?? '');
    const m = CAST_BRACKETED.exec(text) || CAST_PLAIN.exec(text);
    return m ? String(m[1]).trim() : '';
}

/**
 * 把一个「谁在场」行拆成名字。
 * 过滤规则都是演示数据/真实数据里真出现过的噪声，不是凭空加的：
 *  · `{{user}}` / `{{char}}` 占位符（演示数据就是这么写的）
 *  · 括号里的注解 —— `独眼（左眼覆铁片）` 要变成 `独眼`，否则按名字查正文查不到
 *  · 单字名（中文里单字误命中率太高，与 checkKeys 的判据一致）
 *  · 超长串（`驿站老板老周` 这种带描述的写法仍然保留，但 12 字以上的多半是整句话）
 */
export function splitCastNames(raw) {
    const out = [];
    for (const part of String(raw ?? '').split(/[、,，;；\/|]+/)) {
        const name = part
            .replace(/[（(][^）)]*[）)]/g, '')          // 去掉别名注解
            .replace(/^[\s>#*•●\-–—]+/, '')
            .replace(/[\s。；;，,、]+$/, '')
            .trim();
        if (!name) continue;
        if (name.includes('{{')) continue;             // {{user}} / {{char}}
        const len = [...name].length;
        if (len < 2 || len > 12) continue;
        if (out.includes(name)) continue;
        out.push(name);
    }
    return out;
}

/** 一个节点「谁在场」里写到的名字 */
export function nodeCastNames(node) {
    return splitCastNames(castLineOf(node && node.content));
}

/**
 * 能参与召回的节点：排除骨架（它本来就常驻注入，不用召）与已归档的。
 * 待确认（needs_review）节点**保留在候选里** —— 它们恰恰是最需要被按角色捞回来的
 * （关键词被剔光才会待确认），能不能真注入由 `recallTargets` 分组说明。
 */
function recallableNodes(state) {
    const skel = state ? state.skeletonUid : null;
    return ((state && state.nodes) || [])
        .filter(n => n && n.status !== 'archived')
        .filter(n => !(Number.isInteger(skel) && n.uid === skel));
}

/** 正文是否提到这个词（大小写不敏感；与 ST 的扫描一样是"子串包含"） */
function mentions(node, term) {
    return String((node && node.content) || '').toLowerCase().includes(term);
}

/**
 * 全聊天的角色索引：名字 → **有多少个节点提到它**（正文出现即算，不只看在场行）。
 *
 * 名字只从「谁在场」行里收 —— 这个来源自带语义，天然把「敏感度」这类机制词挡在外面
 * （它们不会出现在谁在场里）。权重用"提到它的节点数"而不是"它在场行里出现几次"，
 * 因为用户要的是"点一下能捞出多少记忆"。
 *
 * `uids` 是这些节点的 uid，面板用它判断"这一枚 chip 是不是正挂着"（命中即整组召回，
 * 所以按角色召回的状态是**整组**的：组里还有一条没交付，chip 就还是亮的）。
 *
 * `last` 是"最后出现在第几楼"（取命中节点区间的末端）—— 输入框上方那条召回条用它排"最近出场"，
 * 见 `rankCast`。没有楼层号的老数据退回节点序号，保证它永远是正数（0 会被当成"没出现过"）。
 */
export function castIndex(state) {
    const nodes = recallableNodes(state);
    const names = new Set();
    for (const n of nodes) for (const name of nodeCastNames(n)) names.add(name);
    const floorOf = new Map(nodes.map((n, i) => {
        const to = Number(n && n.to);
        return [n, Number.isFinite(to) && to > 0 ? to : i + 1];
    }));
    const out = [];
    for (const name of names) {
        const needle = name.toLowerCase();
        const hits = nodes.filter(n => mentions(n, needle));
        if (hits.length > 0) {
            out.push({
                name,
                count: hits.length,
                uids: hits.map(n => n.uid).filter(Number.isInteger),
                last: hits.reduce((mx, n) => Math.max(mx, floorOf.get(n) || 0), 0),
            });
        }
    }
    // 排序不用 localeCompare：断言要跨环境稳定（Node 与无头 Edge 的排序规则未必一致）
    return out.sort((a, b) => (b.count - a.count) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * 输入框上方那条召回条的排序：**名字比位置稀缺**。
 *
 * 一条 bar 在桌面也就放得下 8~10 个名字，而长聊里出场过的名字可以到几十个 ——
 * 所以"哪些名字占据可见的那几个位置"本身就是这个功能好不好用的全部。
 * 光按"提到它的节点数"排会踩到用户报的那个坑：**你反复要召回的配角被挤进「+N」**，
 * 于是每次都得点开弹窗找一遍。这里按"你现在最可能想召回谁"排：
 *
 *   0 召回中    —— 已经挂着的必须可见（否则没法再点一次取消）
 *   1 正在输入  —— 输入框里正在打的名字：命中即置顶，打完字它就在那儿了
 *   2 刚召回    —— 本次会话里你最近点过的（MRU）：点过一次，下次就跳到前排
 *   3 最近出场  —— 最近几条消息里出现过的（含**还没总结**的尾部），按最后出现的楼层倒序
 *   4 其余      —— 最近被总结进节点（last 大）优先，并列时节点多的优先
 *
 * 前三条是"意图信号"，第四条是"戏份信号"。每一条都带 `why` 标签，界面把它写进 tooltip／
 * 弹窗行里 —— 排序依据必须看得见，否则就成了用户猜不透的"智能"。
 *
 * @param {Array<{name:string,count?:number,uids?:number[],last?:number}>} cast castIndex 的输出
 * @param {{pinnedUids?:Set<number>|number[], typed?:string, recentText?:string, mru?:string[]}} signals
 * @returns {Array<{name:string,count:number,uids:number[],last:number,on:boolean,why:string}>}
 */
export function rankCast(cast, signals = {}) {
    const pinned = signals.pinnedUids instanceof Set ? signals.pinnedUids : new Set(signals.pinnedUids || []);
    const typed = String(signals.typed || '').toLowerCase();
    const recent = String(signals.recentText || '').toLowerCase();
    const mruAt = new Map();
    (Array.isArray(signals.mru) ? signals.mru : []).forEach((n, i) => {
        const k = String(n || '').toLowerCase();
        if (k && !mruAt.has(k)) mruAt.set(k, i);
    });

    const rows = (Array.isArray(cast) ? cast : []).map(c => {
        const name = String(c.name || '');
        const nameL = name.toLowerCase();
        const uids = Array.isArray(c.uids) ? c.uids : [];
        const on = uids.length > 0 && uids.every(u => pinned.has(u));
        let why;
        if (on) why = '召回中';
        else if (typed && typed.includes(nameL)) why = '正在输入';
        else if (mruAt.has(nameL)) why = '刚召回';
        else if (recent && recent.includes(nameL)) why = '最近出场';
        else if (Number(c.last) > 0) why = '最近总结';
        else why = '节点最多';
        return { name, count: Number(c.count) || 0, uids, last: Number(c.last) || 0, on, why };
    });

    const tier = (r) => r.on ? 0 : r.why === '正在输入' ? 1 : r.why === '刚召回' ? 2 : r.why === '最近出场' ? 3 : 4;
    return rows.sort((a, b) => {
        const ta = tier(a), tb = tier(b);
        if (ta !== tb) return ta - tb;
        if (ta === 2) return mruAt.get(a.name.toLowerCase()) - mruAt.get(b.name.toLowerCase());
        return (b.last - a.last) || (b.count - a.count) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    });
}

/**
 * 实体召回的候选，按「能不能真注入」分成两组。
 *
 * 分组不是保守估计，是**宿主行为**逼出来的：被外部强制激活的条目仍然要在
 * `world-info.js` L4689 过 `entry.disable == true` 检查，而那个检查在 L4774 的
 * `getExternallyActivated()`**之前** —— 书里被禁用的条目根本走不到强制注入那一支。
 * 本插件把「待确认 / 已禁用 / 已归档」都写成 `disable: true`，所以它们拉不进来，
 * 必须如实告诉用户"先去改关键词恢复"，不能假装注入成功。
 *
 * @param {object} state
 * @param {string} term 角色名（或任何词）
 * @returns {{term:string, injectable:object[], blocked:object[]}}
 */
export function recallTargets(state, term) {
    const q = String(term ?? '').trim();
    const injectable = [];
    const blocked = [];
    if (!q) return { term: q, injectable, blocked };
    const needle = q.toLowerCase();
    for (const n of recallableNodes(state)) {
        if (!mentions(n, needle)) continue;
        if (n.status === 'disabled' || n.status === 'needs_review' || n.status === 'pending') blocked.push(n);
        else injectable.push(n);
    }
    return { term: q, injectable, blocked };
}

/**
 * 哪些节点的**关键词**会被"把 term 塞进扫描缓冲"这一招命中。
 *
 * 判据必须用 `term.includes(key)` 而不是反过来：ST 的命中条件是
 * "扫描文本包含 key"（`world-info.js` L4793 起），而我们塞进缓冲的正是 term 本身。
 * 反向写会把 `精灵向导缇娜` 误判成"能被「缇娜」命中"。
 */
export function keysMatching(state, term) {
    const q = String(term ?? '').trim().toLowerCase();
    if (!q) return [];
    return recallableNodes(state).filter(n =>
        n.status !== 'disabled' && n.status !== 'needs_review' && n.status !== 'pending'
        && (n.keys || []).some(k => q.includes(String(k).toLowerCase())));
}
