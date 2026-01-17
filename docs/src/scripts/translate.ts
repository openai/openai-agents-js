// ----------------------------------------------------------------------------------
// ### Translate document pages to non-English languages ####
// If you want to add a new language, read .github/workflows/update-docs.yml first.
//
// For this file:
//   - Add the new language to `languages` object (required)
//   - Add the new language to `engToNonEngMapping` object (optional)
//   - Add the new language to `engToNonEngInstructions` object (optional)
//   - Add new items to LANGUAGE‑SPECIFIC section in the prompts (optional)
//
// ### How to run this script: ###
// pnpm i && pnpm --filter docs run translate
// ----------------------------------------------------------------------------------

import fs from 'fs/promises';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  Agent,
  getDefaultModelSettings,
  Runner,
  setDefaultOpenAIKey,
} from '@openai/agents';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/**
 * Loads the sidebar object from astro.config.mjs and extracts a mapping of doc links to their labels and translations.
 * Returns a map: { [link: string]: { label: string, translation: string|null } }
 */
export async function extractSidebarTranslations(
  langCode: string,
): Promise<Record<string, { label: string; translation: string | null }>> {
  const configPath = path.resolve(__dirname, '../../astro.config.mjs');
  const configText = await fs.readFile(configPath, 'utf8');
  const lines = configText.split(/\r?\n/);

  const map: Record<string, { label: string; translation: string | null }> = {};

  let inSidebar = false;
  let sidebarLevel = 0;
  let inItems = false;
  let itemsLevel = 0;
  const stack: number[] = [];

  let currentLabel: string | null = null;
  let currentLink: string | null = null;
  let translations: Record<string, string> = {};
  let inTranslationsBlock = false;

  function isSidebarStart(line: string) {
    // Match both the constant declaration and object property for sidebar array
    return /^\s*(?:const\s+)?sidebar\s*[:=]\s*\[/.test(line);
  }
  function isSidebarEnd() {
    return inSidebar && sidebarLevel === 0;
  }
  function isItemsStart(line: string) {
    return line.replace(/\s/g, '').startsWith('items:[');
  }

  for (let i = 0; i < lines.length; ++i) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect entering sidebar block
    if (!inSidebar && isSidebarStart(line)) {
      inSidebar = true;
      sidebarLevel = 1;
      continue;
    }
    if (inSidebar) {
      // Track sidebar bracket level
      if (line.includes('[')) sidebarLevel += (line.match(/\[/g) || []).length;
      if (line.includes(']')) sidebarLevel -= (line.match(/\]/g) || []).length;
      // End of sidebar block
      if (isSidebarEnd()) {
        inSidebar = false;
        sidebarLevel = 0;
        continue;
      }
      // Track nested items arrays
      if (isItemsStart(line)) {
        inItems = true;
        itemsLevel = 1;
        stack.push(sidebarLevel); // Save parent sidebar level
        continue;
      }
      if (inItems) {
        if (line.includes('[')) itemsLevel += (line.match(/\[/g) || []).length;
        if (line.includes(']')) itemsLevel -= (line.match(/\]/g) || []).length;
        if (itemsLevel === 0) {
          inItems = false;
          sidebarLevel = stack.pop() ?? sidebarLevel;
          continue;
        }
      }
      // Only process label/link/translations within sidebar or nested items
      if (trimmed.startsWith('label:')) {
        currentLabel = trimmed.replace(/^label:\s*/, '').replace(/['",]/g, '');
      } else if (trimmed.startsWith('link:')) {
        currentLink = trimmed.replace(/^link:\s*/, '').replace(/['",]/g, '');
      } else if (trimmed.startsWith('translations:')) {
        inTranslationsBlock = true;
        translations = {};
      } else if (inTranslationsBlock) {
        const match = trimmed.match(/^([a-zA-Z0-9_]+)\s*:\s*['"]([^'"]+)['"]/);
        if (match) {
          translations[match[1]] = match[2];
        }
        if (trimmed.includes('}')) {
          inTranslationsBlock = false;
        }
      }
      // Only add to map at the end of an item block
      if (trimmed === '},' || trimmed === '}') {
        if (currentLabel && currentLink) {
          const currentTranslation = translations[langCode] || null;
          map[currentLink] = {
            label: currentLabel,
            translation: currentTranslation,
          };
        }
        currentLabel = null;
        currentLink = null;
        translations = {};
        inTranslationsBlock = false;
      }
    }
  }
  return map;
}

const sourceDir = path.resolve(__dirname, '../../src/content/docs');
const REPO_ROOT = path.resolve(__dirname, '../../..');
const languages: Record<string, string> = {
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  // Add more languages here
};
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5';
setDefaultOpenAIKey(process.env.OPENAI_API_KEY || '');
const ENABLE_CODE_SNIPPET_EXCLUSION = true;

const doNotTranslate = [
  'OpenAI',
  'Agents SDK',
  'Hello World',
  'Model context protocol',
  'MCP',
  'structured outputs',
  'Chain-of-Thought',
  'Chat Completions',
  'Computer-Using Agent',
  'Code Interpreter',
  'Function Calling',
  'LLM',
  'Operator',
  'Playground',
  'Realtime API',
  'Sora',
  'Agents as tools',
  'Agents-as-tools',
];

const engToNonEngMapping: Record<string, Record<string, string>> = {
  ja: {
    agents: 'エージェント',
    'computer use': 'コンピュータ操作',
    'OAI hosted tools': 'OpenAI がホストするツール',
    'well formed data': '適切な形式のデータ',
    guardrail: 'ガードレール',
    handoffs: 'ハンドオフ',
    'function tools': '関数ツール',
    tracing: 'トレーシング',
    'code examples': 'コード例',
    'vector store': 'ベクトルストア',
    'deep research': 'ディープリサーチ',
    category: 'カテゴリー',
    user: 'ユーザー',
    parameter: 'パラメーター',
    processor: 'プロセッサー',
    server: 'サーバー',
    'web search': 'Web 検索',
    'file search': 'ファイル検索',
    streaming: 'ストリーミング',
    'system prompt': 'システムプロンプト',
    'TypeScript-first': 'TypeScript ファースト',
    'Human in the loop': 'Human in the loop (人間の介入)',
    'Hosted tool': '組み込みツール（Hosted）',
    'Hosted MCP server tools': 'リモート MCP サーバーツール',
    raw: '元',
    'Realtime Agents': 'リアルタイムエージェント',
    'Build your first agent in minutes.':
      'ほんの数分ではじめてのエージェントをつくることができます。',
    "Let's build": 'はじめる',
  },
  zh: {
    agents: '智能体',
    'computer use': '计算机操作',
    'OAI hosted tools': 'OpenAI 托管工具',
    'well formed data': '格式良好的数据',
    guardrail: '护栏',
    handoffs: '交接',
    'function tools': '函数工具',
    tracing: '追踪',
    'code examples': '代码示例',
    'vector store': '向量存储',
    'deep research': '深度研究',
    category: '类别',
    user: '用户',
    parameter: '参数',
    processor: '处理器',
    server: '服务器',
    'web search': 'Web 搜索',
    'file search': '文件搜索',
    streaming: '流式传输',
    'system prompt': '系统提示',
    'TypeScript-first': 'TypeScript 优先',
    'Human in the loop': '人工干预',
    'Hosted tool': '托管工具',
    'Hosted MCP server tools': '远程 MCP 服务器工具',
    raw: '原始',
    'Realtime Agents': '实时智能体',
    'Build your first agent in minutes.': '几分钟内构建您的第一个智能体。',
    "Let's build": '开始构建',
    Overview: '概述',
    Quickstart: '快速上手',
  },
  ko: {
    agents: '에이전트',
    'computer use': '컴퓨터 사용',
    'OAI hosted tools': 'OpenAI 호스트하는 도구',
    'well formed data': '적절한 형식의 데이터',
    guardrail: '가드레일',
    handoffs: '핸드오프',
    'function tools': '함수 도구',
    'function calling': '함수 호출',
    tracing: '트레이싱',
    'code examples': '코드 예제',
    'vector store': '벡터 스토어',
    'deep research': '딥 리서치',
    category: '카테고리',
    user: '사용자',
    parameter: '매개변수',
    processor: '프로세서',
    'orchestrating multiple agents': '멀티 에이전트 오케스트레이션',
    server: '서버',
    'web search': '웹 검색',
    'file search': '파일 검색',
    streaming: '스트리밍',
    'system prompt': '시스템 프롬프트',
    interruption: '인터럽션(중단 처리)',
    'TypeScript-first': 'TypeScript 우선',
    'Human in the loop': '휴먼인더루프 (HITL)',
    'Hosted tool': '호스티드 툴',
    'Hosted MCP server tools': '호스티드 MCP 서버 도구',
    raw: '원문',
    'Realtime Agents': '실시간 에이전트',
    'Build your first agent in minutes.':
      '단 몇 분 만에 첫 에이전트를 만들 수 있습니다',
    "Let's build": '시작하기',
  },
};

const engToNonEngInstructions: Record<string, string[]> = {
  common: [
    "* The term 'examples' must be code examples when the page mentions the code examples in the repo, it can be translated as either 'code examples' or 'sample code'.",
    "* The term 'primitives' can be translated as basic components.",
    "* When the terms 'instructions' and 'tools' are mentioned as API parameter names, they must be kept as is.",
    "* The terms 'temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty' as parameter names must be kept as is.",
  ],
  ja: [
    "* The term 'result' in the Runner guide context must be translated like an 'execution result'",
    '* You must consistently use polite wording such as です/ます rather than である/なのだ.',
    "* Don't put 。 at the end for non-sentence bullet points",
  ],
  zh: [
    "* The term 'result' in the Runner guide context must be translated as '运行结果' or '执行结果'",
    '* Use clear and concise Chinese expressions, avoiding overly formal or archaic language',
    '* For technical terms, prefer commonly accepted Chinese translations over literal translations',
    '* Use Chinese punctuation marks appropriately (。，；：""\'\'（）)',
    '* When translating code-related content, maintain consistency with established Chinese programming terminology',
  ],
  ko: [
    '* 공손하고 중립적인 문체(합니다/입니다체)를 일관되게 사용하세요.',
    '* 개발자를 위한 페이지이므로 보통 개발자 문서 형식으로 번역하세요',
    "* 'instructions', 'tools'와 같은 API 매개변수 이름과 temperature, top_p, max_tokens, presence_penalty, frequency_penalty 등은 영문 그대로 유지하세요.",
    '* 문장이 아닌 불릿 항목 끝에는 마침표를 찍지 마세요.',
  ],
};

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function buildInstructionsForTitle(
  targetLanguage: string,
  langCode: string,
): string {
  const doNotTranslateTerms = doNotTranslate.join('\n');
  const specificTerms = Object.entries(engToNonEngMapping[langCode] || {})
    .map(([k, v]) => `* ${k} -> ${v}`)
    .join('\n');
  const specificInstructions = [
    ...(engToNonEngInstructions.common || []),
    ...((engToNonEngInstructions as any)[langCode] || []),
  ].join('\n');
  return `You are an expert technical translator.
  
  Your task: translate the title of Agents SDK document page title into ${targetLanguage}.
  Keep it as simple as possible with the consdideration of the following rules.

############################
##  OUTPUT REQUIREMENTS  ##
############################
You must return **only** the translated markdown. Do not include any commentary, metadata, or explanations. The original markdown structure must be strictly preserved.

#########################
##  GENERAL RULES      ##
#########################
- Keep the tone **natural** and concise.
- Do not omit any content. If a segment should stay in English, copy it verbatim.
- Section titles must be translated except for the Do-Not-Translate list.
- Treat the **Do‑Not‑Translate list** and **Term‑Specific list** as case‑insensitive; preserve the original casing you see.
- No markdown tags.

#########################
##  HARD CONSTRAINTS   ##
#########################
- Never insert spaces immediately inside emphasis markers. Use \`**bold**\`, not \`** bold **\`.
- Preserve the number of emphasis markers from the source: if the source uses \`**\` or \`__\`, keep the same pair count.
- Ensure one space after heading markers: \`##Heading\` -> \`## Heading\`.
- Ensure one space after list markers: \`-Item\` -> \`- Item\`, \`*Item\` -> \`* Item\` (does not apply to \`**\`).
- Trim spaces inside link/image labels: \`[ Label ](url)\` -> \`[Label](url)\`.

###########################
##  GOOD / BAD EXAMPLES  ##
###########################
- Good: This is **bold** text.
- Bad:  This is ** bold ** text.
- Good: ## Heading
- Bad:  ##Heading
- Good: - Item
- Bad:  -Item
- Good: [Label](https://example.com)
- Bad:  [ Label ](https://example.com)

#########################
##  LANGUAGE‑SPECIFIC  ##
#########################
*(applies only when ${targetLanguage} = Japanese)*  
- Insert a half‑width space before and after all alphanumeric terms.  
- Add a half‑width space just outside markdown emphasis markers: \` **bold** \` (good) vs \`** bold **\` (bad).

*(applies only when ${targetLanguage} = Chinese)*
- Use proper Chinese punctuation marks (。，；：""''（）) instead of English ones
- For technical terms mixed with Chinese text, add appropriate spacing for readability
- Use simplified Chinese characters consistently
- Follow Chinese grammar and sentence structure patterns

*(applies only when ${targetLanguage} = Korean)*  
- 영문 식별자, 코드, 약어 주변의 공백은 원문을 유지하고 임의로 추가하거나 삭제하지 마세요.  
- 마크다운 강조 표식 주변에 불필요한 공백을 넣지 마세요: **굵게** (good) vs ** 굵게 ** (bad).

#########################
##  DO NOT TRANSLATE   ##
#########################
When replacing the following terms, do not have extra spaces before/after them:
${doNotTranslateTerms}

#########################
##  TERM‑SPECIFIC      ##
#########################
Translate these terms exactly as provided (no extra spaces):  
${specificTerms}

#########################
##  EXTRA GUIDELINES   ##
#########################
${specificInstructions}
- When translating Markdown tables, preserve the exact table structure, including all delimiters (|), header separators (---), and row/column counts. Only translate the cell contents. Do not add, remove, or reorder columns or rows.

#########################
##  VALIDATION STEPS   ##
#########################
Before returning the final title, run this mental checklist and fix issues if any:
- No occurrences of: \`**\\s+[^*]*\\s+**\`, \`__\\s+[^_]*\\s+__\`.
- No heading without a space: lines starting with \`#{1,6}\` must be followed by a space.
- No list marker without a space: lines starting with \`-\`, \`+\`, or a single \`*\` must be followed by a space.
- No spaces just inside \`[ ... ]\` or \`![ ... ]\` labels.

#########################
##  IF UNSURE          ##
#########################
If you are uncertain about a term, leave the original English term in parentheses after your translation.
`;
}

function buildInstructions(
  targetLanguage: string,
  langCode: string,
  sidebarMap?: Record<string, { label: string; translation: string | null }>,
): string {
  const doNotTranslateTerms = doNotTranslate.join('\n');
  const specificTerms = Object.entries(engToNonEngMapping[langCode] || {})
    .map(([k, v]) => `* ${k} -> ${v}`)
    .join('\n');
  const specificInstructions = [
    ...(engToNonEngInstructions.common || []),
    ...((engToNonEngInstructions as any)[langCode] || []),
  ].join('\n');
  const pageTitles = Object.entries(sidebarMap || {})
    .filter(([_, v]) => v !== null)
    .map(([k, v]) => `* path: ${k} -> label: ${v.translation || v.label}`)
    .join('\n');
  let sidebarLabelsBlock = '';
  if (sidebarMap && Object.keys(sidebarMap).length > 0) {
    sidebarLabelsBlock =
      '\n\n#########################\n##  SIDEBAR LABELS      ##\n#########################\n';
    sidebarLabelsBlock +=
      'Use the following canonical sidebar labels/translations for consistency in section headings and references.\n';
    for (const [link, entry] of Object.entries(sidebarMap)) {
      if (entry.translation) {
        sidebarLabelsBlock += `- ${link}: ${entry.translation} (sidebar translation)\n`;
      } else if (entry.label) {
        sidebarLabelsBlock += `- ${link}: ${entry.label} (sidebar label)\n`;
      }
    }
    sidebarLabelsBlock +=
      '\nAlways use these as the canonical translations for page titles, section headings, and references when they appear.';
  }
  return `You are an expert technical translator.${sidebarLabelsBlock}
  
  Your task: translate the markdown passed as a user input from English into ${targetLanguage}.
  The inputs are the official OpenAI Agents SDK framework documentation, and your translation outputs'll be used for serving the official ${targetLanguage} version of them. Thus, accuracy, clarity, and fidelity to the original are critical.

############################
##  OUTPUT REQUIREMENTS  ##
############################
You must return **only** the translated markdown. Do not include any commentary, metadata, or explanations. The original markdown structure must be strictly preserved.

#########################
##  GENERAL RULES      ##
#########################
- Keep the tone **natural** and concise.
- Section titles starting with # or ## must be a noun form even when they're verb phrases.
- Section titles must be translated except for the Do-Not-Translate list.
- Do not omit any content. If a segment should stay in English, copy it verbatim.
- Do not change the markdown data structure, including the indentations.
- Keep the valid *.md/*.mdx data structure; Do not break anything at runtime.
- Don't add any tags that don't exist in the origin text
- Keep all placeholders such as \`CODE_BLOCK_*\` and \`CODE_LINE_PREFIX\` unchanged.
- Don't add any tags before/after lines using astrojs items such as <Code> and their imports
- Treat the **Do‑Not‑Translate list** and **Term‑Specific list** as case‑insensitive; preserve the original casing you see.
- Convert path in the following rules:
  - Replace /openai-agents-js/XXX/* with /openai-agents-js/${langCode}/XXX/*
  - When the path starts with /openai-agents-js/openai/, don't change anything
  - Don't change the first /openai-agents-js/ part in any case
- Skip translation for:
  - Inline code surrounded by single back‑ticks ( \`like_this\` ).
  - Fenced code blocks delimited by \`\`\` or ~~~, including all comments inside them.
  - Link URLs inside \`[label](URL)\` – translate the label, never the URL.
  - The internal links like [{label here}](path here) must be kept as-is.

#########################
##  HARD CONSTRAINTS   ##
#########################
- Never insert spaces immediately inside emphasis markers. Use \`**bold**\`, not \`** bold **\`.
- Preserve the number of emphasis markers from the source: if the source uses \`**\` or \`__\`, keep the same pair count.
- Ensure one space after heading markers: \`##Heading\` -> \`## Heading\`.
- Ensure one space after list markers: \`-Item\` -> \`- Item\`, \`*Item\` -> \`* Item\` (does not apply to \`**\`).
- Trim spaces inside link/image labels: \`[ Label ](url)\` -> \`[Label](url)\`.

###########################
##  GOOD / BAD EXAMPLES  ##
###########################
- Good: This is **bold** text.
- Bad:  This is ** bold ** text.
- Good: ## Heading
- Bad:  ##Heading
- Good: - Item
- Bad:  -Item
- Good: [Label](https://example.com)
- Bad:  [ Label ](https://example.com)

#########################
##  LANGUAGE‑SPECIFIC  ##
#########################
*(applies only when ${targetLanguage} = Japanese)*  
- Insert a half‑width space before and after all alphanumeric terms.  
- Add a half‑width space just outside markdown emphasis markers: \` **bold** \` (good) vs \`** bold **\` (bad).

*(applies only when ${targetLanguage} = Chinese)*
- Use proper Chinese punctuation marks (。，；：""''（）) instead of English ones
- For technical terms mixed with Chinese text, add appropriate spacing for readability
- Use simplified Chinese characters consistently
- Follow Chinese grammar and sentence structure patterns Review this rule again before returning the translated text.

*(applies only when ${targetLanguage} = Korean)*  
- 영문 식별자, 코드, 약어 주변의 공백은 원문을 유지하고 임의로 추가하거나 삭제하지 마세요.  
- 마크다운 강조 표식 주변에 불필요한 공백을 넣지 마세요: **굵게** (good) vs ** 굵게 ** (bad).

#########################
##  DO NOT TRANSLATE   ##
#########################
When replacing the following terms, do not have extra spaces before/after them:
${doNotTranslateTerms}

#########################
##  TERM‑SPECIFIC      ##
#########################
Translate these terms exactly as provided (no extra spaces):  
${specificTerms}

#########################
##  EXTRA GUIDELINES   ##
#########################
${specificInstructions}
- When translating Markdown tables, preserve the exact table structure, including all delimiters (|), header separators (---), and row/column counts. Only translate the cell contents. Do not add, remove, or reorder columns or rows.

#########################
##  PAGE TITLES        ##
#########################
When you seee links to a different page, consistently use the following labels:
${pageTitles}

#########################
##  IF UNSURE          ##
#########################
If you are uncertain about a term, leave the original English term in parentheses after your translation.

#########################
##  WORKFLOW           ##
#########################

Follow the following workflow to translate the given markdown text data:

1. Read the input markdown text given by the user.
2. Translate the markdown file into ${targetLanguage}, carefully following the requirements above.
3. Perform a self-review to evaluate the following points:
  - the quality of the translation, focusing on naturalness, accuracy, and consistency in detail
  - any errors or rooms for improvements in terms of Markdown text format -- A common error is to have spaces within special syntax like * or _. You must have spaces after special syntax like * or _, but it's NOT the same for the parts inside special syntax (e.g., ** bold ** must be **bold**)
  - you should not have any unnecessary spaces outside of tags; especially for the ones you replace with the "TERM-SPECIFIC" list
  - any parts that are not compatible with *.mdx files -- In the past, you've generated an expression with acorn like {#title-here} in h2 (##) level but it was neither necessary nor valid
  - Run a final regex check in your head and fix if any of these patterns appear in your output:
    - \`**\\s+[^*]*\\s+**\` or \`__\\s+[^_]*\\s+__\` (spaces inside emphasis)
    - Lines starting with \`#{1,6}\` not followed by a space
    - Lines starting with \`-\`, \`+\`, or a single \`*\` not followed by a space
    - Avoid spaces directly inside link or image labels: use \`[Label](url)\`, not \`[ Label ](url)\` or \`![ Label ](url)\`.
4. If improvements are necessary, refine the content without changing the original meaning.
5. Continue improving the translation until you are fully satisfied with the result.
6. Once the final output is ready, return **only** the translated markdown text. No extra commentary.
`;
}

const runner = new Runner({ tracingDisabled: true });

async function callAgent(
  content: string,
  instructions: string,
  model: string = OPENAI_MODEL,
): Promise<string> {
  const modelSettings = getDefaultModelSettings(model);
  const agent = new Agent({
    name: 'translator',
    instructions,
    model,
    modelSettings,
  });
  const result = await runner.run(agent, content);
  const output = result.finalOutput;
  if (!output) {
    console.warn('Agent response missing expected translation.', result);
  }
  return output ?? '';
}

function sanitizeTitle(title: string): string {
  // Remove Markdown formatting and trim whitespace
  return title.replace(/[*_~`]/g, '').trim();
}

function chunkMarkdown(content: string): {
  chunks: string[];
  codeBlocks: string[];
} {
  // Split into lines and chunk, replacing code blocks with placeholders
  const lines = content.split(/\r?\n/);
  const chunks: string[] = [];
  const currentChunk: string[] = [];
  let inCodeBlock = false;
  const codeBlocks: string[] = [];
  let codeBlockLines: string[] = [];
  for (const line of lines) {
    if (ENABLE_CODE_SNIPPET_EXCLUSION) {
      if (!inCodeBlock && line.startsWith('import ')) {
        codeBlocks.push(line);
        currentChunk.push(
          `CODE_BLOCK_${(codeBlocks.length - 1).toString().padStart(3, '0')}`,
        );
        continue;
      }
      if (line.trim().startsWith('```')) {
        codeBlockLines.push(line);
        if (inCodeBlock) {
          codeBlocks.push(codeBlockLines.join('\n'));
          currentChunk.push(
            `CODE_BLOCK_${(codeBlocks.length - 1).toString().padStart(3, '0')}`,
          );
          codeBlockLines = [];
        }
        inCodeBlock = !inCodeBlock;
        continue;
      }
    }
    if (inCodeBlock) {
      codeBlockLines.push(line);
    } else {
      currentChunk.push(line);
    }
  }
  if (currentChunk.length) {
    chunks.push(currentChunk.join('\n'));
  }
  return { chunks, codeBlocks };
}

async function translateFile(
  filePath: string,
  targetPath: string,
  langCode: string,
): Promise<void> {
  // Load sidebar translations for this language
  const sidebarMap = await extractSidebarTranslations(langCode);
  console.log(`Translating ${filePath} into a different language: ${langCode}`);
  const content = await fs.readFile(filePath, 'utf8');

  // Streamlined frontmatter extraction
  const lines = content.split('\n');
  let frontmatter = '';
  let mainContent = content;

  if (
    lines.length >= 4 &&
    lines[0].trim() === '---' &&
    lines[1].startsWith('title:') &&
    lines[2].startsWith('description:') &&
    lines[3].trim() === '---'
  ) {
    // Extract and sanitize title (strip markdown)
    const titleValue = lines[1].replace(/^title:\s*/, '');
    const descriptionValue = lines[2].replace(/^description:\s*/, '');
    // Try to use sidebar label/translation if available
    // Guess link from filePath (e.g. /guides/quickstart.md -> /guides/quickstart)
    const relPath = path.relative(sourceDir, filePath).replace(/\\/g, '/');
    const possibleLink = '/' + relPath.replace(/\.mdx?$/, '');
    const sidebarEntry = sidebarMap[possibleLink];
    let translatedTitle: string;
    if (sidebarEntry && sidebarEntry.translation) {
      // If a sidebar translation exists, use it directly and skip the LLM call
      translatedTitle = sanitizeTitle(sidebarEntry.translation);
    } else {
      console.log('No sidebar translation found for', possibleLink);
      const instructions = buildInstructionsForTitle(
        languages[langCode],
        langCode,
      );
      translatedTitle = sanitizeTitle(
        await callAgent(titleValue, instructions, 'gpt-4.1'),
      );
    }
    // Remove markdown heading if present as the first non-empty line after frontmatter
    let contentLines = lines.slice(4);
    // Find the first non-empty line
    const firstContentIdx = contentLines.findIndex((l) => l.trim() !== '');
    if (firstContentIdx === 0 && contentLines[0].trim().startsWith('#')) {
      // Remove the heading if it's the same as the title (ignoring markdown and whitespace)
      const headingText = contentLines[0].replace(/^#+\s*/, '').trim();
      if (sanitizeTitle(headingText) === sanitizeTitle(titleValue)) {
        contentLines = contentLines.slice(1);
      }
    }
    frontmatter = [
      '---',
      `title: ${translatedTitle}`,
      `description: ${descriptionValue}`,
      '---',
      '',
    ].join('\n');
    mainContent = contentLines.join('\n');

    // ### last modification ###
    // Adjust the relative code snippet reference path
    mainContent = mainContent.replaceAll(
      '../../../../examples',
      '../../../../../examples',
    );
    mainContent = mainContent.replaceAll(
      '../../components',
      '../../../components',
    );
  } else {
    // If not matching, keep original English content
    await ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, content, 'utf8');
    return;
  }

  const { chunks, codeBlocks } = chunkMarkdown(mainContent);
  const translatedContent: string[] = [];
  for (const chunk of chunks) {
    const instructions = buildInstructions(
      languages[langCode],
      langCode,
      sidebarMap,
    );
    const translated = await callAgent(chunk, instructions);
    translatedContent.push(translated);
  }
  // Join translated chunks back together; formatting is guided by prompt constraints
  let translatedText = translatedContent.join('\n');
  for (let idx = 0; idx < codeBlocks.length; ++idx) {
    translatedText = translatedText.replace(
      `CODE_BLOCK_${idx.toString().padStart(3, '0')}`,
      codeBlocks[idx],
    );
  }
  // Remove any duplicate or stray description: lines outside of the frontmatter
  translatedText = translatedText.replace(/^description:.*$/gm, '');
  translatedText = frontmatter + '\n' + translatedText.trimStart();
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, translatedText, 'utf8');
}

function gitLastCommitTimestamp(filePath: string): number {
  try {
    const relativePath = path
      .relative(REPO_ROOT, filePath)
      .replaceAll('\\', '/');
    const result = spawnSync(
      'git',
      ['-C', REPO_ROOT, 'log', '-1', '--format=%ct', '--', relativePath],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) {
      return 0;
    }
    const output = (result.stdout || '').trim();
    if (!output) {
      return 0;
    }
    const timestamp = Number(output);
    return Number.isFinite(timestamp) ? timestamp : 0;
  } catch {
    return 0;
  }
}

function shouldTranslateBasedOnTranslation(filePath: string): boolean {
  const relativePath = path.relative(sourceDir, filePath);
  const jaPath = path.join(sourceDir, 'ja', relativePath);
  const enTimestamp = gitLastCommitTimestamp(filePath);
  if (enTimestamp === 0) {
    return true;
  }
  const jaTimestamp = gitLastCommitTimestamp(jaPath);
  if (jaTimestamp === 0) {
    return true;
  }
  return jaTimestamp < enTimestamp;
}

function normalizeSourceFileArg(fileArg: string): string {
  if (fileArg.startsWith(sourceDir)) {
    return path.relative(sourceDir, fileArg);
  }
  const normalized = fileArg.replaceAll('\\', '/');
  const posixPrefix = 'docs/src/content/docs/';
  if (normalized.startsWith(posixPrefix)) {
    return normalized.slice(posixPrefix.length);
  }
  if (normalized === 'docs/src/content/docs' || normalized === posixPrefix) {
    return '';
  }
  if (path.isAbsolute(fileArg)) {
    return path.relative(sourceDir, fileArg);
  }
  return fileArg;
}

function shouldSkipFile(filePath: string): boolean {
  const rel = path.relative(sourceDir, filePath);
  const isLocalizedDoc = Object.keys(languages).some((code) =>
    rel.startsWith(`${code}/`),
  );
  if (
    isLocalizedDoc ||
    (!filePath.endsWith('.md') && !filePath.endsWith('.mdx'))
  ) {
    return true;
  }
  return false;
}

async function translateSingleSourceFile(
  filePath: string,
  {
    checkTranslationOutdated = true,
  }: { checkTranslationOutdated?: boolean } = {},
): Promise<void> {
  if (shouldSkipFile(filePath)) return;
  if (
    checkTranslationOutdated &&
    !shouldTranslateBasedOnTranslation(filePath)
  ) {
    console.log(`Skipping ${filePath}: The translated one is up-to-date.`);
    return;
  }
  // Always compute rel as the path relative to docs/src/content/docs
  const rel = path.relative(sourceDir, filePath);
  for (const langCode of Object.keys(languages)) {
    // Output should always be docs/src/content/docs/<langCode>/<rel>
    const targetPath = path.join(sourceDir, langCode, rel);
    await translateFile(filePath, targetPath, langCode);
  }
}

type TranslateMode = 'only-changes' | 'full';

function parseModeValue(value: string): TranslateMode {
  if (value === 'only-changes' || value === 'full') {
    return value;
  }
  throw new Error(`Error: Invalid --mode value "${value}".`);
}

function parseArgs(argv: string[]): {
  mode: TranslateMode;
  fileArgs: string[];
  fileListPath: string | null;
} {
  let mode: TranslateMode = 'only-changes';
  const fileArgs: string[] = [];
  let fileListPath: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      continue;
    }
    if (arg === '--mode') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('Error: --mode requires a value.');
      }
      mode = parseModeValue(value);
      i += 1;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      mode = parseModeValue(arg.slice('--mode='.length));
      continue;
    }
    if (arg === '--file') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('Error: --file requires a value.');
      }
      fileArgs.push(value);
      i += 1;
      continue;
    }
    if (arg.startsWith('--file=')) {
      fileArgs.push(arg.slice('--file='.length));
      continue;
    }
    if (arg === '--file-list') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('Error: --file-list requires a value.');
      }
      fileListPath = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--file-list=')) {
      fileListPath = arg.slice('--file-list='.length);
      continue;
    }
    fileArgs.push(arg);
  }
  return { mode, fileArgs, fileListPath };
}

async function main() {
  const concurrency = 6;
  const { mode, fileArgs, fileListPath } = parseArgs(process.argv.slice(2));
  const filePaths: string[] = [];
  const requestedArgs: string[] = [...fileArgs];

  if (fileListPath) {
    const fileListContents = await fs.readFile(fileListPath, 'utf8');
    for (const line of fileListContents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) {
        requestedArgs.push(trimmed);
      }
    }
  }

  if (requestedArgs.length > 0) {
    for (const arg of requestedArgs) {
      const normalizedArg = normalizeSourceFileArg(arg);
      const fullPath = path.join(sourceDir, normalizedArg);
      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat) {
        console.warn(`Warning: File ${fullPath} does not exist; skipping.`);
        continue;
      }
      if (stat.isDirectory()) {
        // Recursively add markdown files in directory.
        async function addFilesFromDir(dir: string) {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const entryPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              await addFilesFromDir(entryPath);
            } else if (
              entry.isFile() &&
              (entry.name.endsWith('.md') || entry.name.endsWith('.mdx'))
            ) {
              filePaths.push(entryPath);
            }
          }
        }
        await addFilesFromDir(fullPath);
      } else if (stat.isFile()) {
        filePaths.push(fullPath);
      }
    }
    if (filePaths.length === 0) {
      console.error('Error: No valid files found to translate.');
      process.exit(1);
    }
  } else {
    filePaths.push(path.join(sourceDir, 'index.mdx'));
    // Translate all guides/*.md files.
    async function collectFiles() {
      // Add all guides/*.md.
      for (const dir of ['guides', 'guides/voice-agents', 'extensions']) {
        const guidesDir = path.join(sourceDir, dir);
        const entries = await fs.readdir(guidesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (
            entry.isFile() &&
            (entry.name.endsWith('.md') || entry.name.endsWith('.mdx'))
          ) {
            filePaths.push(path.join(guidesDir, entry.name));
          }
        }
      }
    }
    await collectFiles();
  }

  const uniquePaths = Array.from(new Set(filePaths));
  const checkTranslationOutdated = mode === 'only-changes';
  let idx = 0;
  while (idx < uniquePaths.length) {
    const batch = uniquePaths.slice(idx, idx + concurrency);
    await Promise.all(
      batch.map((f) =>
        translateSingleSourceFile(f, { checkTranslationOutdated }),
      ),
    );
    idx += concurrency;
  }
  console.log('Translation completed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
