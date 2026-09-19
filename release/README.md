# release/ —— 打包产物（不要手改）

这两份目录由插件根目录的 `build.mjs` 生成，源码只有一份（就是上一级目录）。

| 目录 | 版本 | 说明 |
|---|---|---|
| `SillyTavern-LoreMemory/` | 面向用户版 | 没有「灌入演示节点」，功能入口是「管理聊天书」 |
| `SillyTavern-LoreMemory-dev/` | 开发者版 | 多一个整行的「灌入演示节点」与 `/lm-seed`（内置剧本，调试用） |

重新生成：`node build.mjs`（在插件目录下）。校验产物是否与源码一致：`node build.mjs --check`。

安装：把**其中一份**整个文件夹拷进 ST 的扩展目录 ——
全局安装在 `<ST>/public/scripts/extensions/third-party/`，
单用户安装在 `<ST>/data/<用户名>/extensions/`（后者优先）。

⚠️ 两个版本**不要同时安装**：它们用的是同一个 `extension_settings.LoreMemory` 与同一份
`chat_metadata` 状态，同时加载会出现两个面板抢同一份数据。
