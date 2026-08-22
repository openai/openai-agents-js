import fs from 'fs/promises';
import path from 'path';
import {
  createMarkdownProcessor,
  parseFrontmatter,
} from '@astrojs/markdown-remark';
import remarkMdx from 'remark-mdx';

export const CANONICAL_HEADING_IDS_FIELD = 'canonicalHeadingIds';

export type CanonicalHeadingId = {
  depth: number;
  id: string;
  aliases: string[];
};

type StoredHeadingId = Omit<CanonicalHeadingId, 'aliases'> & {
  aliases?: string[];
};

type HeadingSyntaxNode = {
  type: string;
  depth?: number;
  name?: string | null;
  value?: string;
  children?: HeadingSyntaxNode[];
  position?: {
    start: {
      offset?: number;
    };
  };
};

type MarkdownFile = {
  value: unknown;
};

let markdownProcessorPromise:
  ReturnType<typeof createMarkdownProcessor> | undefined;

function markdownProcessor() {
  markdownProcessorPromise ??= createMarkdownProcessor({
    syntaxHighlight: false,
    remarkPlugins: [remarkMdx, remarkValidateCanonicalHeadings],
    rehypePlugins: [rehypeRejectUnsupportedHeadings],
  });
  return markdownProcessorPromise;
}

function withoutFrontmatter(markdown: string): string {
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return markdown;
  }
  const frontmatterEnd = lines.findIndex(
    (line, index) => index > 0 && line.trim() === '---',
  );
  if (frontmatterEnd < 0) {
    throw new Error('Documentation has unterminated frontmatter.');
  }
  return lines.slice(frontmatterEnd + 1).join(newline);
}

function containsMdxSyntax(node: HeadingSyntaxNode): boolean {
  if (node.type.startsWith('mdx')) {
    return true;
  }
  return (node.children ?? []).some(containsMdxSyntax);
}

function remarkValidateCanonicalHeadings() {
  return (tree: HeadingSyntaxNode, file: MarkdownFile): void => {
    const markdown = String(file.value);
    const visit = (
      node: HeadingSyntaxNode,
      parent: HeadingSyntaxNode | undefined,
    ): void => {
      if (
        node.type === 'heading' &&
        node.depth !== undefined &&
        node.depth >= 2 &&
        node.depth <= 6
      ) {
        if (parent?.type !== 'root') {
          throw new Error(
            'Only top-level H2-H6 ATX Markdown headings are supported in localized documentation.',
          );
        }
        const offset = node.position?.start.offset;
        const firstLine =
          offset === undefined
            ? ''
            : markdown.slice(offset).split(/\r?\n/, 1)[0];
        const marker = firstLine.match(/^ {0,3}(#{2,6})(?:[ \t]+|$)/);
        if (!marker || marker[1].length !== node.depth) {
          throw new Error(
            'Only top-level H2-H6 ATX Markdown headings are supported in localized documentation.',
          );
        }
        if ((node.children ?? []).some(containsMdxSyntax)) {
          throw new Error(
            'Dynamic MDX syntax is not supported in localized documentation headings; use static Markdown text.',
          );
        }
      }

      const rawHeading =
        node.type === 'html' &&
        typeof node.value === 'string' &&
        /<h[2-6](?:\s|\/?>)/i.test(node.value);
      const mdxHeading =
        node.type.startsWith('mdxJsx') &&
        typeof node.name === 'string' &&
        /^h[2-6]$/i.test(node.name);
      if (rawHeading || mdxHeading) {
        throw new Error(
          'Unsupported raw or MDX H2-H6 heading; use a top-level ATX Markdown heading.',
        );
      }

      for (const child of node.children ?? []) {
        visit(child, node);
      }
    };

    visit(tree, undefined);
  };
}

export function assertNoUnsupportedHeadingNodes(
  node: HeadingSyntaxNode,
  name: string,
): void {
  const rawHeading =
    node.type === 'raw' &&
    typeof node.value === 'string' &&
    /<h[2-6](?:\s|\/?>)/i.test(node.value);
  const mdxHeading =
    node.type.startsWith('mdxJsx') &&
    typeof node.name === 'string' &&
    /^h[2-6]$/i.test(node.name);
  if (rawHeading || mdxHeading) {
    throw new Error(
      `Unsupported raw or MDX H2-H6 heading in ${name}; use an ATX Markdown heading.`,
    );
  }
  for (const child of node.children ?? []) {
    assertNoUnsupportedHeadingNodes(child, name);
  }
}

function rehypeRejectUnsupportedHeadings() {
  return (tree: HeadingSyntaxNode): void => {
    assertNoUnsupportedHeadingNodes(tree, 'documentation');
  };
}

async function documentHeadingIds(
  markdown: string,
): Promise<CanonicalHeadingId[]> {
  const body = withoutFrontmatter(markdown);

  const processor = await markdownProcessor();
  const rendered = await processor.render(body);
  const headings = rendered.metadata.headings;

  return headings.map(({ depth, slug }) => {
    if (depth >= 2 && slug.length === 0) {
      throw new Error(
        'Documentation heading produces an empty anchor ID; use heading text with letters or numbers.',
      );
    }
    return { depth, id: slug, aliases: [] };
  });
}

export async function canonicalHeadingIds(
  markdown: string,
): Promise<CanonicalHeadingId[]> {
  return (await documentHeadingIds(markdown)).filter(({ depth }) => depth >= 2);
}

function quoteYamlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function serializedHeadingIds(headings: CanonicalHeadingId[]): string[] {
  if (headings.length === 0) {
    return [`${CANONICAL_HEADING_IDS_FIELD}: []`];
  }
  return [
    `${CANONICAL_HEADING_IDS_FIELD}:`,
    ...headings.flatMap(({ depth, id, aliases }) => {
      const serializedAliases =
        aliases.length === 0
          ? ['    aliases: []']
          : [
              '    aliases:',
              ...aliases.map((alias) => `      - ${quoteYamlString(alias)}`),
            ];
      return [
        `  - depth: ${depth}`,
        `    id: ${quoteYamlString(id)}`,
        ...serializedAliases,
      ];
    }),
  ];
}

function storedHeadingIds(
  markdown: string,
  name: string,
): CanonicalHeadingId[] | undefined {
  let rawMetadata: unknown;
  try {
    rawMetadata =
      parseFrontmatter(markdown).frontmatter[CANONICAL_HEADING_IDS_FIELD];
  } catch (error) {
    throw new Error(
      `Cannot parse heading metadata in ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (rawMetadata === undefined) {
    return undefined;
  }
  if (!Array.isArray(rawMetadata)) {
    throw new Error(
      `Invalid ${CANONICAL_HEADING_IDS_FIELD} metadata in ${name}.`,
    );
  }

  return rawMetadata.map((value: unknown) => {
    if (typeof value !== 'object' || value === null) {
      throw new Error(
        `Invalid ${CANONICAL_HEADING_IDS_FIELD} metadata in ${name}.`,
      );
    }
    const record = value as StoredHeadingId;
    const aliases = record.aliases === undefined ? [] : record.aliases;
    if (
      typeof record.depth !== 'number' ||
      !Number.isInteger(record.depth) ||
      record.depth < 2 ||
      record.depth > 6 ||
      typeof record.id !== 'string' ||
      record.id.length === 0 ||
      !Array.isArray(aliases) ||
      !aliases.every(
        (alias): alias is string =>
          typeof alias === 'string' && alias.length > 0,
      ) ||
      new Set(aliases).size !== aliases.length ||
      aliases.includes(record.id)
    ) {
      throw new Error(
        `Invalid ${CANONICAL_HEADING_IDS_FIELD} metadata in ${name}.`,
      );
    }
    return { depth: record.depth, id: record.id, aliases };
  });
}

function mergeAliases(canonicalId: string, ...groups: string[][]): string[] {
  return [...new Set(groups.flat().filter((alias) => alias !== canonicalId))];
}

function assertNoHeadingIdentityCollisions(
  headings: CanonicalHeadingId[],
  name: string,
  reservedIds: string[] = [],
): void {
  const owners = new Map(reservedIds.map((id) => [id, -1]));
  for (const [index, heading] of headings.entries()) {
    for (const id of [heading.id, ...heading.aliases]) {
      const owner = owners.get(id);
      if (owner !== undefined && owner !== index) {
        throw new Error(
          `Heading ID ${JSON.stringify(id)} identifies multiple headings in ${name}.`,
        );
      }
      owners.set(id, index);
    }
  }
}

async function aliasHistoryByCanonicalId(
  markdown: string,
  name: string,
  sourceHeadings?: CanonicalHeadingId[],
): Promise<Map<string, string[]>> {
  const allHeadings = await documentHeadingIds(markdown);
  const localizedHeadings = allHeadings.filter(({ depth }) => depth >= 2);
  const history = storedHeadingIds(markdown, name);
  // Metadata-free lagging translations can be regenerated without guessing an offset.
  const stored =
    history ??
    (sourceHeadings?.length === localizedHeadings.length
      ? sourceHeadings
      : undefined);
  if (stored === undefined) {
    return new Map();
  }
  const storedDepths = stored.map(({ depth }) => depth);
  const localizedDepths = localizedHeadings.map(({ depth }) => depth);
  if (
    history !== undefined &&
    JSON.stringify(storedDepths) !== JSON.stringify(localizedDepths)
  ) {
    throw new Error(
      `Stored heading metadata does not match the localized headings in ${name}.`,
    );
  }

  const identities = stored.map((heading, index) => {
    const id =
      sourceHeadings?.length === stored.length
        ? sourceHeadings[index].id
        : heading.id;
    return {
      ...heading,
      id,
      aliases: mergeAliases(id, [heading.id], heading.aliases, [
        localizedHeadings[index].id,
      ]),
    };
  });
  assertNoHeadingIdentityCollisions(
    identities,
    name,
    allHeadings.filter(({ depth }) => depth === 1).map(({ id }) => id),
  );
  return new Map(identities.map(({ id, aliases }) => [id, aliases]));
}

export async function validateTranslationHeadingInputs(
  sourceMarkdown: string,
  previousLocalizedMarkdown: string | undefined,
  name: string,
): Promise<void> {
  const sourceHeadings = await canonicalHeadingIds(sourceMarkdown);
  await aliasHistoryByCanonicalId(sourceMarkdown, `${name} English source`);
  if (previousLocalizedMarkdown !== undefined) {
    const history = await aliasHistoryByCanonicalId(
      previousLocalizedMarkdown,
      name,
      sourceHeadings,
    );
    assertNoHeadingIdentityCollisions(
      sourceHeadings.map((heading) => ({
        ...heading,
        aliases: history.get(heading.id) ?? [],
      })),
      name,
    );
  }
}

function replaceFrontmatterHeadingIds(
  markdown: string,
  headings: CanonicalHeadingId[],
): string {
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    throw new Error('Localized documentation must start with frontmatter.');
  }
  const frontmatterEnd = lines.findIndex(
    (line, index) => index > 0 && line.trim() === '---',
  );
  if (frontmatterEnd < 0) {
    throw new Error('Localized documentation has unterminated frontmatter.');
  }

  const frontmatter = lines.slice(1, frontmatterEnd);
  const fieldIndex = frontmatter.findIndex((line) =>
    line.startsWith(`${CANONICAL_HEADING_IDS_FIELD}:`),
  );
  if (
    fieldIndex >= 0 &&
    frontmatter[fieldIndex].trim() !== `${CANONICAL_HEADING_IDS_FIELD}:` &&
    frontmatter[fieldIndex].trim() !== `${CANONICAL_HEADING_IDS_FIELD}: []`
  ) {
    throw new Error(
      `Cannot replace malformed ${CANONICAL_HEADING_IDS_FIELD} frontmatter.`,
    );
  }
  if (fieldIndex >= 0) {
    let fieldEnd = fieldIndex + 1;
    while (
      fieldEnd < frontmatter.length &&
      (/^\s/.test(frontmatter[fieldEnd]) || frontmatter[fieldEnd].trim() === '')
    ) {
      fieldEnd += 1;
    }
    frontmatter.splice(fieldIndex, fieldEnd - fieldIndex);
  }

  frontmatter.push(...serializedHeadingIds(headings));
  return [
    '---',
    ...frontmatter,
    '---',
    ...lines.slice(frontmatterEnd + 1),
  ].join(newline);
}

export async function preserveCanonicalHeadingIds(
  sourceMarkdown: string,
  localizedMarkdown: string,
  name: string,
  previousLocalizedMarkdown?: string,
): Promise<string> {
  const sourceHeadings = await canonicalHeadingIds(sourceMarkdown);
  return preserveCanonicalHeadingIdsFromSource(
    sourceHeadings,
    localizedMarkdown,
    name,
    previousLocalizedMarkdown,
  );
}

async function preserveCanonicalHeadingIdsFromSource(
  sourceHeadings: CanonicalHeadingId[],
  localizedMarkdown: string,
  name: string,
  previousLocalizedMarkdown?: string,
): Promise<string> {
  const allHeadings = await documentHeadingIds(localizedMarkdown);
  const localizedHeadings = allHeadings.filter(({ depth }) => depth >= 2);
  const sourceDepths = sourceHeadings.map(({ depth }) => depth);
  const localizedDepths = localizedHeadings.map(({ depth }) => depth);
  if (JSON.stringify(sourceDepths) !== JSON.stringify(localizedDepths)) {
    throw new Error(
      `Cannot preserve canonical heading IDs for ${name}: heading levels do not match the English source.`,
    );
  }

  const currentHistory = await aliasHistoryByCanonicalId(
    localizedMarkdown,
    name,
    sourceHeadings,
  );
  const previousHistory = previousLocalizedMarkdown
    ? await aliasHistoryByCanonicalId(
        previousLocalizedMarkdown,
        name,
        sourceHeadings,
      )
    : new Map<string, string[]>();
  const identities = sourceHeadings.map((heading, index) => ({
    ...heading,
    aliases: mergeAliases(
      heading.id,
      previousHistory.get(heading.id) ?? [],
      currentHistory.get(heading.id) ?? [],
      [localizedHeadings[index].id],
    ),
  }));
  assertNoHeadingIdentityCollisions(
    identities,
    name,
    allHeadings.filter(({ depth }) => depth === 1).map(({ id }) => id),
  );
  return replaceFrontmatterHeadingIds(localizedMarkdown, identities);
}

export async function refreshLocalizedHeadingIds(
  sourcePath: string,
  localizedPaths: string[],
): Promise<string[]> {
  const sourceMarkdown = await fs.readFile(sourcePath, 'utf8');
  const sourceHeadings = await canonicalHeadingIds(sourceMarkdown);
  const changed: string[] = [];
  for (const localizedPath of localizedPaths) {
    const localizedMarkdown = await fs.readFile(localizedPath, 'utf8');
    const name = path.relative(process.cwd(), localizedPath);
    const localizedHeadings = await canonicalHeadingIds(localizedMarkdown);
    if (sourceHeadings.length !== localizedHeadings.length) {
      // Validate available history, but keep a lagging snapshot until translation catches up.
      await aliasHistoryByCanonicalId(localizedMarkdown, name);
      continue;
    }
    const updated = await preserveCanonicalHeadingIdsFromSource(
      sourceHeadings.map((heading, index) => ({
        ...heading,
        depth: localizedHeadings[index].depth,
      })),
      localizedMarkdown,
      name,
    );
    if (updated !== localizedMarkdown) {
      await fs.writeFile(localizedPath, updated, 'utf8');
      changed.push(localizedPath);
    }
  }
  return changed;
}

export async function writeCanonicalHeadingCopy(
  sourceMarkdown: string,
  targetPath: string,
  name: string,
  previousLocalizedMarkdown?: string,
): Promise<void> {
  const output = await preserveCanonicalHeadingIds(
    sourceMarkdown,
    sourceMarkdown,
    name,
    previousLocalizedMarkdown,
  );
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, output, 'utf8');
}
