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
    exclude: ['ja/**', 'zh/**', 'ko/**'],
  }),
];

const sidebar = [
  {
    label: 'Overview',
    link: '/',
    translations: {
      ja: '概要',
      zh: '概述',
      ko: '개요',
    },
  },
  {
    label: 'Quickstart',
    link: '/guides/quickstart',
    translations: {
      ja: 'クイックスタート',
      zh: '快速开始',
      ko: '빠른 시작',
    },
  },
  {
    label: 'Configuration',
    link: '/guides/config',
    translations: {
      ja: 'SDK の設定',
      zh: 'SDK 配置',
      ko: 'SDK 설정',
    },
  },
  {
    label: 'Guides',
    translations: {
      ja: 'ガイド',
      zh: '指南',
      ko: '가이드',
    },
    items: [
      {
        label: 'Agents',
        link: '/guides/agents',
        translations: {
          ja: 'エージェント',
          zh: '智能体',
          ko: '에이전트',
        },
      },
      {
        label: 'Sandbox agents',
        items: [
          {
            label: 'Quickstart',
            link: '/guides/sandbox-agents',
          },
          {
            label: 'Concepts',
            link: '/guides/sandbox-agents/concepts',
          },
          {
            label: 'Sandbox clients',
            link: '/guides/sandbox-agents/clients',
          },
          {
            label: 'Agent memory',
            link: '/guides/sandbox-agents/memory',
          },
        ],
      },
      {
        label: 'Models',
        link: '/guides/models',
        translations: {
          ja: 'モデル',
          zh: '模型',
          ko: '모델',
        },
      },
      {
        label: 'Tools',
        link: '/guides/tools',
        translations: {
          ja: 'ツール',
          zh: '工具',
          ko: '도구',
        },
      },
      {
        label: 'Guardrails',
        link: '/guides/guardrails',
        translations: {
          ja: 'ガードレール',
          zh: '护栏',
          ko: '가드레일',
        },
      },
      {
        label: 'Running Agents',
        link: '/guides/running-agents',
        translations: {
          ja: 'エージェントの実行',
          zh: '运行智能体',
          ko: '에이전트 실행',
        },
      },
      {
        label: 'Streaming',
        link: '/guides/streaming',
        translations: {
          ja: 'ストリーミング',
          zh: '流式传输',
          ko: '스트리밍',
        },
      },
      {
        label: 'Agent Orchestration',
        link: '/guides/multi-agent',
        translations: {
          ja: 'エージェントオーケストレーション',
          zh: '智能体编排',
          ko: '에이전트 오케스트레이션',
        },
      },
      {
        label: 'Handoffs',
        link: '/guides/handoffs',
        translations: {
          ja: 'ハンドオフ',
          zh: '交接',
          ko: '핸드오프',
        },
      },
      {
        label: 'Results',
        link: '/guides/results',
        translations: {
          ja: 'エージェントの実行結果',
          zh: '执行结果',
          ko: '실행 결과',
        },
      },
      {
        label: 'Human-in-the-loop',
        link: '/guides/human-in-the-loop',
        translations: {
          ja: '人間の介入（HITL）',
          zh: '人机协作',
          ko: '휴먼 인 더 루프 (HITL)',
        },
      },
      {
        label: 'Sessions',
        link: '/guides/sessions',
        translations: {
          ja: 'セッション',
          zh: '会话',
          ko: '세션',
        },
      },
      {
        label: 'Context Management',
        link: '/guides/context',
        translations: {
          ja: 'コンテキスト管理',
          zh: '上下文管理',
          ko: '컨텍스트 관리',
        },
      },
      {
        label: 'Model Context Protocol (MCP)',
        link: '/guides/mcp',
        translations: {
          ja: 'MCP 連携',
          zh: 'MCP 集成',
          ko: '모델 컨텍스트 프로토콜 (MCP)',
        },
      },
      {
        label: 'Tracing',
        link: '/guides/tracing',
        translations: {
          ja: 'トレーシング',
          zh: '追踪',
          ko: '트레이싱',
        },
      },
    ],
  },
  {
    label: 'Voice Agents',
    translations: {
      ja: '音声エージェント',
      zh: '语音智能体',
      ko: '음성 에이전트',
    },
    items: [
      {
        label: 'Overview',
        link: '/guides/voice-agents',
        translations: {
          ja: '音声エージェントの概要',
          zh: '语音智能体概述',
          ko: '음성 에이전트 개요',
        },
      },
      {
        label: 'Quickstart',
        link: '/guides/voice-agents/quickstart',
        translations: {
          ja: 'クイックスタート',
          zh: '快速开始',
          ko: '빠른 시작',
        },
      },
      {
        label: 'Building Voice Agents',
        link: '/guides/voice-agents/build',
        translations: {
          ja: '音声エージェントの構築',
          zh: '构建语音智能体',
          ko: '음성 에이전트 구축',
        },
      },
      {
        label: 'Transport Mechanisms',
        link: '/guides/voice-agents/transport',
        translations: {
          ja: 'リアルタイムトランスポート',
          zh: '传输机制',
          ko: '전송 방식',
        },
      },
    ],
  },
  {
    label: 'Extensions',
    translations: {
      ja: '拡張機能',
      zh: '扩展',
      ko: '확장 기능',
    },
    items: [
      {
        label: 'AI SDK Integration',
        link: '/extensions/ai-sdk',
        translations: {
          ja: 'AI SDK 連携',
          zh: 'AI SDK 集成',
          ko: 'AI SDK 연동',
        },
      },
      {
        label: 'Realtime Agents on Twilio',
        link: '/extensions/twilio',
        translations: {
          ja: 'Twilio 上の Realtime Agent',
          zh: 'Twilio 上的实时智能体',
          ko: 'Twilio용 Realtime 에이전트',
        },
      },
      {
        label: 'Realtime Agents on Cloudflare',
        link: '/extensions/cloudflare',
        translations: {
          ja: 'Cloudflare 上の Realtime Agent',
          zh: 'Cloudflare 上的实时智能体',
          ko: 'Cloudflare용 Realtime 에이전트',
        },
      },
    ],
  },
  {
    label: 'Troubleshooting',
    link: '/guides/troubleshooting',
    translations: {
      ja: 'トラブルシューティング',
      zh: '故障排除',
      ko: '문제 해결',
    },
  },
  {
    label: 'API Reference',
    translations: {
      ja: 'APIリファレンス',
      zh: 'API 参考',
      ko: 'API 레퍼런스',
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
  {
    label: 'Maintainers: release process',
    link: '/guides/release',
    translations: {
      ja: 'リリースプロセス',
      zh: '发布流程',
      ko: '릴리스 프로세스',
    },
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
        ko: {
          label: '한국어',
          lang: 'ko',
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
