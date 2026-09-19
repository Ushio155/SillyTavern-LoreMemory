/**
 * 「现在到底在不在一个真聊天里」—— 建书之前必须先问这一句。
 *
 * 背景（实测 ST 1.18.0，welcome-screen.js L226 `openWelcomeScreen`）：
 * 刷新页面时如果上次没有停在某个聊天里，ST 会打开**欢迎屏**（就是"选角色卡"那一屏）。
 * 它同时具备三个特征：
 *   - `getCurrentChatId()` === undefined —— 没有聊天文件，也没有 chatId
 *   - `this_chid` === undefined —— 没选中任何角色
 *   - 但 `sendAssistantMessage()` 会往**全局 `chat` 数组**里 push 一条助手问候语
 *     （「如果您已连接到一个 API，试着问我点什么吧！」）
 *
 * 于是 `chat.length > 0` 成立。只看消息条数的话，欢迎屏会被当成一个正常聊天，
 * 插件就会给它建书并绑定 —— 而欢迎屏的 `chat_metadata` 根本不会落盘，
 * 下次刷新绑定就丢了，于是**再建一本**，如此反复：
 *
 *     LM-SillyTavern System-nocid (1).json
 *     LM-SillyTavern System-nocid (2).json
 *     ...
 *
 * 全是空书，永远绑不到任何聊天上。所以判据不能是"有没有消息"，
 * 而必须是"有没有一个真实的聊天身份"。
 */

/**
 * 当前上下文是否为一个真实的聊天（可以安全地建书 / 写记忆）。
 *
 * 判据取 `chatId`（ST 的 `getCurrentChatId()`，即 `characters[chid].chat` 或群聊的 `chat_id`）：
 * 用户在**选中角色卡的那一刻**、在 `getChat()` 之前，ST 就已经把它设成了非空字符串
 * （script.js L1417 / L1423），所以"真聊天"必然有 chatId，而欢迎屏必然没有。
 *
 * 另外再要一个"选中了什么"的证据（角色或群聊）。这是冗余保险：
 * 万一将来 ST 改了 chatId 的来源，也不会把欢迎屏放进来。
 *
 * @param {object} ctx `getContext()` 的返回值（只用到少数几个字段，便于离线单测）
 * @returns {boolean}
 */
export function isRealChatContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return false;

    const chatId = ctx.chatId;
    if (typeof chatId !== 'string' || chatId.trim() === '') return false;

    const hasCharacter = ctx.characterId !== undefined
        && ctx.characterId !== null
        && ctx.characterId !== '';
    const hasGroup = ctx.groupId !== undefined && ctx.groupId !== null && ctx.groupId !== '';

    return hasCharacter || hasGroup;
}

/**
 * 为什么不能在这里建书（给用户看的一句话）。
 * @param {object} ctx
 * @returns {string}
 */
export function noChatReason(ctx) {
    if (!ctx) return '还没有打开任何聊天';
    if (typeof ctx.chatId !== 'string' || ctx.chatId.trim() === '') {
        // 欢迎屏 / 关掉聊天后的空上下文都走这里。注意两者都可能有"消息"（欢迎屏那条问候语）。
        return '现在不在任何聊天里（ST 停在欢迎屏或还没选中角色卡），没有可绑定的聊天，插件不会建书';
    }
    return '还没有选中角色卡或群聊，插件不会建书';
}
