/**
 * 构建开关 —— 同一份源码产出两个版本
 *
 *   DEVELOPER_BUILD = true   → **开发者版**：保留「灌入演示节点」与 `/lm-seed`
 *                              （不用真的聊满 N 楼就能看到效果，调试用）
 *   DEVELOPER_BUILD = false  → **面向用户版**：演示功能整块换成「管理聊天书」
 *                              （列出插件建过的聊天书，看内容 / 新增 / 删除）
 *
 * 为什么用编译期常量而不是运行时设置：
 *   面向用户的包里**不该存在**演示入口 —— 不是"藏起来"，而是根本不存在。
 *   运行时开关（比如一个隐藏的 checkbox）会留下一个用户能打开的旁路，
 *   而演示节点是内置剧本，用户点了会往自己的书里灌一段不属于他的故事。
 *
 * 改这一行的地方只有 `build.mjs`（`node build.mjs` 会产出 release/ 下两份包）。
 * 手改这一行也可以，但改完请跑 `node .lorememory-test/check-build.mjs`：
 * 它会核对 release/ 里的产物和源码是否一致。
 */
export const DEVELOPER_BUILD = true;

/** 版本标签，只用于面板与日志（真正的版本号在 manifest.json） */
export const BUILD_LABEL = DEVELOPER_BUILD ? '开发者版' : '用户版';
