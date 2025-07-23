// How to run this script:
// pnpm i && pnpm --filter docs run translate

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Agent, Runner, setDefaultOpenAIKey } from '@openai/agents';

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
const languages: Record<string, string> = {
  ja: 'Japanese',
  // Add more languages here
};
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'o3';
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
##  LANGUAGE‑SPECIFIC  ##
#########################
*(applies only when ${targetLanguage} = Japanese)*  
- Insert a half‑width space before and after all alphanumeric terms.  
- Add a half‑width space just outside markdown emphasis markers: \` **太字** \` (good) vs \`** 太字 **\` (bad).

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
##  LANGUAGE‑SPECIFIC  ##
#########################
*(applies only when ${targetLanguage} = Japanese)*  
- Insert a half‑width space before and after all alphanumeric terms.  
- Add a half‑width space just outside markdown emphasis markers: \` **太字** \` (good) vs \`** 太字 **\` (bad). Review this rule again before returning the translated text.

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
  - any parts that are not compatible with *.mdx files -- In the past, you've generated an expression with acorn like {#title-here} in h2 (##) level but it was neither necessary nor valid
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
  const agent = new Agent({ name: 'translator', instructions, model });
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

function shouldSkipFile(filePath: string): boolean {
  const rel = path.relative(sourceDir, filePath);
  if (
    rel.startsWith('ja/') ||
    rel.startsWith('fr/') ||
    (!filePath.endsWith('.md') && !filePath.endsWith('.mdx'))
  ) {
    return true;
  }
  return false;
}

async function translateSingleSourceFile(filePath: string): Promise<void> {
  if (shouldSkipFile(filePath)) return;
  // Always compute rel as the path relative to docs/src/content/docs
  const rel = path.relative(sourceDir, filePath);
  for (const langCode of Object.keys(languages)) {
    // Output should always be docs/src/content/docs/<langCode>/<rel>
    const targetPath = path.join(sourceDir, langCode, rel);
    await translateFile(filePath, targetPath, langCode);
  }
}

async function main() {
  const concurrency = 6;
  const args = process.argv.slice(2);
  const filePaths: string[] = [];
  if (args.length > 0) {
    for (const arg of args) {
      const fullPath = path.join(
        sourceDir,
        arg.replace('docs/src/content/docs/', ''),
      );
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        // Recursively add markdown files in directory
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
  } else {
    filePaths.push(path.join(sourceDir, 'index.mdx'));
    // Translate all guides/*.md files
    async function collectFiles() {
      // Add all guides/*.md
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
  let idx = 0;
  while (idx < filePaths.length) {
    const batch = filePaths.slice(idx, idx + concurrency);
    await Promise.all(batch.map((f) => translateSingleSourceFile(f)));
    idx += concurrency;
  }
  console.log('Translation completed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
