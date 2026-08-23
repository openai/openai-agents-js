import fs from 'node:fs/promises';
import path from 'node:path';
import { rehypeHeadingIds } from '@astrojs/markdown-remark';
import {
  assertNoUnsupportedHeadingNodes,
  canonicalHeadingIds,
  CANONICAL_HEADING_IDS_FIELD,
  type CanonicalHeadingId,
} from '../scripts/headingAnchors';

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

type AstroVFile = {
  path?: string;
  value: unknown;
  data: {
    astro?: {
      frontmatter?: Record<string, unknown>;
    };
  };
};

const assignLocalizedHeadingIds = rehypeHeadingIds() as unknown as (
  tree: HastNode,
  file: AstroVFile,
) => void;

function collectHeadings(node: HastNode, headings: HastNode[]): void {
  if (
    node.type === 'element' &&
    node.tagName &&
    /^h[1-6]$/.test(node.tagName)
  ) {
    headings.push(node);
  }
  for (const child of node.children ?? []) {
    collectHeadings(child, headings);
  }
}

function isCanonicalHeadingId(value: unknown): value is CanonicalHeadingId {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CanonicalHeadingId).depth === 'number' &&
    Number.isInteger((value as CanonicalHeadingId).depth) &&
    (value as CanonicalHeadingId).depth >= 2 &&
    (value as CanonicalHeadingId).depth <= 6 &&
    typeof (value as CanonicalHeadingId).id === 'string' &&
    (value as CanonicalHeadingId).id.length > 0 &&
    Array.isArray((value as CanonicalHeadingId).aliases) &&
    (value as CanonicalHeadingId).aliases.every(
      (alias) => typeof alias === 'string' && alias.length > 0,
    ) &&
    new Set((value as CanonicalHeadingId).aliases).size ===
      (value as CanonicalHeadingId).aliases.length &&
    !(value as CanonicalHeadingId).aliases.includes(
      (value as CanonicalHeadingId).id,
    )
  );
}

export function rehypeCanonicalHeadingIds({
  contentRoot,
}: {
  contentRoot: string;
}) {
  return async (tree: HastNode, file: AstroVFile): Promise<void> => {
    const rawMetadata =
      file.data.astro?.frontmatter?.[CANONICAL_HEADING_IDS_FIELD];
    let sourceHeadings: CanonicalHeadingId[] | undefined;
    if (file.path) {
      const [locale, ...sourceSegments] = path
        .relative(contentRoot, file.path)
        .split(path.sep);
      if (['ja', 'ko', 'zh'].includes(locale) && /\.mdx?$/.test(file.path)) {
        const sourcePath = path.join(contentRoot, ...sourceSegments);
        let source: string;
        try {
          source = await fs.readFile(sourcePath, 'utf8');
        } catch (error) {
          throw new Error(
            `Cannot read the English heading source ${sourcePath} for ${file.path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // Use the same syntax validation and Astro slug derivation as translation.
        await canonicalHeadingIds(String(file.value));
        sourceHeadings = await canonicalHeadingIds(source);
      }
    }
    if (rawMetadata === undefined && sourceHeadings === undefined) {
      return;
    }
    assertNoUnsupportedHeadingNodes(tree, file.path ?? 'documentation page');
    if (
      rawMetadata !== undefined &&
      (!Array.isArray(rawMetadata) || !rawMetadata.every(isCanonicalHeadingId))
    ) {
      throw new Error(
        `Invalid ${CANONICAL_HEADING_IDS_FIELD} metadata in ${file.path ?? 'documentation page'}.`,
      );
    }

    const allHeadings: HastNode[] = [];
    collectHeadings(tree, allHeadings);
    const headings = allHeadings.filter((heading) => heading.tagName !== 'h1');
    const renderedDepths = headings.map((heading) =>
      Number(heading.tagName?.slice(1)),
    );
    const stored = rawMetadata as CanonicalHeadingId[] | undefined;
    if (
      stored !== undefined &&
      JSON.stringify(renderedDepths) !==
        JSON.stringify(stored.map(({ depth }) => depth))
    ) {
      throw new Error(
        `Canonical heading metadata does not match the rendered headings in ${file.path ?? 'documentation page'}.`,
      );
    }

    assignLocalizedHeadingIds(tree, file);
    // A lagging translation has no reliable positional mapping after insertions or deletions.
    const current = sourceHeadings ?? stored;
    const canonicalIds = headings.map((heading, index) =>
      current?.length === headings.length
        ? current[index].id
        : heading.properties?.id,
    );
    const identityOwners = new Map<string, number>();
    for (const heading of allHeadings) {
      if (
        heading.tagName === 'h1' &&
        typeof heading.properties?.id === 'string'
      ) {
        identityOwners.set(heading.properties.id, -1);
      }
    }
    for (const [index, id] of canonicalIds.entries()) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error(
          `Astro did not assign a localized heading ID in ${file.path ?? 'documentation page'}.`,
        );
      }
      const owner = identityOwners.get(id);
      if (owner !== undefined && owner !== index) {
        throw new Error(
          `Heading ID ${JSON.stringify(id)} identifies multiple headings in ${file.path ?? 'documentation page'}.`,
        );
      }
      identityOwners.set(id, index);
    }
    for (const [index, heading] of headings.entries()) {
      heading.properties ??= {};
      const localizedId = heading.properties.id;
      const canonicalId = canonicalIds[index];
      if (typeof localizedId !== 'string' || localizedId.length === 0) {
        throw new Error(
          `Astro did not assign a localized heading ID in ${file.path ?? 'documentation page'}.`,
        );
      }
      heading.properties.id = canonicalId;
      const aliases = [
        ...new Set(
          [
            ...(stored ? [stored[index].id, ...stored[index].aliases] : []),
            localizedId,
          ].filter((alias) => alias !== canonicalId),
        ),
      ];
      for (const alias of aliases) {
        const owner = identityOwners.get(alias);
        if (owner !== undefined && owner !== index) {
          throw new Error(
            `Heading ID ${JSON.stringify(alias)} identifies multiple headings in ${file.path ?? 'documentation page'}.`,
          );
        }
        identityOwners.set(alias, index);
      }
      if (aliases.length > 0) {
        heading.children ??= [];
        heading.children.unshift(
          ...aliases.map((alias) => ({
            type: 'element',
            tagName: 'span',
            properties: { id: alias, ariaHidden: 'true' },
            children: [],
          })),
        );
      }
    }
  };
}
