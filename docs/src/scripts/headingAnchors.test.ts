import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'node:url';
import {
  createMarkdownProcessor,
  parseFrontmatter,
} from '@astrojs/markdown-remark';
import { describe, expect, test, vi } from 'vitest';
import { rehypeCanonicalHeadingIds } from '../plugins/rehypeCanonicalHeadingIds';
import {
  canonicalHeadingIds,
  preserveCanonicalHeadingIds,
  refreshLocalizedHeadingIds,
  writeCanonicalHeadingCopy,
} from './headingAnchors';
import { translateFile } from './translate';

const runTranslation = vi.hoisted(() => vi.fn());
vi.mock('@openai/agents', () => ({
  Agent: vi.fn(),
  Runner: class {
    run = runTranslation;
  },
  setDefaultOpenAIKey: vi.fn(),
}));

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const DOCS_ROOT = path.join(REPO_ROOT, 'docs/src/content/docs');

describe('canonical localized heading IDs', () => {
  test('derives rendered English IDs and ignores fenced code', async () => {
    const headings = await canonicalHeadingIds(`
# Page title

## Using \`Agent\` with [tools](tools.md)

## [Referenced tools][tools]

[tools]: /guides/tools/

## Example

~~~md
## Not a heading
~~~

## Example
`);

    expect(headings).toEqual([
      { depth: 2, id: 'using-agent-with-tools', aliases: [] },
      { depth: 2, id: 'referenced-tools', aliases: [] },
      { depth: 2, id: 'example', aliases: [] },
      { depth: 2, id: 'example-1', aliases: [] },
    ]);
  });

  test('writes idempotent metadata and rejects structural mismatches', async () => {
    const source = `---
title: Agents
description: English
---

## Dynamic instructions
`;
    const localized = `---
title: エージェント
description: Japanese
---

## 動的な指示
`;
    const once = await preserveCanonicalHeadingIds(
      source,
      localized,
      'localized fixture',
    );
    const twice = await preserveCanonicalHeadingIds(
      source,
      once,
      'localized fixture',
    );

    expect(twice).toBe(once);
    expect(once).toContain(`canonicalHeadingIds:
  - depth: 2
    id: 'dynamic-instructions'
    aliases:
      - '動的な指示'`);
    await expect(
      preserveCanonicalHeadingIds(
        source,
        localized.replace('## 動的な指示', '### 動的な指示'),
        'localized fixture',
      ),
    ).rejects.toThrow('heading levels do not match');
  });

  test('rejects unsupported section heading representations', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    try {
      await expect(canonicalHeadingIds('Section\n-------\n')).rejects.toThrow(
        'Only top-level H2-H6 ATX Markdown headings are supported',
      );
      await expect(
        canonicalHeadingIds('> ## Quoted heading\n'),
      ).rejects.toThrow(
        'Only top-level H2-H6 ATX Markdown headings are supported',
      );
      await expect(canonicalHeadingIds('## Hello {value}\n')).rejects.toThrow(
        'Dynamic MDX syntax is not supported',
      );
      await expect(canonicalHeadingIds('## `{value}`\n')).resolves.toEqual([
        { depth: 2, id: 'value', aliases: [] },
      ]);
      await expect(canonicalHeadingIds('<h2>Raw heading</h2>')).rejects.toThrow(
        'Unsupported raw or MDX H2-H6 heading',
      );
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  test('applies canonical IDs through the Astro heading pipeline', async () => {
    const processor = await createMarkdownProcessor({
      syntaxHighlight: false,
      rehypePlugins: [[rehypeCanonicalHeadingIds, { contentRoot: DOCS_ROOT }]],
    });
    const result = await processor.render('## 動的な指示', {
      frontmatter: {
        canonicalHeadingIds: [
          {
            depth: 2,
            id: 'dynamic-instructions',
            aliases: ['以前の動的な指示'],
          },
        ],
      },
    });

    expect(result.code).toContain(
      '<h2 id="dynamic-instructions"><span id="以前の動的な指示" aria-hidden="true"></span><span id="動的な指示" aria-hidden="true"></span>',
    );
    expect(result.metadata.headings).toEqual([
      { depth: 2, slug: 'dynamic-instructions', text: '動的な指示' },
    ]);

    const matchingId = await processor.render('## Stable', {
      frontmatter: {
        canonicalHeadingIds: [{ depth: 2, id: 'stable', aliases: [] }],
      },
    });
    expect(matchingId.code).toContain('<h2 id="stable">Stable</h2>');
    expect(matchingId.code).not.toContain('<span');

    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    try {
      await expect(
        processor.render('### 動的な指示', {
          frontmatter: {
            canonicalHeadingIds: [
              { depth: 2, id: 'dynamic-instructions', aliases: [] },
            ],
          },
        }),
      ).rejects.toThrow('does not match the rendered headings');
      expect(consoleError).toHaveBeenCalled();

      await expect(
        processor.render('<h2>Raw heading</h2>', {
          frontmatter: { canonicalHeadingIds: [] },
        }),
      ).rejects.toThrow('Unsupported raw or MDX H2-H6 heading');

      await expect(
        processor.render('## Second\n\n## First', {
          frontmatter: {
            canonicalHeadingIds: [
              { depth: 2, id: 'first', aliases: [] },
              { depth: 2, id: 'second', aliases: [] },
            ],
          },
        }),
      ).rejects.toThrow('Heading ID "second" identifies multiple headings');

      await expect(
        processor.render('## First\n\n## Second', {
          frontmatter: {
            canonicalHeadingIds: [
              { depth: 2, id: 'same', aliases: [] },
              { depth: 2, id: 'same', aliases: [] },
            ],
          },
        }),
      ).rejects.toThrow('Heading ID "same" identifies multiple headings');

      for (const metadata of [
        { depth: 2, id: 'same', aliases: [] },
        { depth: 2, id: 'canonical', aliases: ['same'] },
      ]) {
        await expect(
          processor.render('# Same\n\n## Localized', {
            frontmatter: { canonicalHeadingIds: [metadata] },
          }),
        ).rejects.toThrow('Heading ID "same" identifies multiple headings');
      }
    } finally {
      consoleError.mockRestore();
    }
  });

  test('retains every published localized alias across retranslations', async () => {
    const source = `---
title: Stable
description: English
---

## Stable heading
`;
    const previousLocalized = `---
title: 安定
description: Japanese
canonicalHeadingIds:
  - depth: 2
    id: 'stable-heading'
    aliases:
      - '最初の見出し'
      - '二番目の見出し'
---

## 二番目の見出し
`;
    const thirdTranslation = await preserveCanonicalHeadingIds(
      source,
      `---
title: 安定
description: Japanese
---

## 三番目の見出し
`,
      'localized fixture',
      previousLocalized,
    );
    const fourthTranslation = await preserveCanonicalHeadingIds(
      source,
      `---
title: 安定
description: Japanese
---

## 四番目の見出し
`,
      'localized fixture',
      thirdTranslation,
    );
    const { content, frontmatter } = parseFrontmatter(fourthTranslation);

    expect(frontmatter.canonicalHeadingIds).toEqual([
      {
        depth: 2,
        id: 'stable-heading',
        aliases: [
          '最初の見出し',
          '二番目の見出し',
          '三番目の見出し',
          '四番目の見出し',
        ],
      },
    ]);

    const processor = await createMarkdownProcessor({
      syntaxHighlight: false,
      rehypePlugins: [[rehypeCanonicalHeadingIds, { contentRoot: DOCS_ROOT }]],
    });
    const result = await processor.render(content, { frontmatter });
    expect(result.code).toContain(
      '<h2 id="stable-heading"><span id="最初の見出し" aria-hidden="true"></span><span id="二番目の見出し" aria-hidden="true"></span><span id="三番目の見出し" aria-hidden="true"></span><span id="四番目の見出し" aria-hidden="true"></span>',
    );
  });

  test('retains aligned rename history and matches removals by canonical ID', async () => {
    const previousLocalized = `---
title: Previous
description: Japanese
canonicalHeadingIds:
  - depth: 2
    id: 'first'
  - depth: 2
    id: 'second'
---

## 最初の旧見出し

## 二番目の旧見出し
`;
    const afterRemoval = await preserveCanonicalHeadingIds(
      '---\ntitle: Source\ndescription: English\n---\n\n## Second\n',
      '---\ntitle: Current\ndescription: Japanese\n---\n\n## 二番目の新見出し\n',
      'localized fixture',
      previousLocalized,
    );
    expect(
      parseFrontmatter(afterRemoval).frontmatter.canonicalHeadingIds,
    ).toEqual([
      {
        depth: 2,
        id: 'second',
        aliases: ['二番目の旧見出し', '二番目の新見出し'],
      },
    ]);

    const afterCanonicalRename = await preserveCanonicalHeadingIds(
      '---\ntitle: Source\ndescription: English\n---\n\n## Renamed\n',
      '---\ntitle: Current\ndescription: Japanese\n---\n\n## 新しい見出し\n',
      'localized fixture',
      previousLocalized
        .replace("  - depth: 2\n    id: 'second'\n", '')
        .replace('\n## 二番目の旧見出し\n', ''),
    );
    expect(
      parseFrontmatter(afterCanonicalRename).frontmatter.canonicalHeadingIds,
    ).toEqual([
      {
        depth: 2,
        id: 'renamed',
        aliases: ['first', '最初の旧見出し', '新しい見出し'],
      },
    ]);
  });

  test('rejects invalid alias history before refreshing a generated file', async () => {
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'heading-alias-history-'),
    );
    const sourcePath = path.join(temporaryDirectory, 'source.mdx');
    const localizedPath = path.join(temporaryDirectory, 'localized.mdx');
    const collidingLocalized = `---
title: Localized
canonicalHeadingIds:
  - depth: 2
    id: 'first'
    aliases:
      - 'second'
  - depth: 2
    id: 'second'
    aliases: []
---

## First localized

## Second localized
`;
    try {
      await fs.writeFile(
        sourcePath,
        '---\ntitle: Source\n---\n\n## First\n\n## Second\n',
      );
      await fs.writeFile(localizedPath, collidingLocalized);

      await expect(
        refreshLocalizedHeadingIds(sourcePath, [localizedPath]),
      ).rejects.toThrow('Heading ID "second" identifies multiple headings');
      await expect(fs.readFile(localizedPath, 'utf8')).resolves.toBe(
        collidingLocalized,
      );

      const malformedLocalized = collidingLocalized
        .replace("    aliases:\n      - 'second'", '    aliases: invalid')
        .replace("      - 'second'\n", '');
      await fs.writeFile(localizedPath, malformedLocalized);
      await expect(
        refreshLocalizedHeadingIds(sourcePath, [localizedPath]),
      ).rejects.toThrow('Invalid canonicalHeadingIds metadata');
      await expect(fs.readFile(localizedPath, 'utf8')).resolves.toBe(
        malformedLocalized,
      );
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('preserves alias history in untranslated fallback copies', async () => {
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'heading-fallback-'),
    );
    const targetPath = path.join(temporaryDirectory, 'localized.mdx');
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const previousLocalized = `---
title: Previous
canonicalHeadingIds:
  - depth: 2
    id: 'stable-heading'
    aliases:
      - '最初の見出し'
---

## 二番目の見出し
`;
    try {
      await fs.writeFile(targetPath, previousLocalized);
      await expect(
        writeCanonicalHeadingCopy(
          'Unsupported\n-----------\n',
          targetPath,
          'localized fixture',
          previousLocalized,
        ),
      ).rejects.toThrow(
        'Only top-level H2-H6 ATX Markdown headings are supported',
      );
      await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe(
        previousLocalized,
      );
      expect(consoleError).toHaveBeenCalled();

      const source = '---\ntitle: Fallback\n---\n\n## Stable heading\n';
      await expect(
        writeCanonicalHeadingCopy(
          source,
          targetPath,
          'localized fixture',
          previousLocalized,
        ),
      ).resolves.toBeUndefined();
      const written = await fs.readFile(targetPath, 'utf8');
      expect(parseFrontmatter(written).frontmatter.canonicalHeadingIds).toEqual(
        [
          {
            depth: 2,
            id: 'stable-heading',
            aliases: ['最初の見出し', '二番目の見出し'],
          },
        ],
      );
      expect(parseFrontmatter(written).content).toContain('## Stable heading');

      const malformedPrevious = previousLocalized.replace(
        "    aliases:\n      - '最初の見出し'",
        '    aliases: invalid',
      );
      await fs.writeFile(targetPath, malformedPrevious);
      await expect(
        writeCanonicalHeadingCopy(
          source,
          targetPath,
          'localized fixture',
          malformedPrevious,
        ),
      ).rejects.toThrow('Invalid canonicalHeadingIds metadata');
      await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe(
        malformedPrevious,
      );
    } finally {
      consoleError.mockRestore();
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('refreshes generated metadata once and then leaves it unchanged', async () => {
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'heading-anchors-'),
    );
    const sourcePath = path.join(temporaryDirectory, 'source.mdx');
    const localizedPath = path.join(temporaryDirectory, 'localized.mdx');
    try {
      await fs.writeFile(sourcePath, '---\ntitle: Source\n---\n\n## Stable\n');
      await fs.writeFile(
        localizedPath,
        '---\ntitle: Localized\n---\n\n## 翻訳済み\n',
      );

      await expect(
        refreshLocalizedHeadingIds(sourcePath, [localizedPath]),
      ).resolves.toEqual([localizedPath]);
      await expect(
        refreshLocalizedHeadingIds(sourcePath, [localizedPath]),
      ).resolves.toEqual([]);

      await fs.writeFile(
        sourcePath,
        '---\ntitle: Source\n---\n\n### Renamed\n',
      );
      await expect(
        refreshLocalizedHeadingIds(sourcePath, [localizedPath]),
      ).resolves.toEqual([localizedPath]);
      const relevelled = await fs.readFile(localizedPath, 'utf8');
      expect(
        parseFrontmatter(relevelled).frontmatter.canonicalHeadingIds,
      ).toEqual([{ depth: 2, id: 'renamed', aliases: ['stable', '翻訳済み'] }]);
      expect(parseFrontmatter(relevelled).content).toContain('## 翻訳済み');
      await expect(
        refreshLocalizedHeadingIds(sourcePath, [localizedPath]),
      ).resolves.toEqual([]);

      await fs.writeFile(
        sourcePath,
        '---\ntitle: Source\n---\n\n## Added\n\n### Renamed\n',
      );
      await expect(
        refreshLocalizedHeadingIds(sourcePath, [localizedPath]),
      ).resolves.toEqual([]);
      await expect(fs.readFile(localizedPath, 'utf8')).resolves.toBe(
        relevelled,
      );
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('rejects known invalid inputs before translation requests and preserves legacy aliases', async () => {
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'translation-heading-inputs-'),
    );
    const sourcePath = path.join(temporaryDirectory, 'source.mdx');
    const targetPath = path.join(temporaryDirectory, 'localized.mdx');
    const source =
      '---\ntitle: Source\ndescription: English\n---\n\n## Stable heading\n';
    const previous =
      '---\ntitle: Previous\ndescription: Japanese\n---\n\n## 最初の見出し\n';
    const malformed = previous.replace(
      'description: Japanese',
      'description: Japanese\ncanonicalHeadingIds: invalid',
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const invalidInputs = [
        {
          source,
          previous: previous + '\n# Stable heading\n',
        },
        {
          source: source.replace('## Stable heading', 'Section\n-------'),
          previous,
        },
        {
          source: source.replace('## Stable heading', '## !!!'),
          previous,
        },
        {
          source,
          previous: previous.replace('## 最初の見出し', '## !!!'),
        },
        {
          source: source.replace(
            'description: English',
            'description: English\ncanonicalHeadingIds: invalid',
          ),
          previous,
        },
        {
          source,
          previous: previous.replace('## 最初の見出し', '## Hello {value}'),
        },
        { source, previous: malformed },
        {
          source,
          previous: previous.replace(
            'description: Japanese',
            'description: Japanese\ncanonicalHeadingIds:\n  - depth: 2\n    id: stable-heading\n    aliases: null',
          ),
        },
        {
          source,
          previous: previous.replace(
            'description: Japanese',
            'description: Japanese\ncanonicalHeadingIds:\n  - depth: 3\n    id: stable-heading\n    aliases: []',
          ),
        },
      ];
      for (const inputs of invalidInputs) {
        runTranslation.mockReset();
        await fs.writeFile(sourcePath, inputs.source);
        await fs.writeFile(targetPath, inputs.previous);
        await expect(
          translateFile(sourcePath, targetPath, 'ja'),
        ).rejects.toThrow();
        expect(runTranslation).not.toHaveBeenCalled();
        await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe(
          inputs.previous,
        );
      }

      await fs.writeFile(sourcePath, source);
      await fs.writeFile(targetPath, previous);
      runTranslation.mockReset();
      runTranslation
        .mockResolvedValueOnce({ finalOutput: '新しいタイトル' })
        .mockResolvedValueOnce({ finalOutput: '## 新しい見出し' });
      await translateFile(sourcePath, targetPath, 'ja');
      expect(runTranslation).toHaveBeenCalledTimes(2);
      const output = await fs.readFile(targetPath, 'utf8');
      expect(parseFrontmatter(output).frontmatter.canonicalHeadingIds).toEqual([
        {
          depth: 2,
          id: 'stable-heading',
          aliases: ['最初の見出し', '新しい見出し'],
        },
      ]);

      // Valid translations may lag behind English additions without blocking regeneration.
      await fs.writeFile(sourcePath, source + '\n## Added heading\n');
      await fs.writeFile(targetPath, previous);
      runTranslation.mockReset();
      runTranslation
        .mockResolvedValueOnce({ finalOutput: '新しいタイトル' })
        .mockResolvedValueOnce({
          finalOutput: '## 新しい見出し\n\n## 追加の見出し',
        });
      await translateFile(sourcePath, targetPath, 'ja');
      expect(runTranslation).toHaveBeenCalledTimes(2);
      expect(
        parseFrontmatter(await fs.readFile(targetPath, 'utf8')).frontmatter
          .canonicalHeadingIds,
      ).toEqual([
        { depth: 2, id: 'stable-heading', aliases: ['新しい見出し'] },
        { depth: 2, id: 'added-heading', aliases: ['追加の見出し'] },
      ]);
      await fs.writeFile(sourcePath, source);
      await fs.writeFile(targetPath, output);

      for (const [translated, message] of [
        ['### Wrong depth', 'heading levels do not match'],
        ['## !!!', 'empty anchor ID'],
        ['# 最初の見出し\n\n## 新しい見出し', 'identifies multiple headings'],
      ]) {
        runTranslation.mockReset();
        runTranslation
          .mockResolvedValueOnce({ finalOutput: 'タイトル' })
          .mockResolvedValueOnce({ finalOutput: translated });
        await expect(
          translateFile(sourcePath, targetPath, 'ja'),
        ).rejects.toThrow(message);
        expect(runTranslation).toHaveBeenCalledTimes(2);
        await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe(output);
      }
    } finally {
      vi.restoreAllMocks();
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('derives missing metadata during rendering without modifying content files', async () => {
    const contentRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'heading-build-'),
    );
    const sourcePath = path.join(contentRoot, 'guide.mdx');
    const source = '---\ntitle: Agents\n---\n\n## Agent fundamentals\n';
    const localized =
      '---\ntitle: エージェント\n---\n\n## エージェントの基本\n';
    const processor = await createMarkdownProcessor({
      syntaxHighlight: false,
      rehypePlugins: [[rehypeCanonicalHeadingIds, { contentRoot }]],
    });
    const render = (markdown: string, filePath: string) => {
      const { content, frontmatter } = parseFrontmatter(markdown);
      return processor.render(content, {
        frontmatter,
        fileURL: pathToFileURL(filePath),
      });
    };
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    try {
      await fs.writeFile(sourcePath, source);
      for (const locale of ['ja', 'ko', 'zh']) {
        const localizedPath = path.join(contentRoot, locale, 'guide.mdx');
        await fs.mkdir(path.dirname(localizedPath));
        await fs.writeFile(localizedPath, localized);
        const result = await render(localized, localizedPath);
        expect(result.code).toContain('<h2 id="agent-fundamentals">');
        expect(result.code).toContain(
          '<span id="エージェントの基本" aria-hidden="true"></span>',
        );
        expect(result.metadata.headings).toEqual([
          { depth: 2, slug: 'agent-fundamentals', text: 'エージェントの基本' },
        ]);
        await expect(fs.readFile(localizedPath, 'utf8')).resolves.toBe(
          localized,
        );
      }
      await expect(fs.readFile(sourcePath, 'utf8')).resolves.toBe(source);

      for (const filePath of [
        sourcePath,
        path.join(contentRoot, 'openai/agents/api.md'),
        path.join(contentRoot, '../ja/outside.md'),
      ]) {
        const result = await render('## Original heading', filePath);
        expect(result.metadata.headings[0].slug).toBe('original-heading');
      }
      await expect(
        render(localized, path.join(contentRoot, 'ja/missing.mdx')),
      ).rejects.toThrow('Cannot read the English heading source');
      await expect(
        render(
          localized + '\n# Agent fundamentals\n',
          path.join(contentRoot, 'ja/guide.mdx'),
        ),
      ).rejects.toThrow(
        'Heading ID "agent-fundamentals" identifies multiple headings',
      );
      const differentDepth = await render(
        localized.replace('## ', '### '),
        path.join(contentRoot, 'ja/guide.mdx'),
      );
      expect(differentDepth.metadata.headings[0]).toEqual({
        depth: 3,
        slug: 'agent-fundamentals',
        text: 'エージェントの基本',
      });
      await expect(
        render(
          localized.replace('## エージェントの基本', '> ## Nested'),
          path.join(contentRoot, 'ja/guide.mdx'),
        ),
      ).rejects.toThrow('Only top-level H2-H6 ATX Markdown headings');

      // Subsequent renders must not reuse IDs from an earlier source revision.
      await fs.writeFile(
        sourcePath,
        source.replace('Agent fundamentals', 'Updated fundamentals'),
      );
      const updated = await render(
        localized,
        path.join(contentRoot, 'ja/guide.mdx'),
      );
      expect(updated.metadata.headings[0].slug).toBe('updated-fundamentals');
    } finally {
      consoleError.mockRestore();
      await fs.rm(contentRoot, { recursive: true, force: true });
    }
  });

  test('uses current English IDs and preserves stored targets while translations lag', async () => {
    const contentRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'heading-drift-'),
    );
    const sourcePath = path.join(contentRoot, 'guide.mdx');
    const localizedPath = path.join(contentRoot, 'ja/guide.mdx');
    const source = '---\ntitle: Source\n---\n\n## First\n\n## Second\n';
    const localized = '---\ntitle: 翻訳\n---\n\n## 最初\n\n## 二番目\n';
    const withHistory = await preserveCanonicalHeadingIds(
      source,
      localized,
      'fixture',
    );
    const processor = await createMarkdownProcessor({
      syntaxHighlight: false,
      rehypePlugins: [[rehypeCanonicalHeadingIds, { contentRoot }]],
    });
    try {
      await fs.mkdir(path.dirname(localizedPath));
      for (const translation of [localized, withHistory]) {
        await fs.writeFile(localizedPath, translation);
        const { content, frontmatter } = parseFrontmatter(translation);
        for (const [currentSource, expectedIds] of [
          [source.replace('## First', '### Renamed'), ['renamed', 'second']],
          [source.replace('## First', '### First'), ['first', 'second']],
          [
            source.replace('## First', '## Added\n\n## First'),
            ['最初', '二番目'],
          ],
          [source.replace('\n## First\n', ''), ['最初', '二番目']],
        ] as const) {
          await fs.writeFile(sourcePath, currentSource);
          const result = await processor.render(content, {
            frontmatter,
            fileURL: pathToFileURL(localizedPath),
          });
          expect(result.metadata.headings).toEqual([
            {
              depth: 2,
              slug: expectedIds[0],
              text: '最初',
            },
            { depth: 2, slug: expectedIds[1], text: '二番目' },
          ]);
          for (const alias of [
            '最初',
            '二番目',
            ...(translation === withHistory ? ['first', 'second'] : []),
          ]) {
            expect(result.code).toContain(`id="${alias}"`);
          }
          expect(result.code).not.toContain('id="added"');
          await expect(fs.readFile(localizedPath, 'utf8')).resolves.toBe(
            translation,
          );
        }
      }
    } finally {
      await fs.rm(contentRoot, { recursive: true, force: true });
    }
  });

  test('renders canonical IDs from the unchanged checked-in locale corpus', async () => {
    const processor = await createMarkdownProcessor({
      syntaxHighlight: false,
      rehypePlugins: [[rehypeCanonicalHeadingIds, { contentRoot: DOCS_ROOT }]],
    });
    const sourceFiles: string[] = [];
    const collect = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await collect(entryPath);
        } else if (/\.mdx?$/.test(entry.name)) {
          sourceFiles.push(entryPath);
        }
      }
    };
    sourceFiles.push(path.join(DOCS_ROOT, 'index.mdx'));
    await collect(path.join(DOCS_ROOT, 'guides'));
    await collect(path.join(DOCS_ROOT, 'extensions'));

    for (const sourcePath of sourceFiles) {
      const relativePath = path.relative(DOCS_ROOT, sourcePath);
      const source = await fs.readFile(sourcePath, 'utf8');
      const sourceHeadings = await canonicalHeadingIds(source);
      for (const locale of ['ja', 'ko', 'zh']) {
        const localizedPath = path.join(DOCS_ROOT, locale, relativePath);
        const localized = await fs.readFile(localizedPath, 'utf8');
        const { content, frontmatter } = parseFrontmatter(localized);
        const rendered = await processor.render(content, {
          frontmatter,
          fileURL: pathToFileURL(localizedPath),
        });
        expect(
          rendered.metadata.headings
            .filter(({ depth }) => depth >= 2 && depth <= 6)
            .map(({ depth, slug }) => ({ depth, id: slug })),
          `${locale}/${relativePath}`,
        ).toEqual(sourceHeadings.map(({ depth, id }) => ({ depth, id })));
      }
    }
  }, 60_000);
});
