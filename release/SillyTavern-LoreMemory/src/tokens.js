/**
 * 纯函数：token 估算（零依赖，浏览器/Node 共用）
 *
 * 为什么不用 ST 的 getTokenCountAsync：
 *  - 它是 async 且依赖已加载的分词器；面板要同步渲染每一行。
 *  - 本插件只需要「量级正确」的估算来做预算告警与账本展示，不需要精确计数。
 * 面板上一律标注「估算」，避免把估算值当权威值。
 *
 * 经验系数：
 *  - CJK 汉字：约 1.2 字/token —— **故意取偏保守（偏高）的一侧**。
 *    真实值随分词器而变：中文原生模型（DeepSeek/Qwen）约 1.5–1.7 字/token，
 *    OpenAI cl100k 约 1.0–1.2 字/token。本插件的估算用于「预算告警」，
 *    低估会导致上下文被悄悄挤爆（危险），高估只是提前告警（无害），所以取保守侧。
 *  - 拉丁与数字：约 4 字符/token
 */

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;
const CJK_CHARS_PER_TOKEN = 1.2;

/**
 * 估算一段文本的 token 数。
 * @param {string} text
 * @returns {number} 估算 token 数（至少 1，空文本为 0）
 */
export function estimateTokens(text) {
    if (text === null || text === undefined) return 0;
    const s = String(text);
    if (!s.length) return 0;

    let cjk = 0;
    let other = 0;
    for (const ch of s) {
        if (CJK.test(ch)) cjk++;
        else other++;
    }
    return Math.max(1, Math.round(cjk / CJK_CHARS_PER_TOKEN + other / 4));
}

/**
 * token 上限 → 大约多少**汉字**够用。
 *
 * 用途：把「单条节点上限（token）」翻译成一个可以直接切字符串的字数上限，
 * 这样守卫不必依赖 estimateTokens 反复回算（切一次就知道够不够）。
 * 取的是保守侧（1.2 字/token），所以切出来的正文估算后**不会**超过上限。
 *
 * @param {number} tokens
 * @returns {number} 汉字数上限（至少 1）
 */
export function charsForTokens(tokens) {
    const v = Number(tokens) > 0 ? Number(tokens) : 0;
    return Math.max(1, Math.floor(v * CJK_CHARS_PER_TOKEN));
}

/**
 * 这次生成**允许模型吐多少 token** —— 一个数字同时管两件事：
 *
 *  ① 请求真实的 `max_tokens`：模型**物理上**写不出更多。这是"写小说"的硬闸 ——
 *     提示词只能"请求"模型守格式，那个是"保证"。
 *  ② ST 的预算预留：`chatCompletion.setTokenBudget(上下文, 最大回复长度)`，
 *     而 quietPrompt 属于必需消息，超预算不会丢弃而是直接抛 TokenBudgetExceededError。
 *     不声明回复长度时 ST 按**全局最大回复长度**预留 —— 用户设 4000，就为一条 200 字的
 *     摘要白扣 4000（上下文的两成半），插件的提示词只能去挤剩下的。
 *
 * 系数 2.5 token/字（≈3 倍于本文件 1.2 字/token 的估算）：目标 200 字 → 500 token。
 * 为什么留这么多余量：宁可让正文超一点（守卫会判超长并截断），也不要让 JSON 被切在半路 ——
 * 截断的 JSON 必然判为降级，反而多烧一次纠错重试。
 *
 * @param {number} words 这次生成的目标字数（节点 = promptWords，骨架 = skeletonWords）
 * @returns {number} token 上限（夹在 300–1500 之间；给 0 / NaN 时取下限）
 */
export function outputTokenBudget(words) {
    const v = Number(words) > 0 ? Number(words) : 0;
    return Math.max(300, Math.min(1500, Math.ceil(v * 2.5)));
}

/**
 * 把 token 数渲染成人读形式。
 * @param {number} n
 * @returns {string}
 */
export function fmtTokens(n) {
    const v = Number(n) || 0;
    return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}
