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

/**
 * 取一段提示词的「签名」：开头那段非空白文本，用来事后确认 ST 到底有没有把它交给模型。
 *
 * 取 40 字：短到必然落在任何模板/任何模型的提示词开头，长到不会撞上别人的文本。
 * 太短的提示词（< 8 字）返回空串 = **放弃判断**，宁可不判，也不要拿一个会误命中别的
 * 提示词的签名去冤枉宿主。
 *
 * @param {string} text 我们这次要发出去的提示词
 * @param {number} [len=40] 取多少字
 * @returns {string} 签名；空串表示无从判断
 */
export function promptSignature(text, len = 40) {
    const s = String(text ?? '').trim();
    if (s.length < 8) return '';
    const n = Math.max(8, Math.min(200, Number(len) > 0 ? Number(len) : 40));
    return s.slice(0, n);
}

/**
 * ST 交给模型的这次 chat 里，有没有我们那段提示词？
 *
 * 为什么需要它（真实故障链，ST 1.18.0，源码行号见 scripts/openai.js）：
 *  · `quietPrompt` 属于**必需消息**：它被放进 controlPrompts，并在 populateChatCompletion
 *    的**最后**才 `chatCompletion.add(controlPrompts)`（L1337）；
 *  · 预算 = `上下文 − 最大回复长度`（setTokenBudget，L1558/L3891）。扣掉角色卡、主提示词、
 *    越狱提示词之后放不下它时，`checkTokenBudget` 抛 TokenBudgetExceededError（L4104-4107）；
 *  · 而这个异常被**吞掉且不中止**：L1579-1584 只弹一句「必要的提示词超过了上下文大小」、
 *    设一下 `promptManager.error`，随后 L1607 照常把**残缺的** chat 发出去；
 *  · 于是模型收到的是"角色卡 + 聊天记录，没有归档指令" —— 它当然顺着 RP 往下写小说。
 *    插件这边 `generateQuietPrompt` 正常 resolve，看起来像一次成功的摘要。
 *
 * 这条判据把「指令根本没发出去」和「模型不听话」分开：前者重试多少次都没用，
 * 而且插件的输出守卫也无从分辨（两者都是"一段散文"）。
 *
 * @param {Array<{content?:any}>} chat `chat_completion_prompt_ready` 事件带出来的消息数组
 * @param {string} signature promptSignature() 的结果；空串 = 无从判断
 * @returns {boolean} true = 带上了；false = 这次没带上
 */
export function chatCarriesPrompt(chat, signature) {
    if (!signature) return false;
    if (!Array.isArray(chat)) return false;
    return chat.some(m => typeof m?.content === 'string' && m.content.includes(signature));
}
