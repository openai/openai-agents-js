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
  plugin: ['typedoc-plugin-zod'],
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
    exclude: ['ja/**'],
  }),
];

const sidebar = [
  {
    label: 'Overview',
    link: '/',
    translations: {
      ja: '概要',
    },
  },
  {
    label: 'Quickstart',
    link: '/guides/quickstart',
    translations: {
      ja: 'クイックスタート',
    },
  },
  {
    label: 'Guides',
    translations: {
      ja: 'ガイド',
    },
    items: [
      {
        label: 'Agents',
        link: '/guides/agents',
        translations: {
          ja: 'エージェント',
        },
      },
      {
        label: 'Running Agents',
        link: '/guides/running-agents',
        translations: {
          ja: 'エージェントの実行',
        },
      },
      {
        label: 'Results',
        link: '/guides/results',
        translations: {
          ja: 'エージェントの実行結果',
        },
      },
      {
        label: 'Tools',
        link: '/guides/tools',
        translations: {
          ja: 'ツール',
        },
      },
      {
        label: 'Orchestrating multiple agents',
        link: '/guides/multi-agent',
        translations: {
          ja: 'マルチエージェント',
        },
      },
      {
        label: 'Handoffs',
        link: '/guides/handoffs',
        translations: {
          ja: 'ハンドオフ',
        },
      },
      {
        label: 'Context management',
        link: '/guides/context',
        translations: {
          ja: 'コンテキスト管理',
        },
      },
      {
        label: 'Models',
        link: '/guides/models',
        translations: {
          ja: 'モデル',
        },
      },
      {
        label: 'Guardrails',
        link: '/guides/guardrails',
        translations: {
          ja: 'ガードレール',
        },
      },
      {
        label: 'Streaming',
        link: '/guides/streaming',
        translations: {
          ja: 'ストリーミング',
        },
      },
      {
        label: 'Human-in-the-loop',
        link: '/guides/human-in-the-loop',
        translations: {
          ja: '人間の介入（HITL）',
        },
      },
      {
        label: 'Model Context Protocol (MCP)',
        link: '/guides/mcp',
        translations: {
          ja: 'MCP 連携',
        },
      },
      {
        label: 'Tracing',
        link: '/guides/tracing',
        translations: {
          ja: 'トレーシング',
        },
      },
      {
        label: 'Configuring the SDK',
        link: '/guides/config',
        translations: {
          ja: 'SDK の設定',
        },
      },
      {
        label: 'Troubleshooting',
        link: '/guides/troubleshooting',
        translations: {
          ja: 'トラブルシューティング',
        },
      },
      {
        label: 'Release process',
        link: '/guides/release',
        translations: {
          ja: 'リリースプロセス',
        },
      },
    ],
  },
  {
    label: 'Voice Agents',
    translations: {
      ja: '音声エージェント',
    },
    items: [
      {
        label: 'Overview',
        link: '/guides/voice-agents',
        translations: {
          ja: '音声エージェントの概要',
        },
      },
      {
        label: 'Quickstart',
        link: '/guides/voice-agents/quickstart',
        translations: {
          ja: 'クイックスタート',
        },
      },
      {
        label: 'Building Voice Agents',
        link: '/guides/voice-agents/build',
        translations: {
          ja: '音声エージェントの構築',
        },
      },
      {
        label: 'Transport Mechanisms',
        link: '/guides/voice-agents/transport',
        translations: {
          ja: 'リアルタイムトランスポート',
        },
      },
    ],
  },
  {
    label: 'Extensions',
    translations: {
      ja: '拡張機能',
    },
    items: [
      {
        label: 'Use any model with the AI SDK',
        link: '/extensions/ai-sdk',
        translations: {
          ja: 'AI SDK で任意モデルを指定',
        },
      },
      {
        label: 'Connect Realtime Agents to Twilio',
        link: '/extensions/twilio',
        translations: {
          ja: 'Realtime Agent を Twilio に接続',
        },
      },
    ],
  },
  {
    label: 'API Reference',
    translations: {
      ja: 'APIリファレンス',
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
