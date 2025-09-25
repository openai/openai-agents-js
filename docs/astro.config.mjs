// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { createStarlightTypeDocPlugin } from 'starlight-typedoc';
import tailwindcss from '@tailwindcss/vite';
import starlightLlmsTxt from 'starlight-llms-txt';

const [mainStarlightTypeDoc, mainTypeDocSidebarGroup] =
  createStarlightTypeDocPlugin();
const [mainRealtimeStarlightTypeDoc, mainRealtimeTypeDocSidebarGroup] =
  createStarlightTypeDocPlugin();
const [coreStarlightTypeDoc, coreTypeDocSidebarGroup] =
  createStarlightTypeDocPlugin();
const [openaiStarlightTypeDoc, openaiTypeDocSidebarGroup] =
  createStarlightTypeDocPlugin();
const [realtimeStarlightTypeDoc, realtimeTypeDocSidebarGroup] =
  createStarlightTypeDocPlugin();
const [extensionsStarlightTypeDoc, extensionsTypeDocSidebarGroup] =
  createStarlightTypeDocPlugin();

const typeDocConfig = {
  useCodeBlocks: true,
  parametersFormat: 'htmlTable',
  propertyMembersFormat: 'htmlTable',
  disableSources: true,
  plugin: [
    'typedoc-plugin-zod',
    'typedoc-plugin-frontmatter',
    './src/plugins/typedoc-frontmatter.js',
  ],
};

const plugins = [
  mainStarlightTypeDoc({
    sidebar: {
      label: 'Main API',
    },
    entryPoints: ['../packages/agents/src/index.ts'],
    output: 'openai/agents',
    tsconfig: '../packages/agents/tsconfig.json',
    typeDoc: typeDocConfig,
  }),
  mainRealtimeStarlightTypeDoc({
    sidebar: {
      label: '@openai/agents/realtime',
    },
    entryPoints: ['../packages/agents/src/realtime/index.ts'],
    output: 'openai/agents/realtime',
    tsconfig: '../packages/agents/tsconfig.json',
    typeDoc: typeDocConfig,
  }),
  coreStarlightTypeDoc({
    entryPoints: ['../packages/agents-core/src/index.ts'],
    output: 'openai/agents-core',
    tsconfig: '../packages/agents-core/tsconfig.json',
    typeDoc: typeDocConfig,
  }),
  openaiStarlightTypeDoc({
    entryPoints: ['../packages/agents-openai/src/index.ts'],
    output: 'openai/agents-openai',
    tsconfig: '../packages/agents-openai/tsconfig.json',
    typeDoc: typeDocConfig,
  }),
  realtimeStarlightTypeDoc({
    entryPoints: ['../packages/agents-realtime/src/index.ts'],
    output: 'openai/agents-realtime',
    tsconfig: '../packages/agents-realtime/tsconfig.json',
    typeDoc: typeDocConfig,
  }),
  extensionsStarlightTypeDoc({
    entryPoints: ['../packages/agents-extensions/src/index.ts'],
    output: 'openai/agents-extensions',
    tsconfig: '../packages/agents-extensions/tsconfig.json',
    typeDoc: typeDocConfig,
  }),
  starlightLlmsTxt({
    projectName: 'OpenAI Agents SDK (TypeScript)',
    customSets: [
      {
        label: 'Guides',
        description: 'Guides for using the OpenAI Agents SDK',
        paths: ['guides/**'],
      },
      {
        label: 'API Reference',
        description: 'API reference for the OpenAI Agents SDK',
        paths: ['api/**'],
      },
    ],
    exclude: ['ja/**', 'zh/**'],
  }),
];

const sidebar = [
  {
    label: 'Overview',
    link: '/',
    translations: {
      ja: '概要',
      zh: '概述',
    },
  },
  {
    label: 'Quickstart',
    link: '/guides/quickstart',
    translations: {
      ja: 'クイックスタート',
      zh: '快速开始',
    },
  },
  {
    label: 'Guides',
    translations: {
      ja: 'ガイド',
      zh: '指南',
    },
    items: [
      {
        label: 'Agents',
        link: '/guides/agents',
        translations: {
          ja: 'エージェント',
          zh: '智能体',
        },
      },
      {
        label: 'Running Agents',
        link: '/guides/running-agents',
        translations: {
          ja: 'エージェントの実行',
          zh: '运行智能体',
        },
      },
      {
        label: 'Results',
        link: '/guides/results',
        translations: {
          ja: 'エージェントの実行結果',
          zh: '执行结果',
        },
      },
      {
        label: 'Tools',
        link: '/guides/tools',
        translations: {
          ja: 'ツール',
          zh: '工具',
        },
      },
      {
        label: 'Orchestrating multiple agents',
        link: '/guides/multi-agent',
        translations: {
          ja: 'マルチエージェント',
          zh: '多智能体编排',
        },
      },
      {
        label: 'Handoffs',
        link: '/guides/handoffs',
        translations: {
          ja: 'ハンドオフ',
          zh: '交接',
        },
      },
      {
        label: 'Context management',
        link: '/guides/context',
        translations: {
          ja: 'コンテキスト管理',
          zh: '上下文管理',
        },
      },
      {
        label: 'Models',
        link: '/guides/models',
        translations: {
          ja: 'モデル',
          zh: '模型',
        },
      },
      {
        label: 'Guardrails',
        link: '/guides/guardrails',
        translations: {
          ja: 'ガードレール',
          zh: '护栏',
        },
      },
      {
        label: 'Streaming',
        link: '/guides/streaming',
        translations: {
          ja: 'ストリーミング',
          zh: '流式传输',
        },
      },
      {
        label: 'Human-in-the-loop',
        link: '/guides/human-in-the-loop',
        translations: {
          ja: '人間の介入（HITL）',
          zh: '人机协作',
        },
      },
      {
        label: 'Model Context Protocol (MCP)',
        link: '/guides/mcp',
        translations: {
          ja: 'MCP 連携',
          zh: 'MCP 集成',
        },
      },
      {
        label: 'Tracing',
        link: '/guides/tracing',
        translations: {
          ja: 'トレーシング',
          zh: '追踪',
        },
      },
      {
        label: 'Configuring the SDK',
        link: '/guides/config',
        translations: {
          ja: 'SDK の設定',
          zh: 'SDK 配置',
        },
      },
      {
        label: 'Troubleshooting',
        link: '/guides/troubleshooting',
        translations: {
          ja: 'トラブルシューティング',
          zh: '故障排除',
        },
      },
      {
        label: 'Release process',
        link: '/guides/release',
        translations: {
          ja: 'リリースプロセス',
          zh: '发布流程',
        },
      },
    ],
  },
  {
    label: 'Voice Agents',
    translations: {
      ja: '音声エージェント',
      zh: '语音智能体',
    },
    items: [
      {
        label: 'Overview',
        link: '/guides/voice-agents',
        translations: {
          ja: '音声エージェントの概要',
          zh: '语音智能体概述',
        },
      },
      {
        label: 'Quickstart',
        link: '/guides/voice-agents/quickstart',
        translations: {
          ja: 'クイックスタート',
          zh: '快速开始',
        },
      },
      {
        label: 'Building Voice Agents',
        link: '/guides/voice-agents/build',
        translations: {
          ja: '音声エージェントの構築',
          zh: '构建语音智能体',
        },
      },
      {
        label: 'Transport Mechanisms',
        link: '/guides/voice-agents/transport',
        translations: {
          ja: 'リアルタイムトランスポート',
          zh: '传输机制',
        },
      },
    ],
  },
  {
    label: 'Extensions',
    translations: {
      ja: '拡張機能',
      zh: '扩展',
    },
    items: [
      {
        label: 'Use any model with the AI SDK',
        link: '/extensions/ai-sdk',
        translations: {
          ja: 'AI SDK で任意モデルを指定',
          zh: '使用 AI SDK 指定任意模型',
        },
      },
      {
        label: 'Connect Realtime Agents to Twilio',
        link: '/extensions/twilio',
        translations: {
          ja: 'Realtime Agent を Twilio に接続',
          zh: '将实时智能体连接到 Twilio',
        },
      },
      {
        label: 'Cloudflare Workers Transport',
        link: '/extensions/cloudflare',
        translations: {
          ja: 'Cloudflare Workers 用トランスポート',
          zh: 'Cloudflare Workers 传输',
        },
      },
    ],
  },
  {
    label: 'API Reference',
    translations: {
      ja: 'APIリファレンス',
      zh: 'API 参考',
    },
    collapsed: false,
    items: [
      {
        label: '@openai/agents',
        collapsed: true,
        // Add the generated public sidebar group to the sidebar.
        items: [mainTypeDocSidebarGroup, mainRealtimeTypeDocSidebarGroup],
      },
      {
        label: '@openai/agents-core',
        collapsed: true,
        // Add the generated public sidebar group to the sidebar.
        items: [coreTypeDocSidebarGroup],
      },
      {
        label: '@openai/agents-openai',
        collapsed: true,
        // Add the generated public sidebar group to the sidebar.
        items: [openaiTypeDocSidebarGroup],
      },
      {
        label: '@openai/agents-realtime',
        collapsed: true,
        // Add the generated public sidebar group to the sidebar.
        items: [realtimeTypeDocSidebarGroup],
      },
      {
        label: '@openai/agents-extensions',
        collapsed: true,
        // Add the generated public sidebar group to the sidebar.
        items: [extensionsTypeDocSidebarGroup],
      },
    ],
  },
];

// https://astro.build/config
export default defineConfig({
  site: 'https://openai.github.io',
  base: 'openai-agents-js',

  integrations: [
    starlight({
      title: 'OpenAI Agents SDK',
      components: {
        SiteTitle: './src/components/Title.astro',
        PageTitle: './src/components/PageTitle.astro',
        SocialIcons: './src/components/SocialIcons.astro',
        Sidebar: './src/components/Sidebar.astro',
        MobileMenuFooter: './src/components/MobileFooter.astro',
      },
      //   defaultLocale: 'root',
      locales: {
        root: {
          label: 'English',
          lang: 'en',
        },
        ja: {
          label: '日本語',
          lang: 'ja',
        },
        zh: {
          label: '中文',
          lang: 'zh',
        },
      },
      social: [
        {
          icon: 'seti:python',
          href: 'https://github.com/openai/openai-agents-python',
          label: 'Python SDK',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/openai/openai-agents-js/edit/main/docs/',
      },
      plugins,
      sidebar,
      expressiveCode: {
        themes: ['houston', 'one-light'],
      },
      customCss: ['./src/styles/global.css'],
    }),
  ],

  vite: {
    plugins: [tailwindcss()],
  },
});
