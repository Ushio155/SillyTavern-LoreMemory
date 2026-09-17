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
import { REASON_LABEL, TIER_LABEL } from './entry.js';
import { avgInjectedTokens, topHitNodes } from './store.js';
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
                <span class="lm-badge-demo">DEMO</span>
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

function actions(ctx) {
    const { state, bookExists } = ctx;
    if (!bookExists) {
        return `<div class="lm-actions">
            <button class="menu_button lm-btn lm-btn-primary" data-lm-action="enable"><i class="fa-solid fa-plug"></i> 启用记忆（建书并绑定）</button>
        </div>`;
    }
    return `
    <div class="lm-actions">
        <button class="menu_button lm-btn" data-lm-action="summarize"><i class="fa-solid fa-wand-magic-sparkles"></i> 立刻总结未总结的消息</button>
        <button class="menu_button lm-btn" data-lm-action="seed" ${state.demo ? 'disabled' : ''}><i class="fa-solid fa-flask"></i> ${state.demo ? '演示节点已灌入' : '灌入演示节点'}</button>
        <button class="menu_button lm-btn" data-lm-action="refresh"><i class="fa-solid fa-rotate"></i> 刷新</button>
        <button class="menu_button lm-btn lm-btn-danger" data-lm-action="clear"><i class="fa-solid fa-broom"></i> 清空记忆</button>
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
        return `<div class="lm-empty">书里还没有节点。点「灌入演示节点」立刻看效果，或开启「自动记忆」后正常聊天，
            攒够 ${ctx.settings.promptInterval} 条消息会自动总结。</div>`;
    }
    return nodes.map(n => nodeRow(n, ctx)).join('') + topHits(ctx);
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
    </div>

    <div class="lm-prompt-block">
        <div class="lm-field-label">维护</div>
        <div class="lm-hint">
            早期版本会把 ST 的欢迎屏（选角色卡那一屏）误当成聊天，每次刷新都建一本空书。
            建书的逻辑已经修好，但那些空书还留在世界里：「清理空书」只删
            <b>名字以 <code>LM-</code> 开头、里面一条条目都没有、且当前聊天没绑定</b>的书，有内容的一律不动。
        </div>
        <div class="lm-actions lm-actions-tight">
            <button class="menu_button lm-btn" data-lm-action="cleanup-books"><i class="fa-solid fa-broom"></i> 清理空书</button>
        </div>
    </div>`;
}

function bodyHelp(ctx) {
    const s = ctx.settings;
    return `
    <ol class="lm-help-list">
        <li>打开「自动记忆」，然后正常聊天。每满 <b>${s.promptInterval}</b> 条消息，插件会在后台把这一段总结成一个节点
            （会真的调用你配置的 API）。上方「未总结」会显示还差几条触发。</li>
        <li>不想等？点「立刻总结未总结的消息」，或点「灌入演示节点」直接看结果。</li>
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
        <tr><td><code>/lm-pin N003</code></td><td>强制某节点本回合注入一次</td></tr>
        <tr><td><code>/lm-recall 魔界</code></td><td>没被提及也强行召回</td></tr>
        <tr><td><code>/lm-status</code></td><td>状态摘要</td></tr>
        <tr><td><code>/lm-clear</code></td><td>删除本书全部记忆条目</td></tr>
        </tbody>
    </table>
    <p class="lm-hint">token 数为估算值（中文按约 1.2 字/token 取保守侧，偏高），用于量级判断与预算告警，不是精确计数。
       摘要使用 ST 的<b>主 API</b>（<code>generateQuietPrompt</code>），不是你在「聊天补全」里选的那个源。</p>`;
}

function nodeRow(node, ctx) {
    const badge = STATUS_BADGE[node.status] || STATUS_BADGE.active;
    const tokens = node.tokens || estimateTokens(node.content);
    const cap = Number(ctx.settings.nodeTokenCap) || 200;
    const overCap = tokens > cap;
    const skeleton = ctx.state.skeletonUid === node.uid;

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
        <div class="lm-node-meta">
            <span class="${overCap ? 'lm-over' : ''}">${fmtTokens(tokens)} / ${cap} token</span>
            <span>命中 ${node.hits || 0} 次</span>
            ${node.lastHitAt ? `<span>最近 第${node.lastHitAt}楼</span>` : ''}
            <span class="lm-dim">uid ${node.uid}</span>
        </div>
        <div class="lm-node-ops">
            <button class="menu_button lm-mini" data-lm-action="pin" data-lm-uid="${node.uid}" title="强制注入一次（本回合生效）"><i class="fa-solid fa-thumbtack"></i> 钉选</button>
            <button class="menu_button lm-mini" data-lm-action="toggle" data-lm-uid="${node.uid}">${node.status === 'disabled' ? '启用' : '禁用'}</button>
            <button class="menu_button lm-mini" data-lm-action="edit" data-lm-uid="${node.uid}">看正文</button>
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
