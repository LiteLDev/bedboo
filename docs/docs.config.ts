// bedboo documentation — levimc-kit site config, served at https://docs.levimc.org/bedboo/.
// English at the root, Simplified Chinese in zh/, Traditional Chinese converted from it.
import { defineDocsConfig, type NavEntry } from './kit/docs/node/config.ts';

const repo = 'https://github.com/LiteLDev/bedboo';

const root = {
  guide: 'Guide',
  reference: 'Reference',
  start: 'Getting started',
  introduction: 'Introduction',
  gettingStarted: 'Your first bot',
  using: 'Using bedboo',
  plugins: 'Ecosystem plugins',
  bedd: 'Driving a real client (BeDD)',
  agent: 'Survival agent',
  api: 'API',
  differences: 'Bedrock differences',
  overview: 'Overview',
  connection: 'Connection and versions',
  data: 'Names, ids and data',
  world: 'World and blocks',
  survival: 'Player state and survival',
  chat: 'Chat, commands and HUD',
  entities: 'Entities and players',
  movement: 'Movement and physics',
  inventory: 'Inventory and windows',
  crafting: 'Crafting and stations',
  digging: 'Digging and placing',
  pluginPatches: 'Ecosystem plugin patches',
  beddMode: 'BeDD mode',
  bdsNotes: 'BDS notes',
};
type Labels = typeof root;

const zh: Labels = {
  guide: '指南',
  reference: '参考',
  start: '入门',
  introduction: '简介',
  gettingStarted: '第一个机器人',
  using: '使用 bedboo',
  plugins: '生态插件',
  bedd: '驱动真实客户端（BeDD）',
  agent: '生存智能体',
  api: 'API',
  differences: 'Bedrock 差异',
  overview: '概览',
  connection: '连接与版本',
  data: '名称、ID 与数据',
  world: '世界与方块',
  survival: '玩家状态与生存',
  chat: '聊天、命令与 HUD',
  entities: '实体与玩家',
  movement: '移动与物理',
  inventory: '物品栏与窗口',
  crafting: '合成与工作站',
  digging: '挖掘与放置',
  pluginPatches: '生态插件补丁',
  beddMode: 'BeDD 模式',
  bdsNotes: 'BDS 备忘',
};

// The LeviMC navigation model (kit/README.md "Navigation model"): every top-level entry is a section, i.e. a header
// tab and the sidebar tree of its pages; the brand links the home page. `p` is the locale's URL prefix ('/' or '/zh/');
// zh-Hant is converted from zh by the kit.
const nav = (p: string, t: Labels): NavEntry[] => {
  const d = `${p}reference/differences/`;
  return [
    {
      text: t.guide,
      items: [
        {
          text: t.start,
          items: [
            { text: t.introduction, link: `${p}guide/introduction` },
            { text: t.gettingStarted, link: `${p}guide/getting-started` },
          ],
        },
        {
          text: t.using,
          items: [
            { text: t.plugins, link: `${p}guide/plugins` },
            { text: t.bedd, link: `${p}guide/bedd` },
            { text: t.agent, link: `${p}guide/agent` },
          ],
        },
      ],
    },
    {
      text: t.reference,
      items: [
        { text: t.api, link: `${p}reference/api` },
        { text: t.bdsNotes, link: `${p}reference/bds` },
        {
          text: t.differences,
          items: [
            { text: t.overview, link: d },
            { text: t.connection, link: `${d}connection` },
            { text: t.data, link: `${d}data` },
            { text: t.world, link: `${d}world` },
            { text: t.survival, link: `${d}survival` },
            { text: t.chat, link: `${d}chat` },
            { text: t.entities, link: `${d}entities` },
            { text: t.movement, link: `${d}movement` },
            { text: t.inventory, link: `${d}inventory` },
            { text: t.crafting, link: `${d}crafting` },
            { text: t.digging, link: `${d}digging` },
            { text: t.pluginPatches, link: `${d}plugins` },
            { text: t.beddMode, link: `${d}bedd` },
          ],
        },
      ],
    },
  ];
};

export default defineDocsConfig({
  base: '/bedboo/',
  title: 'bedboo',
  description: 'A Minecraft Bedrock Edition bot library with a mineflayer-compatible API: mineflayer bots and plugins run against Bedrock Dedicated Server.',
  project: 'bedboo',
  logo: { src: '/logo.png', alt: 'bedboo' },
  favicon: '/logo.png',
  contentDir: '.',
  repo,
  editLink: `${repo}/edit/main/docs/:path`,
  hostname: 'https://docs.levimc.org',
  sitemap: { hostname: 'https://docs.levimc.org' },
  i18n: {
    mode: 'folder',
    defaultLocale: 'root',
    locales: [
      { code: 'root', label: 'English', lang: 'en', prefix: '' },
      { code: 'zh', label: '简体中文', lang: 'zh-CN', prefix: 'zh/' },
      { code: 'zh-Hant', label: '繁體中文', lang: 'zh-Hant', prefix: 'zh-Hant/', convertFrom: 'zh' },
    ],
  },
  urlStyle: 'html',
  cleanUrls: true,
  slug: 'vitepress',
  markdown: { compat: 'commonmark', containers: { vitepress: true } },
  outline: [2, 3],
  exclude: ['scripts/**', 'README.md'],
  sidebar: 'tabs',
  nav: { root: nav('/', root), zh: nav('/zh/', zh) },
});
