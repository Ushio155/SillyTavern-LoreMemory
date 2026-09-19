/**
 * 打包：同一份源码 → 两个版本（release/）
 *
 *   node build.mjs            产出 release/SillyTavern-LoreMemory      （面向用户版）
 *                             和 release/SillyTavern-LoreMemory-dev  （开发者版）
 *   node build.mjs --check    只比对、不写盘：release/ 里的产物是否和当前源码一致
 *                             （.lorememory-test/check-build.mjs 用的就是这个）
 *
 * 为什么要有这个脚本：
 *   两个版本的区别只有三处 —— src/build.js 的开关、manifest 的版本号/显示名、
 *   README 顶部的一句版本说明。手改三份文件必然漂移（改了代码忘了重打包），
 *   所以产物一律由脚本生成，--check 负责在测试里把漂移抓出来。
 *
 * 产物**不要手改** —— 下一次 build 会整目录覆盖。
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const RELEASE_DIR = join(HERE, 'release');
export const USER_DIR = join(RELEASE_DIR, 'SillyTavern-LoreMemory');
export const DEV_DIR = join(RELEASE_DIR, 'SillyTavern-LoreMemory-dev');

/** 打进包里的文件（相对插件目录）。显式列清单：写漏一个就是"用户装上就报错"。 */
function sourceFiles() {
    const src = readdirSync(join(HERE, 'src'))
        .filter(f => f.endsWith('.js'))
        .sort()
        .map(f => `src/${f}`);
    return ['manifest.json', 'index.js', 'lorememory.css', 'README.md', 'LICENSE', 'AI-DISCLOSURE.md', ...src];
}

const DEV_FLAG_LINE = 'export const DEVELOPER_BUILD = true;';
const DEV_FLAG_USER_LINE = 'export const DEVELOPER_BUILD = false;';

const USER_README_NOTE = `> ⚠️ **这份是「面向用户版」**：没有「灌入演示节点」（那是开发者版用来调试的内置剧本）。
> 下文凡是提到「灌入演示节点 / \`/lm-seed\`」的地方都只适用于开发者版；
> 这个包的对应入口是 **「管理聊天书」** —— 列出插件建过的聊天书，看内容 / 新增 / 删除。

`;

/**
 * 渲染一份产物：返回 Map<相对路径, 文件内容>。不碰磁盘 —— 所以既能写盘，也能拿来做 --check 比对。
 * @param {'user'|'dev'} variant
 */
export function renderBuild(variant) {
    const devManifest = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8'));
    const baseVersion = String(devManifest.version).replace(/-dev$/, '');
    const baseName = String(devManifest.display_name).replace(/（开发者版）/, '');

    const manifest = variant === 'user'
        ? { ...devManifest, display_name: baseName, version: baseVersion }
        : { ...devManifest, display_name: `${baseName}（开发者版）`, version: `${baseVersion}-dev` };

    const out = new Map();
    for (const rel of sourceFiles()) {
        let text = readFileSync(join(HERE, rel), 'utf8');

        if (rel === 'src/build.js') {
            if (!text.includes(DEV_FLAG_LINE)) {
                throw new Error(`src/build.js 里找不到构建开关那一行（${DEV_FLAG_LINE}）—— 开关被改写过了？`);
            }
            if (variant === 'user') text = text.replace(DEV_FLAG_LINE, DEV_FLAG_USER_LINE);
        }

        if (rel === 'manifest.json') {
            text = `${JSON.stringify(manifest, null, 4)}\n`;
        }

        if (rel === 'README.md' && variant === 'user') {
            text = USER_README_NOTE + text;
        }

        out.set(rel, text);
    }
    return out;
}

/** 产物放进 release/ 时用的目录名 */
export function buildDir(variant) {
    return variant === 'user' ? USER_DIR : DEV_DIR;
}

function writeVariant(variant) {
    const dir = buildDir(variant);
    rmSync(dir, { recursive: true, force: true });
    for (const [rel, text] of renderBuild(variant)) {
        const dest = join(dir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, text);
    }
    return dir;
}

/** --check：逐文件比对 release/ 与"现在重新生成会得到什么" */
export function checkRelease() {
    const problems = [];
    for (const variant of ['user', 'dev']) {
        const dir = buildDir(variant);
        if (!existsSync(dir)) {
            problems.push(`${relative(HERE, dir)} 不存在（没跑过 node build.mjs？）`);
            continue;
        }
        const rendered = renderBuild(variant);
        for (const [rel, want] of rendered) {
            const p = join(dir, rel);
            if (!existsSync(p)) { problems.push(`${relative(HERE, p)} 缺失`); continue; }
            const got = readFileSync(p, 'utf8');
            if (got !== want) problems.push(`${relative(HERE, p)} 与源码不一致（源码改了但没重新打包？）`);
        }
        // 反向：产物里有源码清单之外的文件（手改/手加的东西留在了包里）
        const walked = [];
        const walk = (d) => {
            for (const e of readdirSync(d, { withFileTypes: true })) {
                const p = join(d, e.name);
                if (e.isDirectory()) walk(p);
                else walked.push(relative(dir, p).replaceAll('\\', '/'));
            }
        };
        walk(dir);
        for (const rel of walked) {
            if (!rendered.has(rel)) problems.push(`${relative(HERE, dir)}/${rel} 是多余文件（不在打包清单里）`);
        }
    }
    return problems;
}

const RELEASE_README = `# release/ —— 打包产物（不要手改）

这两份目录由插件根目录的 \`build.mjs\` 生成，源码只有一份（就是上一级目录）。

| 目录 | 版本 | 说明 |
|---|---|---|
| \`SillyTavern-LoreMemory/\` | 面向用户版 | 没有「灌入演示节点」，功能入口是「管理聊天书」 |
| \`SillyTavern-LoreMemory-dev/\` | 开发者版 | 多一个整行的「灌入演示节点」与 \`/lm-seed\`（内置剧本，调试用） |

重新生成：\`node build.mjs\`（在插件目录下）。校验产物是否与源码一致：\`node build.mjs --check\`。

安装：把**其中一份**整个文件夹拷进 ST 的扩展目录 ——
全局安装在 \`<ST>/public/scripts/extensions/third-party/\`，
单用户安装在 \`<ST>/data/<用户名>/extensions/\`（后者优先）。

⚠️ 两个版本**不要同时安装**：它们用的是同一个 \`extension_settings.LoreMemory\` 与同一份
\`chat_metadata\` 状态，同时加载会出现两个面板抢同一份数据。
`;

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('--check')) {
        const problems = checkRelease();
        if (problems.length) {
            console.error(`产物与源码不一致（${problems.length} 处）：`);
            for (const p of problems) console.error(`  · ${p}`);
            console.error('\n修法：在插件目录下跑 node build.mjs');
            process.exitCode = 1;
            return;
        }
        console.log('release/ 产物与源码一致（两份包都逐文件核对通过）');
        return;
    }

    rmSync(RELEASE_DIR, { recursive: true, force: true });
    const user = writeVariant('user');
    const dev = writeVariant('dev');
    writeFileSync(join(RELEASE_DIR, 'README.md'), RELEASE_README);

    const manifest = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8'));
    console.log('已打包：');
    console.log(`  ${user}   版本 ${String(manifest.version).replace(/-dev$/, '')}（面向用户版，无演示入口）`);
    console.log(`  ${dev}   版本 ${manifest.version}（开发者版，含演示入口）`);
    console.log(`  文件数：${renderBuild('user').size}`);
    console.log('\n提示：两个版本不要同时装进同一个 ST —— 它们共用同一份设置与聊天状态。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
