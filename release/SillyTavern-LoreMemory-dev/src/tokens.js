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
 * 把 token 数渲染成人读形式。
 * @param {number} n
 * @returns {string}
 */
export function fmtTokens(n) {
    const v = Number(n) || 0;
    return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}
