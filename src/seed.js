/**
 * 演示剧本数据（纯数据，无 import）
 *
 * 为什么演示版要内置剧本：
 * 真实节点是「聊满 12 楼后台自动摘要」攒出来的，用户第一次打开插件时书里是空的 ——
 * 看不见任何效果。所以演示版提供「灌入演示节点」，一次性把一整段故事的记忆写好，
 * 让用户立刻能靠打字触发关键词、看到真实的注入与账本。
 *
 * 注意：这些节点写进书里之后就是**真的世界书条目**，走的是 ST 原生扫描/预算/注入，
 * 不是前端假动画。所以演示出来的效果与正式版一致。
 */

export const DEMO_CHARACTER = '林晚';

/** 骨架条目（现状卡）——每 K 楼重写的"永不丢失的当前状态" */
export const DEMO_SKELETON = `【现状卡 · 当前阶段：魔界狩猎场归来】
在场：{{user}}、林晚（左臂缠血誓绷带）、精灵向导·缇娜（临时同行）
地点：回程途中 · 断桥驿站（距王都两日脚程）
状态变化：林晚以十年寿命换取"血誓"击退魔将；缇娜的盟约仍未解除；断刃·青冥出现裂纹。
未结钩子：① 血誓的代价尚未开始显现代价 ② 黑市情报人"独眼"手里还有半张狩猎场地图 ③ 缇娜为何知道青冥剑的来历
关键设定：魔界狩猎场每七年开一次；血誓一旦立下不可撤销，只能转移给他人。`;

/**
 * 演示节点。字段：id/title/from/to/keys/content/tier/hot
 * - tier 决定 order 阶梯（main 500 / side 300 / detail 100）
 * - hot=true 的节点会被设上条目级 scanDepth，提升召回（不动全局设置）
 *
 * ⚠️ 关键词设计的一条实测教训：**不要把主角名当关键词**。
 * ST 默认 world_info_include_names=true，扫描缓冲里每一条消息都带「角色名: 正文」前缀，
 * 所以「林晚」这种关键词等于**每回合必中**，节点永远常驻，直接毁掉"平时不花钱"这个卖点。
 * 人物名该出现在摘要正文里（那是内容），不该出现在 key 里（那是触发器）。
 * 因此下面的 key 一律选"只在相关剧情里才会被说出口"的独特词。
 */
export const DEMO_NODES = [
    {
        id: 'N001',
        title: '初遇与委托',
        from: 1,
        to: 14,
        tier: 'main',
        hot: true,
        arc: 'main',
        keys: ['委托', '断桥', '青冥剑', '赏金'],
        content: `【发生了什么】{{user}}在断桥驿站接下护送委托，雇主是被追杀的剑客林晚。首夜遭遇三名蒙面刺客，林晚以断刃·青冥独战，{{user}}替她挡下一箭。
【谁在场】{{user}}、林晚、驿站老板老周
【状态变化】{{user}}左肩中箭（轻伤）；林晚承认自己"被王都通缉"；青冥剑第一次显形——剑身有暗纹，出鞘时空气变冷。
【未结钩子】刺客的袖口有魔界纹章；老周递来的信上写着"独眼等你"。
【关键设定】青冥剑认主，非其主者持之则灼手。`,
    },
    {
        id: 'N002',
        title: '黑市与独眼情报人',
        from: 15,
        to: 28,
        tier: 'side',
        arc: 'main',
        keys: ['黑市', '独眼', '情报', '地图', '纹章'],
        content: `【发生了什么】两人潜入地下黑市找情报人"独眼"。独眼认出青冥剑，说出魔界狩猎场七年一开的秘密，并交付出半张狩猎场地图——代价是{{user}}替他送一封信。
【谁在场】{{user}}、林晚、独眼（左眼覆铁片）
【状态变化】获得半张狩猎场地图；林晚的身世出现裂缝——独眼称她"缇娜小姐的旧识"。
【未结钩子】另外半张地图仍在独眼手里；他送的那封信收件人不明。
【关键设定】魔界狩猎场只在地脉薄弱处开启，入口由精灵族看守。`,
    },
    {
        id: 'N003',
        title: '魔界狩猎场初战',
        from: 29,
        to: 40,
        tier: 'main',
        hot: true,
        arc: 'hunt',
        keys: ['魔界', '狩猎场', '魔将', '血誓', '缇娜', '精灵'],
        content: `【发生了什么】两人随独眼给的地图进入魔界狩猎场，遭魔将"犄角"伏击。林晚重伤，为救{{user}}立下血誓，以十年寿命换取一击之力，斩落魔将右角。
【谁在场】{{user}}、林晚、魔将犄角、精灵向导缇娜（战场中现身）
【状态变化】林晚立血誓，左臂浮现血色纹路；缇娜以"解除盟约"为条件替两人断后；魔将犄角逃入深处。
【未结钩子】血誓的代价（十年寿命）尚未开始显现；犄角未死，扬言"在深处等你们"。
【关键设定】血誓一旦立下不可撤销，只能转移给自愿承受者。`,
    },
    {
        id: 'N004',
        title: '精灵盟约',
        from: 41,
        to: 52,
        tier: 'main',
        arc: 'hunt',
        keys: ['缇娜', '盟约', '精灵', '地脉', '青冥'],
        content: `【发生了什么】缇娜带两人进入精灵看守的地脉裂隙，说明她认识青冥剑的上一任主人。三人在祭坛前立下临时盟约，换取通行权。
【谁在场】{{user}}、林晚、缇娜、地脉守卫
【状态变化】盟约以{{user}}的一滴血为证，缇娜成为临时同行者；青冥剑在地脉中发出共鸣，剑身裂纹加深。
【未结钩子】缇娜始终不肯说出青冥剑上一任主人的名字；盟约的解约条件被缇娜含糊带过。
【关键设定】地脉共鸣会削弱魔界生物，但也会让持有青冥剑的人陷入幻觉。`,
    },
    {
        id: 'N005',
        title: '归途与代价',
        from: 53,
        to: 66,
        tier: 'side',
        arc: 'return',
        keys: ['归途', '断桥驿站', '血誓', '代价', '绷带'],
        content: `【发生了什么】三人退出狩猎场回到断桥驿站。林晚的血誓纹路开始蔓延到肩胛，第一次出现"记忆空缺"——她忘了{{user}}替她挡箭那一夜。
【谁在场】{{user}}、林晚、缇娜、老周
【状态变化】林晚的记忆开始被血誓蚕食；缇娜明确表示盟约在进入王都前必须解除；老周带来王都的追捕令。
【未结钩子】追捕令上的画像同时有林晚和{{user}}；缇娜的盟约解除需要"等价交换"。
【关键设定】血誓的代价按"记忆—情感—寿命"顺序蚕食，不可逆。`,
    },
];

/**
 * 关键词命中质量自检（演示版简化版，对应需求文档 FR-14）。
 * 风险 R2：中文短词（如"剑"）误命中率高。这里给出廉价、字面、不可欺骗的判据。
 * @param {string[]} keys
 * @returns {{level:'ok'|'warn', messages:string[]}}
 */
export function checkKeys(keys) {
    const messages = [];
    const list = (keys || []).filter(Boolean);
    if (!list.length) messages.push('关键词为空：该节点永远不会被关键词召回');
    if (list.length > 8) messages.push(`关键词 ${list.length} 个，偏多（建议 3–8），易互相挤占预算`);
    for (const k of list) {
        if (k.length <= 1) messages.push(`关键词「${k}」只有 1 个字，中文误命中率极高`);
    }
    // 单字/双字超高频词
    const tooCommon = ['剑', '刀', '人', '他', '我', '你', '这里', '那里', '什么', '一个'];
    for (const k of list) {
        if (tooCommon.includes(k)) messages.push(`关键词「${k}」是超高频词，几乎每回合都会命中`);
    }
    return { level: messages.length ? 'warn' : 'ok', messages };
}

/** 判别力阈值：关键词在「本节点区间之外」的消息里出现率超过它 → 判为误触发源 */
export const KEY_OUTSIDE_RATIO_MAX = 0.25;

/** 全局出现率上限：超过它的词几乎每回合都在 → 与区间无关，一律判死 */
export const KEY_OMNIPRESENT_RATIO_MAX = 0.5;

/**
 * 比率必须配最小绝对次数 —— 这是 E2E 抓出来的一个真实缺陷。
 *
 * 只有 6 楼的聊天里，一个词在区间外出现 **1 次**就是 1/4 = 25%，正好撞上阈值被误剔：
 * driver 的「兜底抽词」用例断言 `魔界狩猎场` 应该保留，结果被我第一版闸门判死了。
 * 比率在**小样本上会被放大**，所以"到处都命中"至少要命中 2 次，
 * "铺满全篇"至少要有 3 次出现才算数。
 */
export const KEY_OUTSIDE_MIN_COUNT = 2;
export const KEY_OMNIPRESENT_MIN_COUNT = 3;

/**
 * 关键词判别力自检（FR-14 的第二层，来自真实案例）。
 *
 * 为什么 `checkKeys` 不够：它只看"这个词本身可不可疑"（1 个字 / 10 词黑名单），
 * 而真实误触发是**统计事实** —— 有些词本身很正常，但在整条聊天里到处都是。
 *
 * 实测案例（41 楼真实聊天 + deepseek-flash）：14 个关键词里只有 2 个是元凶 ——
 * 「敏感度」22/41 = **54%**、「淫乱度」20/41 = **49%**，其余 12 个多在 1/41。
 * 这两个词被 N002/N003/N004 **共用**，于是任一出现就同时点亮三个节点
 * = **367 token/回合**，与当前剧情完全无关。
 * 根因：那张角色卡强制模型每回合输出含这两个词的数值块 ——
 * "每回合都会出现的词"被当成了关键词。这与插件早就记过的教训
 * （不要把主角名当关键词，因为发言人名每回合都在）是**同一类错误**，只是来源不同。
 *
 * 判据刻意用**区间外出现率**而不是全局出现率：一个词只要只在自己那段剧情里出现，
 * 它就是好关键词 —— 例：「小夜灯」9/41，但全部落在 N004 的 32-41 楼 → 必须保留。
 *
 * @param {string[]} keys
 * @param {Array<{mes?:string}>} messages
 * @param {{from?:number, to?:number}} range 1 基闭区间（节点自己的楼层）
 */
export function keyStats(keys, messages, range) {
    const list = (messages || []).filter(m => m && typeof m.mes === 'string');
    const total = list.length;
    const from = Math.max(1, Number(range && range.from) || 1);
    const to = Math.min(total || 0, Number(range && range.to) || total);
    const span = Math.max(0, to - from + 1);
    const outsideTotal = Math.max(0, total - span);

    return (keys || []).map(key => {
        const k = String(key);
        let all = 0;
        let inside = 0;
        list.forEach((m, i) => {
            if (!m.mes.includes(k)) return;
            all++;
            if (i + 1 >= from && i + 1 <= to) inside++;
        });
        const outside = all - inside;
        return {
            key: k,
            all, inside, outside, total, outsideTotal,
            outsideRatio: outsideTotal ? outside / outsideTotal : 0,
            allRatio: total ? all / total : 0,
        };
    });
}

/**
 * 剔除判别力不足的关键词。
 * @returns {{keep:string[], dropped:Array<{key:string,reason:'omnipresent'|'outside'}>, stats:Array}}
 */
export function dropIndiscriminativeKeys(keys, messages, range, opts = {}) {
    const outsideMax = Number(opts.outsideRatioMax) || KEY_OUTSIDE_RATIO_MAX;
    const omniMax = Number(opts.omnipresentRatioMax) || KEY_OMNIPRESENT_RATIO_MAX;
    const outsideMin = Number(opts.outsideMinCount) || KEY_OUTSIDE_MIN_COUNT;
    const omniMin = Number(opts.omnipresentMinCount) || KEY_OMNIPRESENT_MIN_COUNT;

    const stats = keyStats(keys, messages, range);
    const keep = [];
    const dropped = [];
    for (const s of stats) {
        // 比率 + 最小次数双条件：小样本里 1/4 也是 25%，不能凭这个判死一个好词
        if (s.all >= omniMin && s.allRatio >= omniMax) dropped.push({ ...s, reason: 'omnipresent' });
        else if (s.outside >= outsideMin && s.outsideRatio >= outsideMax) dropped.push({ ...s, reason: 'outside' });
        else keep.push(s.key);
    }
    return { keep, dropped, stats };
}
