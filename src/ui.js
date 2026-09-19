/**
 * 面板渲染（DOM，无 ST 依赖）
 *
 * 布局沿用 ST 自己的 `inline-drawer` 结构 —— 这样外观、动画、移动端行为都跟
 * 「向量存储 / 摘要 / 正则」这些内置扩展完全一致，主题换肤也自动跟随。
 *
 * 三个必须自己处理的点：
 *  1. **展开状态要自己记**。ST 的展开逻辑挂在 `$(document).on('click', '.inline-drawer-toggle')` 上，
 *     用 jQuery `slideToggle` 直接改 DOM。我们每次状态变化都整块重绘 innerHTML，
 *     不记住状态的话，用户刚展开的面板会被下一次扫描结果"啪"地关上。
 *     所以：点击时记状态（容器上的监听器先于 document 触发），重绘时按记录渲染。
 *  2. **不做 stopPropagation**：让 ST 自己的 handler 去管 DOM/动画，我们只管状态，互不打架。
 *  3. **两层嵌套是安全的**（实测 ST 1.18.0 script.js:12131 的 handler）：
 *     它取的是 `$(this).closest('.inline-drawer')` + `find('>.inline-drawer-content')`，
 *     全是"直接子元素"语义，所以点内层标题只会动内层。另外 jQuery 委托是沿着祖先逐个匹配
 *     `.inline-drawer-toggle`，而外层 header 与内层抽屉是**兄弟关系**（内层在 content 里），
 *     不构成祖先链，因此点内层不会连带触发外层。
 */

import { estimateTokens, fmtTokens } from './tokens.js';
import { REASON_LABEL, TIER_LABEL, TIER_ORDER } from './entry.js';
import { avgInjectedTokens, topHitNodes, castIndex } from './store.js';
import { SETTINGS_META, PLACEHOLDERS, unknownPlaceholders, isCustomPrompt, isCustomSkeletonPrompt } from './settings.js';

export function escapeHtml(s) {
    return String(s ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

const STATUS_BADGE = {
    active: { cls: 'lm-badge-ok', text: '生效' },
    pending: { cls: 'lm-badge-warn', text: '待确认' },
    needs_review: { cls: 'lm-badge-warn', text: '待确认' },
    disabled: { cls: 'lm-badge-off', text: '已禁用' },
    archived: { cls: 'lm-badge-off', text: '已归档' },
};

/**
 * 每个抽屉的 key、标题、默认展开状态。
 * `root` 是**整个插件**的外层折叠块（和「向量存储 / 摘要」那些扩展同款），
 * 其余 5 个是它的子区块，全部嵌在 root 的 content 里。
 */
export const DRAWERS = {
    root: { title: '记忆节点 · LoreMemory', open: true },
    turn: { title: '本回合注入了什么', open: true },
    nodes: { title: '记忆节点', open: true },
    settings: { title: '生成设置', open: false },
    advice: { title: '世界书设置建议', open: false },
    help: { title: '使用说明与命令', open: false },
};

/**
 * 渲染整个面板：外层一个可折叠的插件块，5 个子区块嵌在里面。
 * @param {HTMLElement} root
 * @param {object} ctx { state, settings, drawers, bookName, bookExists, maxContext, stVersion, pending }
 */
export function renderPanel(root, ctx) {
    const inner = [
        statusBar(ctx),
        actions(ctx),
        drawer('turn', ctx, bodyTurn(ctx)),
        drawer('nodes', ctx, bodyNodes(ctx)),
        drawer('settings', ctx, bodySettings(ctx), { badge: ctx.settings.autoMemory ? '自动记忆已开' : '' }),
        drawer('advice', ctx, '<div id="lm_settings_advice"></div>'),
        drawer('help', ctx, bodyHelp(ctx)),
    ].join('');

    root.innerHTML = drawer('root', ctx, inner, {
        headerLeft: rootHeader(ctx),
        extraClass: 'lm-root-drawer',
    });
}

/** 一个折叠区块 */
function drawer(key, ctx, bodyHtml, { badge = '', headerLeft = '', extraClass = '' } = {}) {
    const meta = DRAWERS[key];
    // 注意要用 "key in drawers" 判断，不能写 ctx.drawers[key]：
    // 状态是稀疏的（只记录用户动过的那些），没记录的必须回落到该区块的默认展开状态，
    // 否则 `!!undefined === false` 会让所有默认展开的区块一开始就是收起的。
    const hasRecord = ctx.drawers && Object.prototype.hasOwnProperty.call(ctx.drawers, key);
    const open = hasRecord ? !!ctx.drawers[key] : meta.open;

    const left = headerLeft || `
                <b>${escapeHtml(meta.title)}</b>
                ${badge ? `<span class="lm-badge lm-badge-auto">${escapeHtml(badge)}</span>` : ''}
                ${ctx.drawerHints?.[key] ? `<span class="lm-dim">${escapeHtml(ctx.drawerHints[key])}</span>` : ''}`;

    return `
    <div class="inline-drawer lm-drawer${extraClass ? ' ' + extraClass : ''}" data-lm-drawer="${key}">
        <div class="inline-drawer-toggle inline-drawer-header">
            <div class="lm-drawer-title">${left}
            </div>
            <div class="inline-drawer-icon fa-solid ${open ? 'fa-circle-chevron-up up' : 'fa-circle-chevron-down down'}"></div>
        </div>
        <div class="inline-drawer-content" style="display:${open ? 'block' : 'none'}">${bodyHtml}</div>
    </div>`;
}

// ───────────────────────── 外层折叠块的标题 ─────────────────────────

/**
 * 外层标题（就是折叠开关本身）。收起时这里仍然可见，所以关键信息必须挤进来：
 * 绑定的世界书、节点数、未总结条数、以及「待确认 / 超预算」这类告警。
 */
function rootHeader(ctx) {
    const { settings, state, bookName, pending } = ctx;
    const nodes = (state.nodes || []).length;
    const every = Number(settings.promptInterval) || 0;
    const waiting = every > 0 ? Math.max(0, every - (Number(pending) || 0)) : 0;

    const parts = [];
    if (bookName) parts.push(`<code>${escapeHtml(bookName)}</code>`);
    else parts.push('未绑定世界书');
    parts.push(nodes ? `${nodes} 节点` : '暂无节点');
    if (Number(pending) > 0) parts.push(`未总结 ${Number(pending)}`);
    if (settings.autoMemory) parts.push(waiting > 0 ? `还差 ${waiting} 条` : '可总结');

    return `
                <span class="lm-root-name"><i class="fa-solid fa-brain"></i> 记忆节点 · LoreMemory</span>
                ${ctx.devBuild ? '<span class="lm-badge-demo">开发版</span>' : ''}
                ${settings.autoMemory ? '<span class="lm-badge lm-badge-auto">自动记忆</span>' : ''}
                ${state.needsReview > 0 ? `<span class="lm-badge lm-badge-warn">${state.needsReview} 条待确认</span>` : ''}
                ${isOverBudget(ctx) ? '<span class="lm-badge lm-badge-warn">超预算</span>' : ''}
                <span class="lm-dim lm-root-sub" title="记忆条目所在的聊天世界书">${parts.join(' · ')}</span>`;
}

/** 本回合注入量是否越过告警线（标题徽标与状态行共用同一份判断） */
function isOverBudget(ctx) {
    const lastTurn = (ctx.state.ledger || [])[ctx.state.ledger.length - 1];
    const turnTokens = lastTurn ? lastTurn.tokens : 0;
    const maxContext = Number(ctx.maxContext) || 0;
    const pct = maxContext > 0 ? ((turnTokens / maxContext) * 100) : 0;
    return maxContext > 0 && pct > Number(ctx.settings.budgetWarnPct || 10);
}

function statusBar(ctx) {
    const { state, settings, pending } = ctx;
    const lastTurn = (state.ledger || [])[state.ledger.length - 1];
    const avg = avgInjectedTokens(state, 20);
    const maxContext = Number(ctx.maxContext) || 0;
    const turnTokens = lastTurn ? lastTurn.tokens : 0;
    const pct = maxContext > 0 ? ((turnTokens / maxContext) * 100) : 0;
    const overBudget = isOverBudget(ctx);
    const every = Number(settings.promptInterval) || 0;
    const waiting = every > 0 ? Math.max(0, every - (Number(pending) || 0)) : 0;

    return `
    <div class="lm-status ${overBudget ? 'lm-status-warn' : ''}">
        <div class="lm-stat"><span class="lm-k">节点</span><span class="lm-v">${(state.nodes || []).length}</span></div>
        <div class="lm-stat"><span class="lm-k">未总结</span><span class="lm-v">${Number(pending) || 0}</span>
            ${settings.autoMemory && every > 0
                ? `<span class="lm-sub">${waiting > 0 ? `还差 ${waiting} 条自动总结` : '已满足自动总结条件'}</span>`
                : '<span class="lm-sub">自动记忆未开</span>'}</div>
        <div class="lm-stat"><span class="lm-k">本回合注入</span><span class="lm-v">${fmtTokens(turnTokens)}</span>
            ${maxContext > 0 ? `<span class="lm-sub">≈ ${pct.toFixed(1)}%</span>` : ''}</div>
        <div class="lm-stat"><span class="lm-k">近 20 回合均值</span><span class="lm-v">${fmtTokens(avg)}</span></div>
    </div>
    ${overBudget ? `<div class="lm-alert">记忆注入已超过你设定的 ${settings.budgetWarnPct}% 告警线 —— 正文正在被挤。</div>` : ''}
    ${(state.needsReview > 0) ? `<div class="lm-alert lm-alert-warn">有 ${state.needsReview} 条节点因关键词质量不过关被标为「待确认」并暂时禁用，请到「记忆节点」里改关键词后启用。</div>` : ''}`;
}

/**
 * 按钮区。两个版本的区别**只在这里**：
 *
 *   开发者版：第一行 [总结] [刷新] [清空记忆]   ← 三等分，一起铺满整行
 *             第二行 [灌入演示节点]             ← 占一整行（调试入口，不跟操作键挤一行）
 *             第三行 [管理聊天书]               ← 也占一整行
 *   用户版  ：第一行 [立刻总结…] [管理聊天书]   ← 2×2 四格铺满
 *             第二行 [刷新]     [清空记忆]
 *
 * 用户版是**把演示键那一格换成「管理聊天书」**，不是在演示键下面再加一行：
 * 演示入口在用户包里根本不存在，空出来那一格会留个洞 ——
 * 移动端本来就是 2×2 四格铺满（用户给的那张参考图就是这个形状），
 * 所以「管理聊天书」直接顶在演示键原来的格子上（DOM 顺序：总结 / 演示位 / 刷新 / 清空）。
 *
 * 「管理聊天书」两个版本都有：它是正式功能（看内容 / 新增 / 删除），
 * 而且没有绑定书时也要能点开 —— 否则用户没法把已有的书绑回来。
 */
function actions(ctx) {
    const { state, bookExists } = ctx;
    const dev = !!ctx.devBuild;

    if (!bookExists) {
        // 还没绑书：只能「启用记忆」建一本新的 —— 但「管理聊天书」必须留着，
        // 否则用户没法把已经存在（上次聊过）的那本绑回来。
        return `
    <div class="lm-actions">
        <button class="menu_button lm-btn lm-btn-primary" data-lm-action="enable"><i class="fa-solid fa-plug"></i> 启用记忆（建书并绑定）</button>
    </div>
    <div class="lm-actions lm-actions-tight">
        <button class="menu_button lm-btn lm-btn-block" data-lm-action="books"><i class="fa-solid fa-book-bookmark"></i> 管理聊天书</button>
    </div>`;
    }

    const summarizeBtn = `<button class="menu_button lm-btn lm-tone-amber" data-lm-action="summarize"><i class="fa-solid fa-wand-magic-sparkles"></i> 立刻总结未总结的消息</button>`;
    const refreshBtn = `<button class="menu_button lm-btn" data-lm-action="refresh"><i class="fa-solid fa-rotate"></i> 刷新</button>`;
    const clearBtn = `<button class="menu_button lm-btn lm-btn-danger" data-lm-action="clear"><i class="fa-solid fa-broom"></i> 清空记忆</button>`;
    // 「世界书那一类入口」统一用条目关键词同款蓝色（字色 + 边框）：
    // 插件里有两条通往世界书的路 —— 自己建的聊天书（管理聊天书）、和 ST 自带的那个面板。
    const booksBtn = `<button class="menu_button lm-btn lm-tone-key" data-lm-action="books"><i class="fa-solid fa-book-bookmark"></i> 管理聊天书</button>`;

    if (!dev) {
        return `
    <div class="lm-actions lm-actions-grid2">
        ${summarizeBtn}
        ${booksBtn}
        ${refreshBtn}
        ${clearBtn}
    </div>`;
    }

    return `
    <div class="lm-actions">
        ${summarizeBtn}
        ${refreshBtn}
        ${clearBtn}
    </div>
    <div class="lm-actions lm-actions-tight">
        <button class="menu_button lm-btn lm-btn-block" data-lm-action="seed" ${state.demo ? 'disabled' : ''}><i class="fa-solid fa-flask"></i> ${state.demo ? '演示节点已灌入' : '灌入演示节点'}</button>
    </div>
    <div class="lm-actions lm-actions-tight">
        <button class="menu_button lm-btn lm-btn-block lm-tone-key" data-lm-action="books"><i class="fa-solid fa-book-bookmark"></i> 管理聊天书</button>
    </div>`;
}

// ───────────────────────── 各抽屉内容 ─────────────────────────

function bodyTurn(ctx) {
    const lastTurn = (ctx.state.ledger || [])[ctx.state.ledger.length - 1];
    if (!lastTurn) {
        return '<div class="lm-empty">还没有生成过。发一条消息，这里会显示 ST 实际注入了哪些记忆条目。</div>';
    }
    if (!lastTurn.injected.length) {
        return '<div class="lm-empty">本回合没有任何记忆条目被注入 —— 这就是「平时不花钱」。</div>';
    }
    return `
    <div class="lm-dim lm-section-sub">第 ${lastTurn.turn} 楼 · 数据来自 ST 自己的扫描结果</div>
    <table class="lm-table">
        <thead><tr><th>条目</th><th>原因</th><th class="lm-num">token</th></tr></thead>
        <tbody>
        ${lastTurn.injected.map(it => `<tr>
            <td>${escapeHtml(it.title || `uid ${it.uid}`)}</td>
            <td><span class="lm-reason lm-reason-${escapeHtml(it.reason)}">${escapeHtml(REASON_LABEL[it.reason] || it.reason)}</span></td>
            <td class="lm-num">${fmtTokens(it.tokens)}</td>
        </tr>`).join('')}
        </tbody>
        <tfoot><tr><td colspan="2">合计</td><td class="lm-num">${fmtTokens(lastTurn.tokens)}</td></tr></tfoot>
    </table>`;
}

function bodyNodes(ctx) {
    const nodes = ctx.state.nodes || [];
    if (!nodes.length) {
        // 演示入口只在开发者版存在，提示词也必须跟着版本走 ——
        // 否则用户版会指着一个根本不存在的按钮。
        return ctx.devBuild
            ? `<div class="lm-empty">书里还没有节点。点「灌入演示节点」立刻看效果，或开启「自动记忆」后正常聊天，
            攒够 ${ctx.settings.promptInterval} 条消息会自动总结。</div>`
            : `<div class="lm-empty">书里还没有节点。点「立刻总结未总结的消息」把已有的聊天记录总结成节点，
            或打开「自动记忆」后正常聊天 —— 每满 ${ctx.settings.promptInterval} 条消息会自动总结一次。</div>`;
    }

    // 分页（世界书同款）：长聊里节点会攒到几十条，全摊开在一列里既要滚很久、
    // 又让"最新那条"和"最早那条"混在一起。每页条数与页码存在扩展的 ui 偏好里，跨重绘保留。
    const sizes = Array.isArray(ctx.pager?.sizes) && ctx.pager.sizes.length ? ctx.pager.sizes : [10, 25, 50, 100];
    const perPage = sizes.includes(Number(ctx.pager?.perPage)) ? Number(ctx.pager.perPage) : sizes[0];
    const pages = Math.max(1, Math.ceil(nodes.length / perPage));
    const page = Math.min(pages, Math.max(1, Number(ctx.pager?.page) || 1));
    const from = (page - 1) * perPage;
    const slice = nodes.slice(from, from + perPage);

    return `
    ${castBar(ctx)}
    ${pagerBar({ page, pages, perPage, sizes, total: nodes.length, from, shown: slice.length })}
    ${slice.map(n => nodeRow(n, ctx)).join('')}
    ${pages > 1 ? pagerBar({ page, pages, perPage, sizes, total: nodes.length, from, shown: slice.length, bottom: true }) : ''}
    ${topHits(ctx)}`;
}

/**
 * 分页条：`10/page` 选择器 + 第 N/M 页 + 上一页/下一页。
 * 选项文字照 ST 世界书面板的写法（`25/page`），用户一眼就知道是什么。
 */
function pagerBar({ page, pages, perPage, sizes, total, from, shown, bottom = false }) {
    return `
    <div class="lm-pager${bottom ? ' lm-pager-bottom' : ''}">
        <select class="text_pole lm-select lm-page-size" data-lm-page-size="1" title="每页显示几条记忆节点">
            ${sizes.map(s => `<option value="${s}" ${s === perPage ? 'selected' : ''}>${s}/page</option>`).join('')}
        </select>
        <span class="lm-dim lm-page-info">第 ${page}/${pages} 页 · 显示 ${from + 1}-${from + shown} 条 / 共 ${total} 条</span>
        <span class="lm-page-nav">
            <button class="menu_button lm-mini" data-lm-page="-1" ${page <= 1 ? 'disabled' : ''} title="上一页">上一页</button>
            <button class="menu_button lm-mini" data-lm-page="1" ${page >= pages ? 'disabled' : ''} title="下一页">下一页</button>
        </span>
    </div>`;
}

/**
 * 「按角色召回」：实体召回的入口（`/lm-recall 人名` 的面板版）。
 *
 * 名字来自节点/骨架正文里的「谁在场」行，**不来自关键词** —— 这正是重点：
 * 判别力闸门会把反复出场的配角名从关键词里剔掉（频率判据对"循环登场的配角"和
 * "每回合都吐的机制词"给出同一个判决），但正文里的「谁在场」不受它影响。
 * 所以多配角轮换的聊天里，这是把"某个配角之前发生了什么"捞回来的那条路。
 */
function castBar(ctx) {
    const cast = castIndex(ctx.state);
    if (!cast.length) return '';
    const pinned = ctx.pinnedUids instanceof Set ? ctx.pinnedUids : new Set();
    return `
    <div class="lm-cast">
        <div class="lm-cast-head">按角色召回
            <span class="lm-dim">点一个名字 = 把提到 ta 的节点全部注入下一次生成（即使最近没提到 ta）；再点一次取消</span>
        </div>
        <div class="lm-cast-chips">
            ${cast.map(c => {
        // 整组都挂着才算"已召回"：召回是按名字整批进出的，
        // 组里只要还有一条没交付，这一枚就还是亮的（琥珀色 = 还挂着 / 已生效）。
        const uids = Array.isArray(c.uids) ? c.uids : [];
        const on = uids.length > 0 && uids.every(u => pinned.has(u));
        return `<button class="menu_button lm-mini lm-cast-chip${on ? ' lm-is-on' : ''}" data-lm-cast="${escapeHtml(c.name)}" data-lm-on="${on ? '1' : '0'}" title="本回合注入提到「${escapeHtml(c.name)}」的 ${c.count} 个节点${on ? '（已召回：再点一次取消）' : ''}">${escapeHtml(c.name)} <b>${c.count}</b></button>`;
    }).join('')}
        </div>
    </div>`;
}

function bodySettings(ctx) {
    const s = ctx.settings;
    const rows = Object.entries(SETTINGS_META).map(([key, meta]) => settingRow(key, meta, s[key])).join('');
    const unknown = unknownPlaceholders(s.prompt);
    const custom = isCustomPrompt(s);
    const customSkeleton = isCustomSkeletonPrompt(s);

    return `
    <div class="lm-setting-grid">${rows}</div>

    <div class="lm-prompt-block">
        <div class="lm-prompt-head">
            <span class="lm-field-label">摘要提示词 ${custom ? '<span class="lm-badge lm-badge-warn">已自定义</span>' : '<span class="lm-badge lm-badge-tier">默认</span>'}</span>
            <button class="menu_button lm-mini" data-lm-action="restore-prompt">恢复默认</button>
        </div>
        <textarea class="text_pole lm-prompt-textarea" data-lm-setting="prompt" rows="9" spellcheck="false">${escapeHtml(s.prompt)}</textarea>
        <div class="lm-hint">
            占位符：${Object.keys(PLACEHOLDERS).filter(k => k !== 'previous').map(k => `<code>{{${k}}}</code>`).join(' ')}
            —— 分别替换成「${PLACEHOLDERS.messages}」等。未知占位符会原样保留。
        </div>
        ${unknown.length ? `<div class="lm-alert lm-alert-warn">提示词里有未知占位符：${unknown.map(u => `<code>{{${escapeHtml(u)}}}</code>`).join(' ')} —— 它们不会被替换，请检查拼写。</div>` : ''}
        <div class="lm-hint">
            提示词要求模型输出 JSON（<code>title</code> / <code>keywords</code> / <code>summary</code>）。
            若你改成不输出 JSON，插件会退化成「整段当正文 + 关键词兜底抽取」，并把节点标为待确认。
        </div>
    </div>

    <div class="lm-prompt-block">
        <div class="lm-prompt-head">
            <span class="lm-field-label">骨架「现状卡」提示词 ${customSkeleton ? '<span class="lm-badge lm-badge-warn">已自定义</span>' : '<span class="lm-badge lm-badge-tier">默认</span>'}</span>
            <button class="menu_button lm-mini" data-lm-action="restore-skeleton-prompt">恢复默认</button>
        </div>
        <textarea class="text_pole lm-prompt-textarea" data-lm-setting="skeletonPrompt" rows="7" spellcheck="false">${escapeHtml(s.skeletonPrompt)}</textarea>
        <div class="lm-hint">
            支持 <code>{{messages}}</code> <code>{{words}}</code> <code>{{from}}</code> <code>{{to}}</code> <code>{{previous}}</code>。
            骨架是全书唯一常驻注入的条目，提示词要让它输出<b>当前状态</b>而不是历史流水。
        </div>
    </div>

    <div class="lm-actions lm-actions-tight">
        <button class="menu_button lm-btn" data-lm-action="refresh-skeleton"><i class="fa-solid fa-id-card"></i> 立刻刷新骨架现状卡</button>
    </div>`;
}

function bodyHelp(ctx) {
    const s = ctx.settings;
    return `
    <ol class="lm-help-list">
        <li>打开「自动记忆」，然后正常聊天。每满 <b>${s.promptInterval}</b> 条消息，插件会在后台把这一段总结成一个节点
            （会真的调用你配置的 API）。上方「未总结」会显示还差几条触发。</li>
        <li>不想等？点「立刻总结未总结的消息」${ctx.devBuild ? '，或点「灌入演示节点」' : ''}直接看结果。</li>
        <li>在聊天里发一句含某个节点关键词的话 ——「本回合注入了什么」会实时显示，附命中原因。</li>
        <li>发一句完全不含关键词的话 —— 注入量应该只剩骨架条目。这就是「平时不花钱」。</li>
        <li>把「总结时扫描哪些消息」切到「仅角色对话」再总结一次，对比节点正文里少了什么。</li>
        <li>打开 ST 的世界书面板，能看到这本书里的条目就是插件写进去的 —— <b>条目是真的，不是前端假动画</b>。</li>
    </ol>
    <table class="lm-table lm-cmd-table">
        <thead><tr><th>命令</th><th>作用</th></tr></thead>
        <tbody>
        <tr><td><code>/lm-list</code></td><td>列出所有节点</td></tr>
        <tr><td><code>/lm-now</code></td><td>立刻总结未总结的消息</td></tr>
        <tr><td><code>/lm-skeleton</code></td><td>立刻重写现状卡</td></tr>
        <tr><td><code>/lm-auto on|off</code></td><td>开关自动记忆</td></tr>
        <tr><td><code>/lm-interval 12</code></td><td>设置每多少条消息总结一次</td></tr>
        <tr><td><code>/lm-scope all|char|user</code></td><td>设置总结时扫描哪些消息</td></tr>
        <tr><td><code>/lm-pin N003</code></td><td>强制某节点在下一次生成注入（再打一次取消）；面板上「钉选」按钮同样功效，生效中会亮成琥珀色</td></tr>
        <tr><td><code>/lm-recall 魔界</code></td><td>没被提及也强行召回；关键词已经覆盖不到的词（比如被剔掉的<b>配角名</b>）自动改成按正文召回。这些"钉子"会一直挂着直到真的注入出去 —— 中间的自动摘要不会把它吃掉</td></tr>
        <tr><td><code>/lm-status</code></td><td>状态摘要</td></tr>
        <tr><td><code>/lm-clear</code></td><td>删除本书全部记忆条目</td></tr>
        </tbody>
    </table>
    <p class="lm-hint">token 数为估算值（中文按约 1.2 字/token 取保守侧，偏高），用于量级判断与预算告警，不是精确计数。
       摘要使用 ST 的<b>主 API</b>（<code>generateQuietPrompt</code>），不是你在「聊天补全」里选的那个源。</p>`;
}

/**
 * 一行节点。
 *
 * ⚠️ 分隔符规则（2026-09-19 实地核对 ST 1.18.0 后定下，别再改回去）：
 *   · **能被粘进 ST 世界书输入框的东西** 用英文逗号 —— ST 侧只认逗号：
 *     `world-info.js` L2958 明文框 `key.join(', ')`、L2887 select2 `tokenSeparators: [',']`、
 *     L2947 → L2717 `splitKeywordsAndRegexes()` 只按逗号切。
 *     以前这里用 `join('、')`，用户从插件框里复制出去的 `A、B、C` 粘进 ST 会变成**一个**关键词。
 *   · **在插件里读给人看的列表**（关键词 chip、被剔除词的提示、保存成功的 toast）保留顿号 ——
 *     那是中文散文里的顿号，不会有人去复制它。
 *   · **解析端继续兼容顿号**（见 index.js 的 saveNodeKeys）：中文用户手打顿号是本能，拒绝它是坏体验。
 */
function nodeRow(node, ctx) {
    const badge = STATUS_BADGE[node.status] || STATUS_BADGE.active;
    const tokens = node.tokens || estimateTokens(node.content);
    const skeleton = ctx.state.skeletonUid === node.uid;
    // 骨架有自己的上限设置。以前这里一律用 nodeTokenCap(200)，
    // 导致 200~350 token 的**合法**骨架被误标红，而真正的 350 上限从不起作用。
    const cap = Number(skeleton ? ctx.settings.skeletonTokenCap : ctx.settings.nodeTokenCap) || (skeleton ? 350 : 200);
    const overCap = tokens > cap;
    // 这一条是不是还钉着（钉子挂在 pinnedUids 上，交付出去才消失）→ 按钮点亮成琥珀色
    const pinnedNode = ctx.pinnedUids instanceof Set && ctx.pinnedUids.has(node.uid);

    return `
    <div class="lm-node ${node.status === 'disabled' ? 'lm-node-off' : ''}" data-lm-uid="${node.uid}">
        <div class="lm-node-head">
            <span class="lm-node-id">${escapeHtml(node.id)}</span>
            <span class="lm-node-title">${escapeHtml(node.title)}</span>
            <span class="lm-range">${node.from}-${node.to}楼</span>
            <span class="lm-badge ${badge.cls}">${badge.text}</span>
            ${skeleton ? '<span class="lm-badge lm-badge-skel">骨架</span>' : `<span class="lm-badge lm-badge-tier">${escapeHtml(TIER_LABEL[node.tier] || node.tier)}</span>`}
            ${node.source === 'llm' ? '<span class="lm-badge lm-badge-tier">AI 生成</span>' : ''}
        </div>
        <div class="lm-keys">
            ${(node.keys || []).map(k => `<span class="lm-key">${escapeHtml(k)}</span>`).join('') || '<span class="lm-dim">（无关键词 —— 该条目不会被关键词召回）</span>'}
        </div>
        ${!skeleton && (node.droppedKeys || []).length
            ? `<div class="lm-hint">已自动剔除判别力不足的关键词：${(node.droppedKeys || []).map(k => escapeHtml(k)).join('、')}（它们在别的剧情里也会命中，会造成误触发）</div>`
            : ''}
        ${!skeleton ? `<div class="lm-keys-edit" hidden><input type="text" class="text_pole lm-key-input" data-lm-keys="${node.uid}" value="${escapeHtml((node.keys || []).join(', '))}" placeholder="用英文逗号分隔（顿号也认）；留空 = 不再被关键词召回"></div>` : ''}
        <div class="lm-node-meta">
            <span class="${overCap ? 'lm-over' : ''}">${fmtTokens(tokens)} / ${cap} token</span>
            <span>命中 ${node.hits || 0} 次</span>
            ${node.lastHitAt ? `<span>最近 第${node.lastHitAt}楼</span>` : ''}
            <span class="lm-dim">uid ${node.uid}</span>
            ${!skeleton ? `<select class="text_pole lm-select lm-tier-select" data-lm-tier="${node.uid}" title="优先级档位：决定预算紧张时谁先被挤掉（main 500 / side 300 / detail 100）">
                ${['main', 'side', 'detail'].map(t => `<option value="${t}" ${node.tier === t ? 'selected' : ''}>${TIER_LABEL[t] || t}</option>`).join('')}
            </select>` : `<span class="lm-dim">order ${TIER_ORDER.skeleton}</span>`}
        </div>
        <div class="lm-node-ops">
            <button class="menu_button lm-mini lm-pin${pinnedNode ? ' lm-is-on' : ''}" data-lm-action="pin" data-lm-uid="${node.uid}" data-lm-on="${pinnedNode ? '1' : '0'}" title="${pinnedNode ? '已钉选：下一次生成必定带上它（再点一次取消）' : '强制注入一次（下一次生成生效）'}"><i class="fa-solid fa-thumbtack"></i> ${pinnedNode ? '已钉选' : '钉选'}</button>
            <button class="menu_button lm-mini" data-lm-action="toggle" data-lm-uid="${node.uid}">${node.status === 'disabled' ? '启用' : '禁用'}</button>
            <button class="menu_button lm-mini" data-lm-action="edit" data-lm-uid="${node.uid}">看正文</button>
            ${!skeleton ? `<button class="menu_button lm-mini" data-lm-action="edit-keys" data-lm-uid="${node.uid}" title="手工改关键词（改完失焦或回车保存）">改关键词</button>` : ''}
            ${(!skeleton && node.prevContent) ? `<button class="menu_button lm-mini" data-lm-action="rollback" data-lm-uid="${node.uid}" title="回滚到重摘要前的正文（再点一次可滚回来）">回滚正文</button>` : ''}
            <button class="menu_button lm-mini" data-lm-action="resummarize" data-lm-uid="${node.uid}" title="用当前提示词重新总结这一段">重摘要</button>
            <button class="menu_button lm-mini lm-mini-danger" data-lm-action="delete" data-lm-uid="${node.uid}">删除</button>
        </div>
        <div class="lm-content" hidden>${escapeHtml(node.content)}</div>
    </div>`;
}

function topHits(ctx) {
    const top = topHitNodes(ctx.state, 5);
    if (!top.length) return '';
    return `
    <div class="lm-section-sub lm-tophits-title">最常被召回的节点</div>
    <div class="lm-tophits">
        ${top.map(n => `<span class="lm-hit-chip">${escapeHtml(n.id)} ${escapeHtml(n.title)} <b>${n.hits}</b></span>`).join('')}
    </div>`;
}

function settingRow(key, meta, value) {
    const attr = `data-lm-setting="${key}"`;
    let control;
    if (meta.type === 'boolean') {
        control = `<input type="checkbox" ${attr} ${value ? 'checked' : ''}>`;
    } else if (meta.type === 'number') {
        control = `<input type="number" class="text_pole lm-num-input" ${attr} value="${escapeHtml(String(value))}" min="${meta.min}" max="${meta.max}" step="${meta.step}">`;
    } else if (meta.type === 'select') {
        control = `<select class="text_pole lm-select" ${attr}>${meta.options.map(([v, t]) =>
            `<option value="${escapeHtml(v)}" ${v === value ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}</select>`;
    } else {
        control = `<input type="text" class="text_pole" ${attr} value="${escapeHtml(String(value))}">`;
    }
    return `
    <div class="lm-set-row">
        <label class="lm-set-label">${escapeHtml(meta.label)}</label>
        <div class="lm-set-control">${control}</div>
        ${meta.hint ? `<div class="lm-hint lm-set-hint">${escapeHtml(meta.hint)}</div>` : ''}
    </div>`;
}

// ───────────────────────── 「管理聊天书」弹窗 ─────────────────────────

/**
 * 弹窗 HTML（纯函数，离线可测）。
 *
 * 为什么是**独立于面板的浮层**而不是又一个 inline-drawer：
 *   面板本身在 ST 的「扩展程序」抽屉里，而那个抽屉是个 CSS 抽屉（祖先可能是 display:none），
 *   在里面塞长列表会被裁掉；世界书列表 + 条目正文是**要能滚动查看**的内容，必须挂在 body 上。
 *
 * 数据全部由调用方备好（本文件不碰 ST）：
 *   books    [{ name, count, tokens, active, plugin, missing }]
 *            active = 当前聊天绑定的那本；plugin = 名字以 LM- 开头（插件建的，可删）
 *   expanded 展开的书名（null = 都收起）
 *   entries  展开那本的条目 [{ uid, comment, keys, content, constant, disable, order, tokens }]
 *   collapsedGroups  收起的角色卡分组名（[] = 全展开）
 *
 * 所有交互都靠 data-lm-book-* / data-lm-group-* 属性，由 index.js 在弹窗容器上做事件委托 ——
 * 整块重绘后不需要重新绑定监听器（和面板同一个套路）。
 */
export function booksModalHtml(opts = {}) {
    const books = Array.isArray(opts.books) ? opts.books : [];
    const expanded = opts.expanded || null;
    const entries = Array.isArray(opts.entries) ? opts.entries : [];
    const busy = !!opts.busy;
    const dis = busy ? ' disabled' : '';
    const mine = books.filter(b => b.plugin).length;
    const groups = groupBooks(books);
    // `collapsedGroups === null/undefined` = 用户还没动过 ⇒ **所有分组默认折叠**。
    // 一屏几十本同名角色卡的书铺开来根本找不到东西，先给"有哪几张卡"的概览。
    // 显式给数组时按数组来（展开过的组不在里面 ⇒ 保持展开）。
    const collapsedOpt = opts.collapsedGroups;
    const collapsed = new Set(Array.isArray(collapsedOpt) ? collapsedOpt : groups.map(g => g.name));

    const body = books.length
        ? groups.map(g => bookGroupHtml(g, expanded, entries, collapsed.has(g.name))).join('')
        : '<div class="lm-empty">还没有插件建过的聊天书。点上面的「新增聊天书」，或回到面板点「启用记忆（建书并绑定）」。</div>';

    return `
    <div class="lm-modal-backdrop" data-lm-book-close="1"></div>
    <div class="lm-modal-card" role="dialog" aria-modal="true" aria-label="管理聊天书">
        <div class="lm-modal-head">
            <span class="lm-modal-title"><i class="fa-solid fa-book-bookmark"></i> 管理聊天书</span>
            <button class="menu_button lm-mini lm-modal-close" data-lm-book-close="1" title="关闭"><i class="fa-solid fa-xmark"></i><span class="lm-close-label">关闭</span></button>
        </div>
        <div class="lm-modal-summary lm-dim">${mine} 本插件建的${opts.activeName ? ` · 当前绑定 <code>${escapeHtml(opts.activeName)}</code>` : ' · 当前聊天未绑定'}</div>
        <div class="lm-modal-tools">
            <button class="menu_button lm-btn" data-lm-book-new="1"${dis}><i class="fa-solid fa-plus"></i> 新增聊天书</button>
            <button class="menu_button lm-btn" data-lm-action="cleanup-books"${dis}><i class="fa-solid fa-broom"></i> 清理空书</button>
            <span class="lm-dim lm-modal-tools-hint">新增＝给当前聊天再建一本 <code>LM-</code> 书并绑定</span>
        </div>
        <div class="lm-modal-body">
            ${opts.error ? `<div class="lm-alert">${escapeHtml(opts.error)}</div>` : ''}
            ${busy && !books.length ? '<div class="lm-empty">正在读取…</div>' : body}
        </div>
        <div class="lm-modal-foot lm-hint">
            删除不可撤销（世界书文件会被直接删掉）。标「当前聊天」的那本正在被这个聊天使用，删它等于把当前聊天的记忆一起删掉。
            「清理空书」只删<b>名字以 <code>LM-</code> 开头、里面一条条目都没有、且当前聊天没绑定</b>的书 —— 有内容的一律不动。
            早期版本会把 ST 的欢迎屏（选角色卡那一屏）误当成聊天，每次刷新建一本空书，那些垃圾书就用它收拾。
            ${opts.devBuild ? '<br>（开发者版：这些书里可能有「灌入演示节点」写进去的内置剧本。）' : ''}
        </div>
    </div>`;
}

/**
 * 从书名推出「同一张角色卡」的分组名。
 *
 * 书名的形状是 `LM-<角色卡名>-<聊天片段>`（见 index.js 的 ensureBook），重名时 ST 会补 `(2)`。
 * 取 `LM-` 之后、**第一个 `-`** 之前的那一段：
 *   `LM-林晚-林晚 - 202 (1)`                        → 林晚
 *   `LM-无限精力驱魔师·百鬼淫行录-无限精力驱魔师· (2)` → 无限精力驱魔师·百鬼淫行录
 *
 * ⚠ 这里是**第一个** `-`，不是最后一个 —— 这一点是照着实机截图改回来的：
 * 聊天 id 常常长成 `<角色名> - <日期>`（ST 给聊天文件起的名字），前 8 位里就带着 ` - `，
 * 于是"最后一个 `-`"会把分组名切在日期那一段上，界面上显示成 `林晚-林晚`。
 * 代价是角色卡名自己带 `-` 时会被切短（没有别处存角色名，这是这套命名下能做的最好推断）；
 * 但"聊天 id 里有连字符"比"角色名里有连字符"常见得多，所以选第一个。
 * 切不出来（不是 LM- 开头、或没有 `-`）时整本自成一组。
 */
export function bookGroupKey(name) {
    const s = String(name ?? '').trim();
    if (!s) return '(未命名)';
    if (!s.startsWith('LM-')) return s;
    const rest = s.slice(3);
    const cut = rest.indexOf('-');
    return (cut > 0 ? rest.slice(0, cut) : rest) || s;
}

/** 按角色卡分组（保持原有顺序：同一组的书必然是相邻的，因为名字前缀相同） */
export function groupBooks(books) {
    const map = new Map();
    for (const b of Array.isArray(books) ? books : []) {
        const key = bookGroupKey(b?.name);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(b);
    }
    return [...map.entries()].map(([name, list]) => ({ name, books: list }));
}

/** 一个角色卡分组：可折叠。同一张卡下聊过好几次时，书会越攒越多，全摊开会看不到头 */
function bookGroupHtml(g, expanded, entries, collapsed) {
    const key = escapeHtml(g.name);
    const count = g.books.length;
    const entryCount = g.books.reduce((n, b) => n + (Number(b.count) || 0), 0);
    const tokens = g.books.reduce((n, b) => n + (Number(b.tokens) || 0), 0);
    const hasActive = g.books.some(b => b.active);
    const allEmpty = g.books.every(b => (Number(b.count) || 0) === 0);
    return `
    <div class="lm-book-group${collapsed ? ' lm-collapsed' : ''}" data-lm-group="${key}">
        <div class="lm-group-head" data-lm-group-toggle="${key}" title="同一张角色卡下的聊天书收在这里，点一下折叠/展开">
            <i class="fa-solid fa-circle-chevron-${collapsed ? 'down' : 'up'}"></i>
            <span class="lm-group-name">${key}</span>
            ${hasActive ? '<span class="lm-badge lm-badge-ok">当前聊天在这组</span>' : ''}
            ${allEmpty ? '<span class="lm-badge lm-badge-warn">都是空书</span>' : ''}
            <span class="lm-dim">${count} 本 · ${entryCount} 条目 · ${fmtTokens(tokens)} token</span>
        </div>
        <div class="lm-group-body">
            ${g.books.map(b => bookRow(b, expanded, entries)).join('')}
        </div>
    </div>`;
}

/** 一本书一行：书名 + 状态徽标 + 操作按钮（展开时把条目正文接在后面） */
function bookRow(b, expanded, entries) {
    const name = escapeHtml(b.name);
    const isOpen = expanded === b.name;
    return `
    <div class="lm-book-row${b.active ? ' lm-book-active' : ''}" data-lm-book="${name}">
        <div class="lm-book-head">
            <span class="lm-book-name">${name}</span>
            ${b.active ? '<span class="lm-badge lm-badge-ok">当前聊天</span>' : ''}
            ${b.plugin ? '' : '<span class="lm-badge lm-badge-tier">不是插件建的</span>'}
            ${b.missing ? '<span class="lm-badge lm-badge-warn">磁盘上没有</span>' : ''}
            <span class="lm-dim">${Number(b.count) || 0} 条目 · ${fmtTokens(Number(b.tokens) || 0)} token</span>
        </div>
        <div class="lm-node-ops">
            <button class="menu_button lm-mini" data-lm-book-view="${name}">${isOpen ? '收起内容' : '查看内容'}</button>
            ${b.active ? '' : `<button class="menu_button lm-mini" data-lm-book-bind="${name}" title="把这本世界书绑定到当前聊天（聊天书只有一个槽位，会替换现在的绑定）">绑定到当前聊天</button>`}
            <button class="menu_button lm-mini" data-lm-book-open="${name}" title="在 ST 自带的世界书面板里打开">在 ST 面板打开</button>
            ${b.plugin ? `<button class="menu_button lm-mini lm-mini-danger" data-lm-book-del="${name}">删除</button>` : ''}
        </div>
        ${isOpen ? bookEntriesHtml(entries) : ''}
    </div>`;
}

/** 展开后的条目清单：uid、标题、关键词、开关状态、正文 */
function bookEntriesHtml(entries) {
    if (!entries.length) return '<div class="lm-empty lm-book-entries">这本书里一条条目都没有（空书）。</div>';
    return `<div class="lm-book-entries">
        ${entries.map(e => `
        <div class="lm-book-entry">
            <div class="lm-node-head">
                <span class="lm-node-id">uid ${escapeHtml(String(e.uid))}</span>
                <span class="lm-node-title">${escapeHtml(e.comment || '(无标题)')}</span>
                ${e.constant ? '<span class="lm-badge lm-badge-skel">常驻</span>' : ''}
                ${e.disable ? '<span class="lm-badge lm-badge-off">已禁用</span>' : ''}
                <span class="lm-dim">${fmtTokens(Number(e.tokens) || 0)} token · order ${escapeHtml(String(e.order ?? ''))}</span>
            </div>
            ${(e.keys || []).length
            ? `<div class="lm-keys">${(e.keys || []).map(k => `<span class="lm-key">${escapeHtml(k)}</span>`).join('')}</div>`
            : '<div class="lm-dim">（没有关键词：靠常驻或手动钉选注入）</div>'}
            <div class="lm-content">${escapeHtml(e.content || '')}</div>
        </div>`).join('')}
    </div>`;
}
