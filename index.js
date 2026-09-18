/**
 * LoreMemory（演示版）—— 世界书关键词触发式长期记忆插件
 * SillyTavern 1.18.0 第三方扩展入口
 *
 * 设计要点（与需求文档 §1、§3 对应）：
 *  - 插件**不实现**自己的检索/扫描/注入/预算算法，那是 ST 的活。我们只做两件事：
 *      ① 内容生产线：把聊天历史切成节点 → LLM 摘要 → 写成聊天世界书条目
 *      ② 仪表盘：读 ST 的扫描结果（WORLDINFO_SCAN_DONE）做账本
 *  - 记忆条目一律写进 **chat lore**（chat_metadata['world_info']），
 *    好处：每聊天独立、排序最靠前、换聊天自动隔离、不污染角色卡。
 *  - 生成参数（每 N 条总结、扫描范围、提示词…）存**全局** `extension_settings.LoreMemory`，
 *    与 ST 自带 memory 扩展一致；每聊天独有的（书、游标、节点、账本）存 chat_metadata。
 *  - 所有 ST 相对路径 import 集中在本文件 —— 目录深度换算只写一次，避免 src/ 里的层级陷阱。
 */

import {
    chat_metadata,
    saveMetadata,
    generateQuietPrompt,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    saveSettingsDebounced,
} from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../events.js';
import {
    createWorldInfoEntry,
    getFreeWorldName,
    loadWorldInfo,
    saveWorldInfo,
    updateWorldInfoList,
    METADATA_KEY,
    world_info_depth,
    world_info_min_activations,
    world_info_min_activations_depth_max,
    world_info_budget,
    world_info_budget_cap,
} from '../../../world-info.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';

import { estimateTokens } from './src/tokens.js';
import { enforceSkeleton, SKELETON_FIELDS } from './src/guard.js';
import {
    STATE_KEY,
    normalizeState,
    allocNodeId,
    findNode,
    nodeByUid,
    recordTurn,
} from './src/store.js';
import { nodeEntryPatch, skeletonEntryPatch, inferReason, TIER_ORDER, TIER_LABEL } from './src/entry.js';
import { DEMO_NODES, DEMO_SKELETON, checkKeys, dropIndiscriminativeKeys } from './src/seed.js';
import {
    normalizeSettings,
    DEFAULT_PROMPT,
    DEFAULT_SKELETON_PROMPT,
    DEFAULT_PROMPT_VERSION,
    renderPrompt,
    buildTranscript,
    pendingCount,
    shouldSummarize,
    shouldRefreshSkeleton,
    parseSummaryOutput,
    extractKeywordsHeuristic,
} from './src/settings.js';
import { renderPanel, escapeHtml } from './src/ui.js';
import { isRealChatContext, noChatReason } from './src/context.js';

const MODULE_NAME = 'LoreMemory';
const RECALL_KEY = 'LoreMemory_recall';
const PANEL_ID = 'lm_panel_root';

/** 骨架刷新时最多回看多少条消息（避免骨架提示词爆上下文） */
const SKELETON_LOOKBACK = 40;

/** 我们的聊天世界书统一用这个前缀命名（「清理空书」也靠它识别） */
const BOOK_PREFIX = 'LM-';

// ───────────────────────── 模块级瞬时状态（不进存档） ─────────────────────────

/** 正在跑 quiet 摘要：此期间的世界书扫描不记账（否则插件自己的请求会把账本刷成空） */
let summarizing = false;
/** 本回合被手动钉选的 uid，仅用于账本里标注"钉选" */
const forcedUids = new Set();
/** 本回合是否有 /lm-recall 塞过关键词，扫描后清掉 */
let recallActive = false;
/** 书是否已确认存在于磁盘 */
let bookReady = false;
/** 已经就"这个聊天绑了别人的书"提醒过一次，别刷屏 */
let foreignBookWarned = false;
/** 自动总结的延时句柄（避免用户还在打字时就抢 API） */
let autoTimer = null;

// ───────────────────────── 设置（全局） ─────────────────────────

function getSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = {};
    }
    const holder = extension_settings[MODULE_NAME];
    holder.settings = normalizeSettings(holder.settings);
    return holder.settings;
}

/**
 * 改一个设置并落盘。数值会被 normalizeSettings 夹到合法区间。
 * @param {string} key
 * @param {any} value
 */
function updateSetting(key, value) {
    const holder = extension_settings[MODULE_NAME] || (extension_settings[MODULE_NAME] = {});
    const patch = { ...getSettings(), [key]: value };
    // 用户手动改过提示词 ⇒ 把版本号顶到当前，避免被"默认提示词升级"误覆盖
    if (key === 'prompt' || key === 'skeletonPrompt') patch.promptVersion = DEFAULT_PROMPT_VERSION;
    holder.settings = normalizeSettings(patch);
    saveSettingsDebounced();
    return holder.settings;
}

function restoreDefaultPrompt() {
    const holder = extension_settings[MODULE_NAME] || (extension_settings[MODULE_NAME] = {});
    holder.settings = { ...getSettings(), prompt: DEFAULT_PROMPT, promptVersion: DEFAULT_PROMPT_VERSION };
    saveSettingsDebounced();
    return holder.settings;
}

function restoreDefaultSkeletonPrompt() {
    const holder = extension_settings[MODULE_NAME] || (extension_settings[MODULE_NAME] = {});
    holder.settings = { ...getSettings(), skeletonPrompt: DEFAULT_SKELETON_PROMPT, promptVersion: DEFAULT_PROMPT_VERSION };
    saveSettingsDebounced();
    return holder.settings;
}

// ───────────────────────── 面板展开状态（跨重绘保留） ─────────────────────────

/**
 * 面板每次状态变化都整块重绘。ST 的折叠逻辑是直接改 DOM 的，
 * 所以展开状态必须由我们自己记住，否则用户刚展开的区块会被下一次扫描结果关上。
 */
function getDrawerState() {
    const holder = extension_settings[MODULE_NAME] || (extension_settings[MODULE_NAME] = {});
    if (!holder.ui || typeof holder.ui !== 'object') holder.ui = { drawers: {} };
    if (!holder.ui.drawers || typeof holder.ui.drawers !== 'object') holder.ui.drawers = {};
    return holder.ui.drawers;
}

function setDrawerState(key, open) {
    const drawers = getDrawerState();
    drawers[key] = !!open;
    saveSettingsDebounced();
}

// ───────────────────────── 状态读写 ─────────────────────────

function getCtx() {
    return getContext();
}

function getState() {
    const cm = getCtx().chatMetadata;
    if (!cm) return null;
    const bound = cm[METADATA_KEY] || '';
    cm[STATE_KEY] = normalizeState(cm[STATE_KEY], bound);
    const state = cm[STATE_KEY];

    // 游标是"已消化到第几条消息"。如果它跑到聊天长度前面（删了消息、截断了历史、换了更短的聊天，
    // 或者演示数据把游标设得很靠后），pendingCount 会恒为 0 —— 自动总结就**永远不再触发**，
    // 表现为"插件突然不干活了"。这里夹回来。
    // 注意 len === 0 时不动手：切换聊天的瞬间 chat 可能暂时是空的，那时夹回 0 会导致整段重摘要。
    const len = chatMessages().length;
    if (len > 0 && state.cursor > len) {
        console.warn(`[LoreMemory] 游标 ${state.cursor} 超过聊天长度 ${len}，已夹回（历史被删或被截断？）`);
        state.cursor = len;
    }
    return state;
}

function persist() {
    Promise.resolve()
        .then(() => saveMetadata())
        .catch(e => console.warn('[LoreMemory] 保存 chat_metadata 失败', e));
}

function chatMessages() {
    const chat = getCtx().chat;
    return Array.isArray(chat) ? chat : [];
}

// ───────────────────────── 书管理（FR-1） ─────────────────────────

async function bookExistsOnDisk(name) {
    if (!name) return false;
    try {
        return !!(await loadWorldInfo(name));
    } catch {
        return false;
    }
}

/**
 * 确保当前聊天有一本属于我们的聊天世界书，并绑定 chat_metadata['world_info']。
 *
 * 两种调用语境：
 *  - 用户显式点按钮（interactive=true）：遇到"聊天已绑了别人的书"会弹确认，允许改绑。
 *  - 自动模式（interactive=false）：**绝不**静默改绑别人的书，只提醒一次。
 */
async function ensureBook({ interactive = true } = {}) {
    const ctx = getCtx();
    const cm = ctx.chatMetadata;
    if (!cm) return { ok: false, reason: '还没有打开任何聊天' };

    // ① 先确认"真的在一个聊天里"。
    //    注意这道闸必须放在"消息条数"前面：ST 的欢迎屏会往 chat 里塞一条助手问候语，
    //    让它看起来像有内容的聊天，但那个上下文没有 chatId、没有角色，
    //    绑定进去的书永远不会落盘 —— 每次刷新都会重来一遍，攒出一堆空书。
    //    详见 src/context.js 的注释。
    if (!isRealChatContext(ctx)) {
        return { ok: false, reason: noChatReason(ctx), noChat: true };
    }

    if (!chatMessages().length) {
        return { ok: false, reason: '当前聊天是空的：请先发一条消息（插件用楼号做节点区间）' };
    }

    const state = getState();
    const bound = cm[METADATA_KEY] || '';

    // ① 已经绑定的就是我们的书
    if (bound && state.bookName === bound && await bookExistsOnDisk(bound)) {
        bookReady = true;
        return { ok: true, bookName: bound, state };
    }

    // ② 书还在磁盘上，只是绑定丢了（换设备 / 手改过 metadata）
    if (state.bookName && await bookExistsOnDisk(state.bookName)) {
        cm[METADATA_KEY] = state.bookName;
        persist();
        bookReady = true;
        return { ok: true, bookName: state.bookName, state, recovered: true };
    }

    // ③ 聊天已绑了一本别人的书 —— 聊天书只有一个槽位，继续就等于换绑
    if (bound) {
        if (!interactive) {
            // 自动模式不抢别人的书，只提醒一次
            if (!foreignBookWarned) {
                foreignBookWarned = true;
                toast(`这个聊天已绑定世界书「${bound}」，自动记忆不会去抢它。请在面板里点「启用记忆」手动确认改绑。`, 'warning');
            }
            return { ok: false, reason: `聊天已绑定别人的世界书：${bound}` };
        }
        const ok = window.confirm(
            `这个聊天已经绑定了一本世界书：\n「${bound}」\n\n` +
            'LoreMemory 只能把记忆写进「聊天世界书」这一个槽位，继续会把绑定换成一本新书。\n' +
            '原书不会被删除，随时可以在 ST 的世界书面板换回来。\n\n确定继续吗？');
        if (!ok) return { ok: false, reason: '已取消（未改绑）' };
    }

    // ④ 新建
    const chatIdPart = String(ctx.chatId || '').slice(0, 8) || 'nocid';
    const charName = ctx.name2 || ctx.characters?.[ctx.characterId]?.name || 'chat';
    const base = `${BOOK_PREFIX}${charName}-${chatIdPart}`;
    const name = getFreeWorldName(base);
    await saveWorldInfo(name, { entries: {} }, true);
    await updateWorldInfoList();

    cm[METADATA_KEY] = name;
    state.bookName = name;
    if (bound && bound !== name) state.takenOverFrom = bound;
    persist();

    bookReady = true;
    return { ok: true, bookName: name, state, created: true };
}

/** 把条目字段补丁写到世界里并落盘 */
async function saveEntry(state, uid, patch, content) {
    const data = await loadWorldInfo(state.bookName);
    if (!data) throw new Error(`世界书不存在：${state.bookName}`);
    data.entries = data.entries || {};
    let entry = Number.isInteger(uid) ? data.entries[uid] : null;
    if (!entry) {
        entry = createWorldInfoEntry(state.bookName, data);
        if (!entry) throw new Error('无法分配条目 uid');
    }
    Object.assign(entry, patch);
    entry.content = content;
    await saveWorldInfo(state.bookName, data, true);
    await updateWorldInfoList();
    return entry.uid;
}

/** 节点 → 世界书条目（复用 uid，重跑只改 content，不重建书） */
async function writeNode(state, node) {
    const settings = getSettings();
    const content = String(node.content || '');
    const uid = await saveEntry(state, node.uid, nodeEntryPatch(node, settings), content);
    node.uid = uid;
    node.tokens = estimateTokens(content);
    return uid;
}

/** 骨架条目（全书唯一 constant:true） */
async function writeSkeleton(state, content) {
    const settings = getSettings();
    const revision = (Number(state.skeletonRevision) || 0) + 1;
    state.skeletonRevision = revision;
    const uid = await saveEntry(state, state.skeletonUid, skeletonEntryPatch(settings, revision), content);
    state.skeletonUid = uid;
    state.skeletonAt = chatMessages().length;
    return uid;
}

/**
 * 只重写骨架条目的字段与内容，**不推进** revision / skeletonAt。
 *
 * 为什么单独一个函数：「禁用 / 启用」不是一次"刷新"，不该改写 v3→v4，也不该重置
 * 「距上次刷新多少楼」。但**必须**用 skeletonEntryPatch —— 走 writeNode 那条路会用
 * 节点补丁把骨架降级（constant:false / position:before_char / 空关键词），
 * 结果就是面板显示"已启用"、实际永远注入不了（真实案例里踩到过）。
 */
async function writeSkeletonEntryOnly(state, node) {
    const settings = getSettings();
    const revision = Number(state.skeletonRevision) || 1;
    const patch = {
        ...skeletonEntryPatch(settings, revision),
        disable: node.status === 'disabled',
    };
    const content = String(node.content || '');
    const uid = await saveEntry(state, node.uid ?? state.skeletonUid, patch, content);
    node.uid = uid;
    state.skeletonUid = uid;
    node.tokens = estimateTokens(content);
    return uid;
}

/** 骨架在节点列表里的展示记录 */
function upsertSkeletonRecord(state, content, status = 'active') {
    const tokens = estimateTokens(content);
    let rec = state.nodes.find(n => n.id === 'SKEL');
    if (!rec) {
        rec = {
            id: 'SKEL', uid: state.skeletonUid, from: 0, to: 0, title: '现状卡（骨架）',
            keys: [], content, tokens, tier: 'skeleton', status: 'active',
            hits: 0, lastHitAt: null, source: 'demo',
        };
        state.nodes.unshift(rec);
    } else {
        rec.content = content;
        rec.tokens = tokens;
        rec.uid = state.skeletonUid;
        // 状态不再无条件写 active：手动禁用过的骨架不该被下一次自动刷新悄悄复活（F11）
        rec.status = status;
    }
}

// ───────────────────────── LLM 摘要（FR-2/3/4） ─────────────────────────

/** 取「本次要总结」的区间（0 基、闭区间） */
function pendingRange(state) {
    const chat = chatMessages();
    const from = Math.max(0, Number(state.cursor) || 0);
    const to = chat.length - 1;
    return { from, to, empty: to < from };
}

/** 把一段区间按当前设置拼成转录文本 */
function transcriptFor(from, to, settings) {
    const chat = chatMessages();
    const slice = chat.slice(from, to + 1);
    return buildTranscript(slice, {
        scope: settings.scanScope,
        includeSpeakerNames: settings.includeSpeakerNames,
        startIndex: from,
    });
}

/** 组装提示词变量 */
function promptVars(text, count, from, to) {
    const ctx = getCtx();
    return {
        messages: text,
        words: getSettings().promptWords,
        skeletonWords: getSettings().skeletonWords,
        count,
        from: from + 1,
        to: to + 1,
        char: ctx.name2 || '',
        user: ctx.name1 || '',
        previous: '',
    };
}

/** 调一次 quiet 生成。返回模型原始文本；失败抛异常。 */
async function callLlm(prompt) {
    const settings = getSettings();
    summarizing = true;
    try {
        const raw = await generateQuietPrompt({
            quietPrompt: prompt,
            skipWIAN: !!settings.skipWIAN,
            removeReasoning: true,
        });
        return String(raw ?? '');
    } finally {
        summarizing = false;
    }
}

/**
 * 组装「总结未总结的那一段」要发给模型的提示词。
 *
 * 刻意把"拼提示词"和"调模型"拆开：
 *  - 拼提示词是纯计算（读设置 + 读聊天 + 替换占位符），可以单独测、单独查；
 *  - 调模型是唯一有网络副作用的一步。
 * 分开之后，"扫描范围到底筛掉了什么""{{words}} 有没有被替换"这类问题都能直接断言，
 * 不必等到真的调通 API 才能发现。
 *
 * @returns {{ok:true, prompt:string, used:number, skipped:number, from:number, to:number}
 *          |{ok:false, reason:string, used:number, skipped:number}}
 */
function buildNodePrompt(from, to) {
    const settings = getSettings();
    const { text, used, skipped } = transcriptFor(from, to, settings);
    if (!used) return { ok: false, reason: 'all-filtered', used, skipped };
    const prompt = renderPrompt(settings.prompt, promptVars(text, used, from, to));
    return { ok: true, prompt, used, skipped, from, to };
}

/**
 * 关键词闸门 = 结构自检（`checkKeys`）+ **判别力自检**（`dropIndiscriminativeKeys`）。
 *
 * 判别力那一层用的是**本条聊天的真实消息** —— 这是提示词永远做不到的：
 * 模型不可能知道一个词在整条聊天里的出现率。真实案例里被它拦下的正是
 * 「敏感度」(54%) 和「淫乱度」(49%)，而其余 12 个关键词一个没动。
 *
 * @param {string[]} rawKeys 模型给的关键词
 * @param {number} from 1 基起始楼号
 * @param {number} to 1 基结束楼号
 */
function gateKeys(rawKeys, from, to) {
    const keys = (rawKeys || []).slice(0, 8);
    const structural = checkKeys(keys);
    const disc = dropIndiscriminativeKeys(keys, chatMessages(), { from, to });
    return {
        keys: disc.keep,
        dropped: disc.dropped,
        structuralWarn: structural.messages,
        structuralOk: structural.level !== 'warn',
    };
}

/**
 * 把模型输出落成一个节点（写世界书 + 推进游标 + 刷新面板）。
 * 与"调模型"解耦，因此可以用任意模型输出直接驱动，验证解析/降级/落库全链路。
 *
 * @param {string} raw 模型原始输出
 * @param {number} from 0 基起始下标（含）
 * @param {number} to 0 基结束下标（含）
 */
async function applyNodeOutput(raw, from, to) {
    const ctx = getCtx();
    const parsed = parseSummaryOutput(raw, { exclude: [ctx.name1, ctx.name2].filter(Boolean) });
    if (!parsed.ok) return { ok: false, reason: 'empty-output' };

    // 关键词闸门：结构自检 + 判别力自检（对应 FR-14）
    const g = gateKeys(parsed.keywords, from + 1, to + 1);
    const degraded = parsed.degraded || !parsed.keywords.length;
    // 关键词被剔光 = 这个节点永远不会被召回 → 交给人工确认（面板里的「改关键词」）
    const review = degraded || !g.structuralOk || g.keys.length === 0;

    const state = getState();
    const node = {
        id: allocNodeId(state.nodes.filter(n => n.id !== 'SKEL')),
        uid: null,
        from: from + 1,
        to: to + 1,
        title: parsed.title,
        keys: g.keys,
        droppedKeys: g.dropped.map(d => d.key),
        content: parsed.summary,
        tokens: 0,
        // tier 决定 order 阶梯（main 500 / side 300 / detail 100）。以前这里硬编码 'side'，
        // 于是 FR-15 的"分层召回"对节点从未生效 —— 所有节点同权，预算紧张时谁被挤掉是随机的。
        tier: parsed.tier,
        status: review ? 'needs_review' : 'active',
        hits: 0,
        lastHitAt: null,
        source: 'llm',
    };

    state.nodes.push(node);
    await writeNode(state, node);
    state.cursor = Math.max(Number(state.cursor) || 0, to + 1);
    recountReview(state);
    persist();
    render();

    const why = !parsed.keywords.length
        ? '关键词为空（提示词可能没有按要求输出 JSON）'
        : (degraded ? '模型没有按 JSON 输出，已按纯文本处理并用兜底规则抽词'
            : (g.dropped.length
                ? `已剔除会误触发的关键词：${g.dropped.map(d => `${d.key}（${Math.round(d.allRatio * 100)}% 的消息里出现）`).join('、')}`
                : (g.structuralWarn[0] || '')));

    if (review) {
        toast(`节点 ${node.id} 已写入但标为「待确认」并暂时禁用：${why}。请在节点列表里点「改关键词」修好后启用。`, 'warning');
    } else if (g.dropped.length) {
        toast(`已生成节点 ${node.id}：${node.title}（${node.from}-${node.to}楼）。${why}`, 'info');
    } else {
        toast(`已生成节点 ${node.id}：${node.title}（${node.from}-${node.to}楼）`, 'success');
    }
    return { ok: true, node, review, why, dropped: g.dropped, format: parsed.format };
}

/**
 * 总结「未总结的」那一段：拼提示词 → 调模型 → 落库。
 * @param {{manual?:boolean}} opts manual=true 时所有失败都会 toast 出来
 */
async function summarizePending({ manual = false } = {}) {
    if (summarizing) {
        if (manual) toast('已有一次总结在进行中，请稍候', 'info');
        return { ok: false, reason: 'busy' };
    }

    const r = await ensureBook({ interactive: manual });
    if (!r.ok) { if (manual) toast(r.reason, 'warning'); return r; }
    const state = r.state;

    const { from, to, empty } = pendingRange(state);
    if (empty) {
        if (manual) toast('没有未总结的消息', 'info');
        return { ok: false, reason: 'nothing-pending' };
    }

    const built = buildNodePrompt(from, to);
    if (!built.ok) {
        // 扫描范围内一条都不剩（例如设成"仅角色"但这段全是用户发言）。
        // 推进游标，否则每来一条消息都会重试一次、永远卡在这里。
        state.cursor = to + 1;
        persist();
        render();
        if (manual) {
            toast(`这段 ${to - from + 1} 条消息按当前「扫描范围」全部被过滤掉了（跳过 ${built.skipped} 条），没有生成节点。`, 'warning');
        }
        return { ok: false, reason: 'all-filtered', skipped: built.skipped };
    }

    let raw;
    try {
        raw = await callLlm(built.prompt);
    } catch (e) {
        console.error('[LoreMemory] 摘要失败', e);
        toast(`摘要失败：${e?.message || e}（原历史未丢失，游标未推进，可重试）`, 'error');
        return { ok: false, reason: 'llm-error' };
    }

    const applied = await applyNodeOutput(raw, from, to);
    if (!applied.ok) {
        toast('摘要返回空内容，本次放弃（游标未推进，可重试）', 'error');
        return applied;
    }
    return { ...applied, used: built.used };
}

/** 刷新骨架「现状卡」 */
async function refreshSkeleton(state, { manual = false } = {}) {
    const settings = getSettings();
    const chat = chatMessages();
    if (!chat.length) { if (manual) toast('聊天是空的', 'warning'); return { ok: false }; }

    // 手动禁用过的骨架，自动刷新必须绕开它（否则"禁用"活不过 24 楼）——手动刷新才重新启用
    const prevRec = (state.nodes || []).find(n => n.id === 'SKEL');
    const wasDisabled = prevRec && prevRec.status === 'disabled';
    if (wasDisabled && !manual) return { ok: false, reason: 'skeleton-disabled' };

    const from = Math.max(0, chat.length - SKELETON_LOOKBACK);
    const { text, used } = transcriptFor(from, chat.length - 1, settings);
    if (!used) { if (manual) toast('最近的消息按当前扫描范围被全部过滤，骨架未刷新', 'warning'); return { ok: false }; }

    const previous = (state.nodes.find(n => n.id === 'SKEL') || {}).content || '（无）';
    const prompt = renderPrompt(settings.skeletonPrompt, {
        ...promptVars(text, used, from, chat.length - 1),
        previous,
    });

    let raw;
    try {
        raw = await callLlm(prompt);
    } catch (e) {
        console.error('[LoreMemory] 骨架刷新失败', e);
        toast(`骨架刷新失败：${e?.message || e}`, 'error');
        return { ok: false };
    }
    // ── 硬闸门 ──
    // 提示词只能"请求"模型守规矩，这里才"保证"：结构化过滤掉叙述体 + 按 skeletonTokenCap 裁剪。
    // 实测教训（deepseek-flash）：要求 ≤200 字，实际输出 665 字，且整张卡是一篇小说。
    const gate = enforceSkeleton(raw, {
        tokenCap: Number(settings.skeletonTokenCap) || 350,
        estimate: estimateTokens,
        fields: SKELETON_FIELDS,
    });

    if (!gate.ok) {
        // 结构完全不合法（例如整段写成小说、一个状态字段都没有）：保留上一版，不写入垃圾
        toast(`骨架输出里没有任何状态字段，已保留原卡（模型没按模板写，原始输出 ${gate.rawTokens} token）`, 'warning');
        return { ok: false, reason: gate.reason, rawTokens: gate.rawTokens };
    }

    await writeSkeleton(state, gate.content);
    upsertSkeletonRecord(state, gate.content, 'active');
    persist();
    render();

    if (gate.changed) {
        const tail = gate.overCapRemain ? '，仍略超上限' : '';
        toast(`骨架已整理：${gate.actions.join('；')}｜${gate.rawTokens} → ${gate.tokens} token${tail}`, 'info');
    } else if (manual) {
        toast(wasDisabled ? '骨架现状卡已刷新并重新启用' : '骨架现状卡已刷新', 'success');
    }
    return { ok: true, tokens: gate.tokens, actions: gate.actions };
}

/** 用当前提示词重新总结某个已有节点（保持 uid 不变） */
async function resummarizeNode(state, node) {
    if (!node || node.id === 'SKEL') { toast('骨架请用「刷新骨架」', 'warning'); return; }
    if (summarizing) { toast('已有一次总结在进行中', 'info'); return; }

    const settings = getSettings();
    const chat = chatMessages();
    const from = Math.max(0, node.from - 1);
    const to = Math.min(chat.length - 1, node.to - 1);
    if (to < from) { toast('这个节点的区间已经不在聊天里了', 'warning'); return; }

    const { text, used } = transcriptFor(from, to, settings);
    if (!used) { toast('这个区间按当前扫描范围被全部过滤，无法重摘要', 'warning'); return; }

    const prompt = renderPrompt(settings.prompt, promptVars(text, used, from, to));
    let raw;
    try { raw = await callLlm(prompt); } catch (e) { toast(`重摘要失败：${e?.message || e}`, 'error'); return; }

    const ctx = getCtx();
    const parsed = parseSummaryOutput(raw, { exclude: [ctx.name1, ctx.name2].filter(Boolean) });
    if (!parsed.ok) { toast('重摘要返回空内容', 'error'); return; }

    const g = gateKeys(parsed.keywords, node.from, node.to);
    const degraded = parsed.degraded || !parsed.keywords.length;

    // 保留上一版正文，便于回溯（需求文档 FR-11「可撤销」）
    node.prevContent = node.content;
    node.title = parsed.title;
    node.tier = parsed.tier;
    node.keys = g.keys;
    node.droppedKeys = g.dropped.map(d => d.key);
    node.content = parsed.summary;
    node.status = (degraded || !g.structuralOk || g.keys.length === 0) ? 'needs_review' : 'active';
    node.source = 'llm';

    await writeNode(state, node);
    recountReview(state);
    persist();
    render();
    const extra = g.dropped.length ? `；已剔除误触发关键词 ${g.dropped.map(d => d.key).join('、')}` : '';
    toast(`已重新总结 ${node.id}（uid 未变，粘滞/冷却状态保留）${extra}`, g.dropped.length ? 'info' : 'success');
}

/**
 * 手工改节点的优先级档位（F8）。
 * tier → order：main 500 / side 300 / detail 100（entry.js 的 TIER_ORDER）。
 * 顺序改完必须重写条目 —— order 是条目字段，不是插件内存里的展示值。
 */
async function saveNodeTier(uid, tier) {
    const state = getState();
    const node = nodeByUid(state, uid);
    if (!node) return;
    if (node.id === 'SKEL') { toast('骨架的优先级固定为最高（order 900）', 'warning'); return; }
    const next = ['main', 'side', 'detail'].includes(String(tier)) ? String(tier) : 'side';
    if (node.tier === next) return;

    node.tier = next;
    await writeNode(state, node);
    persist();
    render();
    toast(`${node.id} 优先级 → ${TIER_LABEL[next] || next}（order ${TIER_ORDER[next]}）`, 'success');
}

/**
 * 回滚到重摘要前的正文（FR-11「可撤销」）。
 * 以前 `prevContent` 写进去就没人读，而且 `store.js` 的白名单连存都存不住。
 * 做成"对调"：回滚本身也可被再回滚，不会丢东西。
 */
async function rollbackNodeContent(uid) {
    const state = getState();
    const node = nodeByUid(state, uid);
    if (!node) return;
    if (node.id === 'SKEL') { toast('骨架请用「立刻刷新骨架现状卡」', 'warning'); return; }
    if (!node.prevContent) { toast('这个节点没有可回滚的上一版', 'warning'); return; }

    const current = node.content;
    node.content = node.prevContent;
    node.prevContent = current;      // 对调 → 可以再滚回去
    await writeNode(state, node);
    persist();
    render();
    toast(`${node.id} 已回滚到上一版正文（再点一次可滚回来）`, 'success');
}

/**
 * 手工修改节点的关键词（F9：以前「待确认」节点**没有任何修词入口**，
 * toast 和 README 却都在让用户"改关键词后启用" —— 那是一句空话）。
 *
 * 语义：手改即视为人工确认 —— 用户亲手写的词不再过判别力闸门（他看得见自己的聊天），
 * 但关键词为空时条目永远不会被召回，仍标回「待确认」并明确告知。
 */
async function saveNodeKeys(uid, rawValue) {
    const state = getState();
    const node = nodeByUid(state, uid);
    if (!node) return;
    if (node.id === 'SKEL') { toast('骨架不用关键词（它靠 constant 常驻注入）', 'warning'); return; }

    const keys = String(rawValue || '')
        .split(/[,，、;；|\s]+/)
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 8);

    node.keys = keys;
    node.droppedKeys = [];   // 人工过目过了，撤掉"已自动剔除"的提示
    if (keys.length) {
        if (node.status === 'needs_review') node.status = 'active';
    } else if (node.status === 'active') {
        node.status = 'needs_review';
    }

    await writeNode(state, node);
    recountReview(state);
    persist();
    render();
    if (keys.length) toast(`${node.id} 关键词已更新：${keys.join('、')}`, 'success');
    else toast(`${node.id} 关键词已清空 —— 该条目不会再被召回，已标为「待确认」`, 'warning');
}

function recountReview(state) {
    state.needsReview = (state.nodes || []).filter(n => n.status === 'needs_review').length;
}

// ───────────────────────── 自动记忆（自动建书 + 自动总结） ─────────────────────────

/** 聊天切换：跟随新聊天重新判定书的状态 */
async function onChatChanged() {
    bookReady = false;
    foreignBookWarned = false;
    forcedUids.clear();
    clearRecall();
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }

    const settings = getSettings();
    if (settings.autoMemory) {
        const r = await ensureBook({ interactive: false });
        if (r.ok && r.created) toast(`自动创建并绑定了聊天世界书：${r.bookName}`, 'success');
    }
    await refreshBookState();
}

/**
 * 每收到一条消息：按阈值决定要不要自动总结。
 * 刻意延时 + 单飞（summarizing）来避免和用户自己的生成抢 API。
 */
function scheduleAutoWork() {
    const settings = getSettings();
    if (!settings.autoMemory || summarizing) return;
    if (autoTimer) return;   // 已经排队了，别重复排

    autoTimer = setTimeout(async () => {
        autoTimer = null;
        try {
            if (!getSettings().autoMemory || summarizing) return;
            const r = await ensureBook({ interactive: false });
            if (!r.ok) return;
            const state = r.state;
            const chat = chatMessages();

            if (shouldSummarize(chat.length, state.cursor, getSettings())) {
                await summarizePending({ manual: false });
            }
            // 骨架刷新（用刷新后的 state，因为 summarizePending 可能改过它）
            const s2 = getState();
            if (s2 && shouldRefreshSkeleton(chat.length, s2.skeletonAt, getSettings())) {
                await refreshSkeleton(s2, { manual: false });
            }
            render();
        } catch (e) {
            console.error('[LoreMemory] 自动记忆失败', e);
        }
    }, 1500);
}

// ───────────────────────── 灌入演示节点 ─────────────────────────

async function seedDemo() {
    const r = await ensureBook();
    if (!r.ok) { toast(r.reason, 'warning'); return; }

    const state = r.state;
    toast('正在写入演示节点…', 'info');

    await writeSkeleton(state, DEMO_SKELETON);
    upsertSkeletonRecord(state, DEMO_SKELETON);

    for (const spec of DEMO_NODES) {
        let node = state.nodes.find(n => n.id === spec.id);
        if (!node) {
            node = {
                id: spec.id, uid: null, from: spec.from, to: spec.to, title: spec.title,
                keys: [...spec.keys], content: spec.content, tokens: 0, tier: spec.tier,
                status: 'active', hits: 0, lastHitAt: null, source: 'demo',
            };
            state.nodes.push(node);
        } else {
            node.keys = [...spec.keys];
            node.content = spec.content;
            node.tier = spec.tier;
            node.from = spec.from;
            node.to = spec.to;
            node.title = spec.title;
        }
        node.hot = spec.hot === true;
        node.arc = spec.arc;
        await writeNode(state, node);
    }

    state.cursor = Math.max(state.cursor, ...DEMO_NODES.map(n => n.to));
    state.demo = true;
    recountReview(state);
    persist();
    render();
    toast(`已写入 ${DEMO_NODES.length} 个演示节点 + 1 条骨架（${state.bookName}）`, 'success');
}

/** 清空：删除我们写进书里的条目（书本身保留，避免破坏用户的绑定） */
async function clearMemory() {
    const state = getState();
    if (!state || !state.bookName) { toast('还没有绑定世界书', 'warning'); return; }
    if (!window.confirm(`从世界书「${state.bookName}」中删除全部记忆条目？\n（书本身会保留，方便你随时重新灌入）`)) return;

    const data = await loadWorldInfo(state.bookName);
    if (data && data.entries) {
        const uids = new Set(state.nodes.map(n => n.uid).filter(Number.isInteger));
        for (const uid of uids) delete data.entries[uid];
        await saveWorldInfo(state.bookName, data, true);
        await updateWorldInfoList();
    }
    state.nodes = [];
    state.skeletonUid = null;
    state.skeletonAt = 0;
    state.cursor = 0;
    state.demo = false;
    state.needsReview = 0;
    state.ledger = [];
    persist();
    render();
    toast('已清空记忆条目', 'success');
}

/**
 * 清理空书：收拾历史遗留的垃圾世界书。
 *
 * 只删**同时**满足这三条的书，一条不满足就不动：
 *   ① 名字以 `LM-` 开头（我们自己建的）
 *   ② 里面一条条目都没有（空书没有任何信息，删了不会丢数据）
 *   ③ 不是当前聊天绑定的那本
 *
 * 存在的意义：早期版本会把 ST 欢迎屏当成聊天，每次刷新建一本空书
 * （`LM-xxx-nocid`、`LM-xxx-nocid (2)`……）。建书的 bug 已经修了，
 * 但这些书还留在用户的磁盘上，得给个一键收拾的办法。
 */
async function cleanupEmptyBooks() {
    const ctx = getCtx();
    const bound = ctx.chatMetadata?.[METADATA_KEY] || '';
    const names = (typeof ctx.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : []) || [];
    const candidates = names.filter(n => typeof n === 'string' && n.startsWith(BOOK_PREFIX) && n !== bound);

    const empties = [];
    for (const n of candidates) {
        try {
            const data = await loadWorldInfo(n);
            if (data && Object.keys(data.entries || {}).length === 0) empties.push(n);
        } catch (e) {
            // 读不出来就跳过：宁可不删，也不误删
            console.warn('[LoreMemory] 检查空书失败，跳过：', n, e);
        }
    }

    if (!empties.length) {
        toast(`没有可清理的空书（检查了 ${candidates.length} 本 ${BOOK_PREFIX} 开头的书）`);
        return { removed: 0, checked: candidates.length };
    }

    const preview = empties.slice(0, 10).map(n => `　· ${n}`).join('\n');
    const more = empties.length > 10 ? `\n　…… 还有 ${empties.length - 10} 本` : '';
    if (!window.confirm(
        `找到 ${empties.length} 本空的世界书（LoreMemory 建的、里面一条条目都没有）：\n\n` +
        `${preview}${more}\n\n` +
        '删除它们吗？\n（有内容的书一律不动；当前聊天绑定的那本也不动）')) {
        return { removed: 0, cancelled: true };
    }

    let removed = 0;
    for (const n of empties) {
        try {
            const res = await fetch('/api/worldinfo/delete', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ name: n }),
            });
            if (res.ok) removed++;
            else console.warn('[LoreMemory] 删除空书被拒绝：', n, res.status);
        } catch (e) {
            console.warn('[LoreMemory] 删除空书失败：', n, e);
        }
    }
    await updateWorldInfoList();
    toast(`已清理 ${removed} 本空书`, 'success');
    render();
    return { removed, found: empties.length };
}

// ───────────────────────── 钉选与召回（FR-10） ─────────────────────────

/**
 * 钉选：强制本回合注入一次。
 *
 * ⚠️ 实地核对 ST 1.18.0 源码后确认的一个陷阱（需求文档 §1.4/R8 未覆盖）：
 *    world-info.js L4774 `activatedNow.add(buffer.getExternallyActivated(entry))`
 *    —— 被注入的是**事件里传进来的那个对象本身**，而不是按 world.uid 回书里取条目。
 *    所以只传 `{ world, uid }` 会通过 L1022 的字段校验，却注入一条 content 为空的条目。
 *    正确做法：把书里那条**完整条目**（含 content/position/order/role…）传进去。
 */
async function pinNode(uid) {
    const state = getState();
    if (!state || !state.bookName) { toast('还没有绑定世界书', 'warning'); return; }
    const data = await loadWorldInfo(state.bookName);
    const entry = data && data.entries ? data.entries[uid] : null;
    if (!entry) { toast(`找不到 uid ${uid} 的条目`, 'error'); return; }
    if (entry.disable) { toast('该条目已禁用，先启用再钉选', 'warning'); return; }

    const clone = JSON.parse(JSON.stringify(entry));
    clone.world = state.bookName;
    clone.uid = uid;
    await eventSource.emit(event_types.WORLDINFO_FORCE_ACTIVATE, [clone]);
    forcedUids.add(uid);

    const node = nodeByUid(state, uid);
    toast(`已钉选：${node ? node.id + ' ' + node.title : 'uid ' + uid} —— 本回合必定注入（下一回合自动失效）`, 'success');
    render();
}

/**
 * 召回：把一个关键词塞进世界书扫描缓冲，让"最近两条没提到"的旧节点也能被命中。
 * 机制：setExtensionPrompt(..., scan=true) 会把文本并入扫描缓冲（world-info.js L4607）。
 */
function recallKeys(keys) {
    const clean = (keys || '').trim();
    if (!clean) { toast('用法：/lm-recall 魔界', 'warning'); return; }
    setExtensionPrompt(RECALL_KEY, clean, extension_prompt_types.IN_CHAT, 0, true, extension_prompt_roles.SYSTEM);
    recallActive = true;
    toast(`已把「${clean}」塞入扫描缓冲：下一次生成时即使没提到它，相关节点也会被召回`, 'success');
}

function clearRecall() {
    if (!recallActive) return;
    setExtensionPrompt(RECALL_KEY, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
    recallActive = false;
}

// ───────────────────────── 账本（FR-9）：读 ST 的扫描结果 ─────────────────────────

function onScanDone(args) {
    if (summarizing) return;   // 插件自己的摘要请求不记账

    const state = getState();
    if (!state || !state.bookName) return;

    const entries = args && args.activated && args.activated.entries;
    if (!entries) return;

    const list = typeof entries.values === 'function' ? Array.from(entries.values()) : Array.from(entries);
    const timed = (getCtx().chatMetadata || {}).timedWorldInfo || {};
    const items = [];

    for (const entry of list) {
        if (!entry || entry.world !== state.bookName) continue;   // 只看我们这本书
        const node = Number.isInteger(entry.uid) ? nodeByUid(state, entry.uid) : null;
        items.push({
            uid: entry.uid,
            id: node ? node.id : `uid${entry.uid}`,
            title: node ? `${node.id} ${node.title}` : (entry.comment || `uid ${entry.uid}`),
            tokens: estimateTokens(entry.content),
            reason: inferReason(entry, { forcedUids, timed }),
        });
    }

    const turn = chatMessages().length;
    recordTurn(state, turn, items);
    forcedUids.clear();
    clearRecall();
    persist();
    render();
}

// ───────────────────────── 面板挂载与事件 ─────────────────────────

function toast(msg, type = 'info') {
    try {
        if (typeof toastr !== 'undefined') toastr[type](msg, '记忆节点 · LoreMemory', { timeOut: type === 'error' ? 8000 : 4000 });
    } catch { /* toastr 不可用时静默 */ }
    console.log('[LoreMemory]', msg);
}

function render() {
    const root = document.getElementById(PANEL_ID);
    if (!root) return;
    const ctx = getCtx();
    let state;
    try { state = getState(); } catch { state = null; }
    if (!state) {
        root.innerHTML = '<div class="lm-empty">请先打开一个聊天。</div>';
        return;
    }
    let stVersion = '';
    try { stVersion = window.SillyTavern?.getVersion?.('release') || ''; } catch { /* ignore */ }

    renderPanel(root, {
        state,
        settings: getSettings(),
        drawers: getDrawerState(),
        drawerHints: {
            turn: lastTurnHint(state),
            nodes: `（${(state.nodes || []).length} 条）`,
        },
        bookName: state.bookName,
        bookExists: bookReady || !!state.bookName,
        maxContext: Number(ctx.maxContext) || 0,
        stVersion,
        pending: pendingCount(chatMessages().length, state.cursor),
    });
    renderSettingsAdvice(state);
}

/** 折叠标题右侧的小提示，让收起时也能看出关键信息 */
function lastTurnHint(state) {
    const last = (state.ledger || [])[state.ledger.length - 1];
    if (!last) return '（还没有数据）';
    return last.injected.length
        ? `（${last.injected.length} 条 · ${last.tokens} token）`
        : '（本回合无注入）';
}

async function refreshBookState() {
    const state = getState();
    if (state && state.bookName) {
        bookReady = await bookExistsOnDisk(state.bookName);
        if (!bookReady) console.warn('[LoreMemory] 绑定的世界书不在磁盘上：', state.bookName);
    } else {
        bookReady = false;
    }
    render();
}

function mountPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const host = document.getElementById('extensions_settings');
    if (!host) return;

    const block = document.createElement('div');
    block.className = 'lm-settings-block';
    block.innerHTML = `<div class="lm-panel-root" id="${PANEL_ID}"></div>`;
    host.append(block);

    // 事件委托：整块重绘后无需重新绑定
    block.addEventListener('click', onPanelClick);
    block.addEventListener('change', onPanelSettingChange);
    block.addEventListener('input', onPanelSettingInput);

    render();
}

/** 输入框：只更新内存 + 轻量重绘（不整块重绘，否则光标会跳） */
function onPanelSettingInput(ev) {
    const el = ev.target.closest('[data-lm-setting]');
    if (!el) return;
    const key = el.dataset.lmSetting;
    const holder = extension_settings[MODULE_NAME] || (extension_settings[MODULE_NAME] = {});
    const current = getSettings();
    const value = el.type === 'checkbox' ? el.checked : el.value;
    const patch = { ...current, [key]: value };
    if (key === 'prompt' || key === 'skeletonPrompt') patch.promptVersion = DEFAULT_PROMPT_VERSION;
    holder.settings = normalizeSettings(patch);
    saveSettingsDebounced();
    if (key === 'prompt' || key === 'skeletonPrompt') return; // 文本域不重绘
}

/** 勾选框 / 下拉框 / 数字框：改完重绘，让「未总结 / 阈值」等派生显示立刻跟上 */
async function onPanelSettingChange(ev) {
    // 节点关键词输入框（F9）：change 在失焦/回车时触发，改完直接落盘并重绘 chip
    const keysEl = ev.target.closest('[data-lm-keys]');
    if (keysEl) {
        await saveNodeKeys(Number(keysEl.dataset.lmKeys), keysEl.value);
        return;
    }
    // 节点优先级下拉（F8）：改 order 阶梯
    const tierEl = ev.target.closest('[data-lm-tier]');
    if (tierEl) {
        await saveNodeTier(Number(tierEl.dataset.lmTier), tierEl.value);
        return;
    }
    const el = ev.target.closest('[data-lm-setting]');
    if (!el) return;
    if (el.tagName === 'TEXTAREA') return;
    onPanelSettingInput(ev);
    render();
}

async function onPanelClick(ev) {
    // ── 折叠区块 ──
    // ST 自己的 handler 挂在 document 上（用 jQuery slideToggle 改 DOM），
    // 我们的监听器在容器上、冒泡更早触发，所以此刻 DOM 还反映"点击前"的状态：
    // 读一下图标就知道点完会变成什么，记下来供下次重绘还原。
    const toggle = ev.target.closest('.inline-drawer-toggle');
    if (toggle) {
        const drawerEl = toggle.closest('[data-lm-drawer]');
        if (drawerEl) {
            const wasOpen = !!toggle.querySelector('.inline-drawer-icon.up');
            setDrawerState(drawerEl.dataset.lmDrawer, !wasOpen);
        }
        return;   // 折叠标题上不该有别的动作
    }

    const btn = ev.target.closest('[data-lm-action]');
    if (!btn) {
        // 「打开世界书面板」不是 lm-action，单独处理
        if (ev.target.closest('[data-lm-openwi]')) openWorldInfoPanel();
        return;
    }
    const action = btn.dataset.lmAction;
    const uid = btn.dataset.lmUid !== undefined ? Number(btn.dataset.lmUid) : null;
    const state = getState();

    try {
        switch (action) {
            case 'enable': {
                const r = await ensureBook();
                if (!r.ok) { toast(r.reason, 'warning'); return; }
                toast(`已绑定世界书：${r.bookName}`, 'success');
                render();
                break;
            }
            case 'seed': await seedDemo(); break;
            case 'summarize': await summarizePending({ manual: true }); break;
            case 'refresh-skeleton': await refreshSkeleton(state, { manual: true }); break;
            case 'restore-prompt': restoreDefaultPrompt(); render(); toast('已恢复默认摘要提示词', 'success'); break;
            case 'restore-skeleton-prompt': restoreDefaultSkeletonPrompt(); render(); toast('已恢复默认骨架提示词', 'success'); break;
            case 'refresh': await refreshBookState(); toast('已刷新', 'info'); break;
            case 'clear': await clearMemory(); break;
            case 'cleanup-books': await cleanupEmptyBooks(); break;
            case 'pin': await pinNode(uid); break;
            case 'resummarize': await resummarizeNode(state, nodeByUid(state, uid)); break;
            case 'toggle': {
                const node = nodeByUid(state, uid);
                if (!node) return;
                node.status = node.status === 'disabled' ? 'active' : 'disabled';
                // 骨架必须走骨架补丁。以前无差别走 writeNode，会把骨架降级成普通节点
                // （constant:false + position:before_char + 空关键词），面板却显示"已启用"。
                if (node.id === 'SKEL') await writeSkeletonEntryOnly(state, node);
                else await writeNode(state, node);
                recountReview(state);
                persist(); render();
                toast(`${node.id} 已${node.status === 'disabled' ? '禁用' : '启用'}`, 'info');
                break;
            }
            case 'edit': {
                const box = btn.closest('.lm-node')?.querySelector('.lm-content');
                if (box) box.hidden = !box.hidden;
                break;
            }
            case 'edit-keys': {
                // F9：关键词以前是只读 chip，没有任何修词入口
                const box = btn.closest('.lm-node')?.querySelector('.lm-keys-edit');
                if (box) {
                    box.hidden = !box.hidden;
                    if (!box.hidden) box.querySelector('input')?.focus();
                }
                break;
            }
            case 'rollback': await rollbackNodeContent(uid); break;
            case 'delete': {
                const node = nodeByUid(state, uid);
                if (!node) return;
                if (node.id === 'SKEL') { toast('骨架条目不能删除，请用「清空记忆」', 'warning'); return; }
                if (!window.confirm(`删除节点 ${node.id}「${node.title}」？`)) return;
                const data = await loadWorldInfo(state.bookName);
                if (data && data.entries && Number.isInteger(node.uid)) {
                    delete data.entries[node.uid];
                    await saveWorldInfo(state.bookName, data, true);
                    await updateWorldInfoList();
                }
                state.nodes = state.nodes.filter(n => n !== node);
                recountReview(state);
                persist(); render();
                toast(`已删除 ${node.id}`, 'success');
                break;
            }
            default: break;
        }
    } catch (e) {
        console.error('[LoreMemory] 面板操作失败', action, e);
        toast(`操作失败：${e?.message || e}`, 'error');
    }
}

/** 建议的世界书设置（FR-7）—— 只展示，不偷偷改全局 */
function renderSettingsAdvice(state) {
    const host = document.getElementById('lm_settings_advice');
    if (!host) return;
    const settings = getSettings();
    const rec = { depth: 4, minAct: 2, minActMax: 150, budget: 10, cap: 2048 };
    const cur = {
        depth: world_info_depth,
        minAct: world_info_min_activations,
        minActMax: world_info_min_activations_depth_max,
        budget: world_info_budget,
        cap: world_info_budget_cap,
    };
    const row = (label, c, r, hint) => `
        <tr>
            <td>${escapeHtml(label)}</td>
            <td class="lm-num">${escapeHtml(String(c))}</td>
            <td class="lm-num lm-rec">${escapeHtml(String(r))}</td>
            <td class="lm-dim">${escapeHtml(hint)}</td>
        </tr>`;
    host.innerHTML = `
        <div class="lm-section-title">建议的世界书设置 <span class="lm-dim">（全局设置，会影响你所有世界书，插件不自动修改）</span></div>
        <table class="lm-table">
            <thead><tr><th>设置</th><th class="lm-num">当前</th><th class="lm-num">建议</th><th>为什么</th></tr></thead>
            <tbody>
            ${row('扫描深度 depth', cur.depth, rec.depth, '默认只有 2，太浅则旧节点召不回')}
            ${row('最少激活数 min_activations', cur.minAct, rec.minAct, '命中不足时自动向更早历史扩窗')}
            ${row('扩窗上限 depth_max', cur.minActMax, rec.minActMax, '与上一条配套，防无限扩张')}
            ${row('预算 budget %', cur.budget, rec.budget, '默认 25% 太宽，记忆会挤掉正文')}
            ${row('预算硬上限 cap', cur.cap, rec.cap, '0 表示不设上限')}
            </tbody>
        </table>
        <div class="lm-actions lm-actions-tight">
            <button class="menu_button lm-btn" data-lm-openwi="1"><i class="fa-solid fa-book"></i> 打开 ST 的世界书面板去调整</button>
        </div>
        <p class="lm-dim">当前生成参数：每 ${settings.promptInterval} 条总结 · 扫描范围 ${{ all: '角色+用户', char: '仅角色', user: '仅用户' }[settings.scanScope]} ·
            sticky ${settings.sticky} / cooldown ${settings.cooldown} · 节点上限 ${settings.nodeTokenCap} token</p>`;
}

/** 打开 ST 自带的世界书抽屉 */
function openWorldInfoPanel() {
    const drawer = document.getElementById('WIDrawerIcon') || document.getElementById('world_info');
    if (drawer) drawer.click();
    else toast('请点 ST 顶部的世界书按钮（书本图标）打开面板', 'info');
}

/** 在「扩展程序」魔法棒菜单里加一个入口，方便找到面板 */
function mountMenuButton() {
    const tryMount = () => {
        const menu = document.getElementById('extensionsMenu');
        if (!menu || document.getElementById('lm_menu_item')) return !!menu;
        const item = document.createElement('div');
        item.id = 'lm_menu_item';
        item.className = 'list-group-item flex-container flexGap5';
        item.tabIndex = 0;
        item.innerHTML = '<i class="fa-solid fa-brain"></i><span>记忆节点 · LoreMemory</span>';
        item.addEventListener('click', () => {
            const panel = document.querySelector('.lm-settings-block');
            if (!panel) { toast('面板未挂载', 'warning'); return; }
            // 面板现在整个是可折叠的：从菜单进来时必须先展开外层，
            // 否则用户看到的是一个收起的标题行，等于"点了没反应"。
            if (getDrawerState().root === false) {
                setDrawerState('root', true);
                render();
            }
            panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
            panel.classList.add('lm-flash');
            setTimeout(() => panel.classList.remove('lm-flash'), 1200);
        });
        menu.append(item);
        return true;
    };
    if (tryMount()) return;
    let tries = 0;
    const timer = setInterval(() => {
        if (tryMount() || ++tries > 60) clearInterval(timer);
    }, 1000);
}

// ───────────────────────── 斜杠命令（FR-10） ─────────────────────────

function registerCommands() {
    const add = (props) => SlashCommandParser.addCommandObject(SlashCommand.fromProps(props));

    add({
        name: 'lm-list',
        callback: () => {
            const state = getState();
            if (!state || !state.nodes.length) return '（还没有任何记忆节点）';
            return state.nodes.map(n => `${n.id} [${n.uid}] ${n.from}-${n.to}楼 ${n.title} · ${n.tokens}tok · ${n.status} · 命中${n.hits}次 · keys=${(n.keys || []).join('/')}`).join('\n');
        },
        helpString: '列出当前聊天的所有记忆节点。',
        returns: ARGUMENT_TYPE.STRING,
    });

    add({
        name: 'lm-seed',
        callback: async () => { await seedDemo(); return ''; },
        helpString: '灌入演示节点（演示版专用，让你不用聊满 N 楼也能看到效果）。',
        returns: ARGUMENT_TYPE.STRING,
    });

    add({
        name: 'lm-now',
        callback: async () => {
            const r = await summarizePending({ manual: true });
            return r.ok ? `已生成节点 ${r.node.id}` : `未生成（${r.reason}）`;
        },
        helpString: '立刻把「未总结的消息」总结成一个节点（不等阈值）。',
        returns: ARGUMENT_TYPE.STRING,
    });

    add({
        name: 'lm-skeleton',
        callback: async () => {
            const state = getState();
            const r = await refreshSkeleton(state, { manual: true });
            return r.ok ? '骨架已刷新' : '骨架未刷新';
        },
        helpString: '立刻用当前骨架提示词重写「现状卡」。',
        returns: ARGUMENT_TYPE.STRING,
    });

    add({
        name: 'lm-auto',
        callback: (_args, value) => {
            const v = String(value ?? '').trim().toLowerCase();
            const on = ['on', 'true', '1', '开', '开启'].includes(v) ? true
                : ['off', 'false', '0', '关', '关闭'].includes(v) ? false : null;
            if (on === null) return `用法：/lm-auto on|off（当前：${getSettings().autoMemory ? 'on' : 'off'}）`;
            updateSetting('autoMemory', on);
            render();
            if (on) scheduleAutoWork();
            return `自动记忆已${on ? '开启' : '关闭'}`;
        },
        unnamedArgumentList: [new SlashCommandArgument('on / off', [ARGUMENT_TYPE.STRING], false)],
        helpString: '开关自动记忆（自动建书 + 每 N 条自动总结）。',
        returns: ARGUMENT_TYPE.STRING,
    });

    add({
        name: 'lm-interval',
        callback: (_args, value) => {
            const n = Number(value);
            if (!Number.isFinite(n)) return `用法：/lm-interval 12（当前：${getSettings().promptInterval}）`;
            updateSetting('promptInterval', n);
            render();
            return `已设置：每 ${getSettings().promptInterval} 条消息总结一次`;
        },
        unnamedArgumentList: [new SlashCommandArgument('条数', [ARGUMENT_TYPE.NUMBER], false)],
        helpString: '设置「每多少条消息总结一次」。',
        returns: ARGUMENT_TYPE.STRING,
    });

    add({
        name: 'lm-scope',
        callback: (_args, value) => {
            const v = String(value ?? '').trim();
            if (!['all', 'char', 'user'].includes(v)) {
                return `用法：/lm-scope all|char|user（当前：${getSettings().scanScope}）\nall=角色+用户，char=仅角色，user=仅用户`;
            }
            updateSetting('scanScope', v);
            render();
            return `总结时扫描范围已设为：${{ all: '角色+用户', char: '仅角色', user: '仅用户' }[v]}`;
        },
        unnamedArgumentList: [new SlashCommandArgument('all / char / user', [ARGUMENT_TYPE.STRING], false)],
        helpString: '设置总结时扫描哪些消息。',
        returns: ARGUMENT_TYPE.STRING,
    });

    add({
        name: 'lm-pin',
        callback: async (_args, uidOrId) => {
            const state = getState();
            if (!state) return '没有打开聊天';
            const node = findNode(state, uidOrId);
            if (!node) return `找不到节点：${uidOrId}（用 /lm-list 看列表）`;
            await pinNode(node.uid);
            return `已钉选 ${node.id} ${node.title}`;
        },
        unnamedArgumentList: [new SlashCommandArgument('节点 id 或标题片段', [ARGUMENT_TYPE.STRING], true)],
        helpString: '强制某个记忆节点在本回合被注入一次（下一回合自动失效）。',
        returns: ARGUMENT_TYPE.STRING,
    });

    add({
        name: 'lm-recall',
        callback: (_args, keys) => {
            recallKeys(String(keys || ''));
            return `已把「${keys}」塞入扫描缓冲`;
        },
        unnamedArgumentList: [new SlashCommandArgument('要强行召回的关键词', [ARGUMENT_TYPE.STRING], true)],
        helpString: '即使最近消息里没提到这个词，也让相关记忆节点被激活（靠扩展注入并入世界书扫描缓冲）。',
        returns: ARGUMENT_TYPE.STRING,
    });

    add({
        name: 'lm-clear',
        callback: async () => { await clearMemory(); return ''; },
        helpString: '删除本聊天世界书里的全部记忆条目（书本身保留）。',
        returns: ARGUMENT_TYPE.STRING,
    });

    add({
        name: 'lm-status',
        callback: () => {
            const state = getState();
            if (!state) return '没有打开聊天';
            const settings = getSettings();
            const last = state.ledger[state.ledger.length - 1];
            return [
                `书：${state.bookName || '(未绑定)'}`,
                `节点：${state.nodes.length} 条（待确认 ${state.needsReview}）`,
                `未总结：${pendingCount(chatMessages().length, state.cursor)} 条 / 每 ${settings.promptInterval} 条触发`,
                `自动记忆：${settings.autoMemory ? '开' : '关'} · 扫描范围：${settings.scanScope}`,
                `本回合注入：${last ? last.tokens : 0} token（${last ? last.injected.length : 0} 条）`,
                `提示词：${settings.prompt === DEFAULT_PROMPT ? '默认' : '已自定义'}（v${settings.promptVersion}）`,
            ].join('\n');
        },
        helpString: '显示 LoreMemory 的当前状态。',
        returns: ARGUMENT_TYPE.STRING,
    });
}

// ───────────────────────── 初始化 ─────────────────────────

async function init() {
    const holder = extension_settings[MODULE_NAME] || (extension_settings[MODULE_NAME] = {});
    holder.settings = normalizeSettings(holder.settings);
    saveSettingsDebounced();

    const waitForPanel = setInterval(() => {
        if (document.getElementById('extensions_settings')) {
            mountPanel();
            render();
            clearInterval(waitForPanel);
        }
    }, 500);

    mountMenuButton();
    registerCommands();

    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    // 核心：账本完全依赖 ST 的扫描结果，插件不模拟扫描
    eventSource.on(event_types.WORLDINFO_SCAN_DONE, onScanDone);

    // 自动记忆：每收到消息按阈值决定要不要总结
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        try {
            const settings = getSettings();
            if (!settings.autoMemory) return;
            scheduleAutoWork();
        } catch (e) {
            console.warn('[LoreMemory] 自动记忆调度失败', e);
        }
    });

    // 进插件时如果已经在一个聊天里且开了自动记忆，补一次建书。
    // 这里必须**先确认真的在聊天里**：刷新时 ST 可能正停在欢迎屏，
    // 那一屏也有"消息"（它自己塞的助手问候语），无条件补建书会在每次刷新时
    // 造出一本绑不上任何聊天的空书。
    setTimeout(() => {
        try {
            if (!isRealChatContext(getCtx())) return;
        } catch { return; }
        onChatChanged().catch(() => { /* ignore */ });
    }, 2000);

    console.log('[LoreMemory] 演示版已加载');
}

(async () => {
    try {
        await init();
    } catch (e) {
        console.error('[LoreMemory] 初始化失败', e);
    }
})();

// 供调试与自动化测试使用
window.LoreMemory = {
    get state() { return getState(); },
    get settings() { return getSettings(); },
    seedDemo, clearMemory, summarizePending, refreshSkeleton, resummarizeNode,
    pinNode, recallKeys, ensureBook, getSettings, updateSetting,
    cleanupEmptyBooks, isRealChatContext,
    // 流水线分段：可以在不调模型的前提下验证"拼提示词"与"落库"两段
    buildNodePrompt, applyNodeOutput, pendingRange,
    render, scheduleAutoWork,
    get bookReady() { return bookReady; },
    get summarizing() { return summarizing; },
    chat_metadata,
};
