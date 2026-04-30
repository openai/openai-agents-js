import { z } from 'zod';
import { tool, type Tool } from '../../tool';
import {
  dir,
  file,
  type Dir,
  type Entry,
  type File,
  type GitRepo,
  type LocalDir,
  type LocalFile,
  isDir,
  isDirectoryLikeEntry,
} from '../entries';
import { SandboxSkillsConfigError } from '../errors';
import { normalizeRelativePath, type Manifest } from '../manifest';
import { prompt } from '../runtime/prompts';
import type { MaterializeEntryArgs } from '../session';
import { Capability, requireBoundSession } from './base';

export type SkillIndexEntry = {
  name: string;
  description: string;
  path?: string;
};

export type LocalDirLazySkillSource = {
  source: Dir | LocalDir | GitRepo;
  index?: SkillIndexEntry[];
};

export type SkillDescriptor = {
  name: string;
  description: string;
  content: string | Uint8Array | File | LocalFile;
  scripts?: Record<string, Entry>;
  references?: Record<string, Entry>;
  assets?: Record<string, Entry>;
  compatibility?: string[];
  deferred?: boolean;
};

export type SkillsArgs = {
  skills?: SkillDescriptor[];
  from?: Entry;
  lazyFrom?: LocalDirLazySkillSource;
  index?: SkillIndexEntry[];
  skillsPath?: string;
};

class SkillsCapability extends Capability {
  readonly type = 'skills';
  readonly skills: SkillDescriptor[];
  readonly from?: Entry;
  readonly lazyFrom?: LocalDirLazySkillSource;
  readonly index?: SkillIndexEntry[];
  readonly skillsPath: string;

  constructor(args: SkillsArgs) {
    super();
    this.skills = args.skills ?? [];
    this.from = args.from;
    this.lazyFrom = args.lazyFrom;
    this.index = args.index;
    this.skillsPath = normalizeRelativePath(args.skillsPath ?? '.agents');

    validateSkillsCapability(this);
  }

  override tools(): Tool<any>[] {
    if (!this.lazyFrom) {
      return [];
    }

    const session = requireBoundSession(this.type, this._session);
    if (!session.pathExists || !session.materializeEntry) {
      throw new SandboxSkillsConfigError(
        'Skills sandbox sessions must provide pathExists() and materializeEntry().',
      );
    }

    return [
      tool({
        name: 'load_skill',
        description:
          'Load a single lazily configured skill into the sandbox so its SKILL.md, scripts, references, and assets can be read from the workspace.',
        parameters: z.object({
          skill_name: z
            .string()
            .min(1)
            .describe('Name of the lazily configured skill to materialize.'),
        }),
        execute: async ({
          skill_name,
        }: {
          skill_name: string;
        }): Promise<{
          status: 'loaded' | 'already_loaded';
          skill_name: string;
          path: string;
        }> => {
          const match = resolveLazySkillMatch(this, skill_name);
          const relativeSkillPath = normalizeRelativePath(
            match.path ?? match.name,
          );
          const destinationPath = joinRelativePaths(
            this.skillsPath,
            relativeSkillPath,
          );
          const skillMarkdownPath = joinRelativePaths(
            destinationPath,
            'SKILL.md',
          );

          if (await session.pathExists!(skillMarkdownPath, this._runAs)) {
            return {
              status: 'already_loaded',
              skill_name: match.name,
              path: destinationPath,
            };
          }

          await session.materializeEntry!({
            path: destinationPath,
            entry: resolveLazySkillEntry(
              this.lazyFrom!.source,
              relativeSkillPath,
            ),
            runAs: this._runAs,
          } satisfies MaterializeEntryArgs);

          return {
            status: 'loaded',
            skill_name: match.name,
            path: destinationPath,
          };
        },
      }),
    ];
  }

  override processManifest(manifest: Manifest): Manifest {
    const existingPaths = new Set(
      Object.keys(manifest.entries).map((path) => normalizeRelativePath(path)),
    );

    if (this.lazyFrom) {
      const overlaps = [...existingPaths]
        .filter((path) => pathsOverlap(path, this.skillsPath))
        .sort();
      if (overlaps.length > 0) {
        throw new SandboxSkillsConfigError(
          `skills lazyFrom path overlaps existing manifest entries: ${overlaps.join(', ')}`,
        );
      }
      return manifest;
    }

    if (this.from) {
      const overlap = [...existingPaths].find((path) =>
        pathsOverlap(path, this.skillsPath),
      );
      if (overlap) {
        throw new SandboxSkillsConfigError(
          `skills path overlaps existing manifest entries: ${overlap}`,
        );
      }
      manifest.entries[this.skillsPath] = this.from;
      return manifest;
    }

    for (const skill of this.skills) {
      const skillPath = joinRelativePaths(this.skillsPath, skill.name);
      const overlap = [...existingPaths].find((path) =>
        pathsOverlap(path, skillPath),
      );
      if (overlap) {
        throw new SandboxSkillsConfigError(
          `skill path overlaps existing manifest entries: ${skillPath}`,
        );
      }
      manifest.entries[skillPath] = renderSkillDescriptor(skill);
      existingPaths.add(skillPath);
    }

    return manifest;
  }

  override async instructions(manifest: Manifest): Promise<string | null> {
    const metadata = resolveSkillsMetadata(
      this,
      await this.resolveRuntimeMetadata(manifest),
    );
    if (metadata.length === 0 && this.from) {
      return renderSkillsDiscoveryInstructions(this.skillsPath);
    }
    if (metadata.length === 0) {
      return null;
    }

    return renderSkillsInstructions({
      metadata,
      lazy: Boolean(this.lazyFrom),
    });
  }

  private async resolveRuntimeMetadata(
    _manifest: Manifest,
  ): Promise<SkillIndexEntry[]> {
    if (!this.from || !this._session?.listDir || !this._session.readFile) {
      return [];
    }

    let entries;
    try {
      entries = await this._session.listDir({
        path: this.skillsPath,
        runAs: this._runAs,
      });
    } catch {
      return [];
    }

    const metadata: SkillIndexEntry[] = [];
    for (const entry of entries) {
      if (entry.type !== 'dir') {
        continue;
      }

      let content: string | Uint8Array;
      try {
        content = await this._session.readFile({
          path: joinRelativePaths(entry.path, 'SKILL.md'),
          runAs: this._runAs,
        });
      } catch {
        continue;
      }

      const markdown =
        typeof content === 'string'
          ? content
          : new TextDecoder().decode(content);
      const frontmatter = parseSkillFrontmatter(markdown);
      metadata.push({
        name: frontmatter.name ?? entry.name,
        description: frontmatter.description ?? 'No description provided.',
        path: entry.name,
      });
    }

    return metadata;
  }
}

export type Skills = SkillsCapability;

export function skills(args: SkillsArgs): Skills;
export function skills(args: SkillsArgs): Skills {
  return new SkillsCapability(args);
}

const SKILLS_SECTION_INTRO = prompt`
A skill is a set of local instructions to follow that is stored in a \`SKILL.md\` file. Below is the list of skills that can be used. Each entry includes a name, description, and file path so you can open the source for full instructions when using a specific skill.
`;

const HOW_TO_USE_SKILLS_SECTION = prompt`
### How to use skills
- Discovery: The list above is the skills available in this session (name + description + file path). Skill bodies live on disk at the listed paths.
- Trigger rules: If the user names a skill (with \`$SkillName\` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.
- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback.
- How to use a skill (progressive disclosure):
  1) After deciding to use a skill, open its \`SKILL.md\`. Read only enough to follow the workflow.
  2) If \`SKILL.md\` points to extra folders such as \`references/\`, load only the specific files needed for the request; don't bulk-load everything.
  3) If \`scripts/\` exist, prefer running or patching them instead of retyping large code blocks.
  4) If \`assets/\` or templates exist, reuse them instead of recreating from scratch.
- Coordination and sequencing:
  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.
  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.
- Context hygiene:
  - Keep context small: summarize long sections instead of pasting them; only load extra files when needed.
  - Avoid deep reference-chasing: prefer opening only files directly linked from \`SKILL.md\` unless you're blocked.
  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.
- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue.
`;

const HOW_TO_USE_LAZY_SKILLS_SECTION = prompt`
### How to use skills
- Discovery: The list above is the skill index available in this session (name + description + workspace path). In lazy mode, those paths are loaded on demand instead of being present up front.
- Trigger rules: If the user names a skill (with \`$SkillName\` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.
- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback.
- How to use a skill (progressive disclosure):
  1) After deciding to use a lazy skill, call \`load_skill\` for that skill first, then open its \`SKILL.md\`.
  2) If \`SKILL.md\` points to extra folders such as \`references/\`, load only the specific files needed for the request; don't bulk-load everything.
  3) If \`scripts/\` exist, prefer running or patching them instead of retyping large code blocks.
  4) If \`assets/\` or templates exist, reuse them instead of recreating from scratch.
- Coordination and sequencing:
  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.
  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.
- Context hygiene:
  - Keep context small: summarize long sections instead of pasting them; only load extra files when needed.
  - Avoid deep reference-chasing: prefer opening only files directly linked from \`SKILL.md\` unless you're blocked.
  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.
- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue.
`;

function validateSkillsCapability(capability: SkillsCapability): void {
  const configuredSources = [
    capability.skills.length > 0,
    Boolean(capability.from),
    Boolean(capability.lazyFrom),
  ].filter(Boolean).length;

  if (configuredSources === 0) {
    throw new SandboxSkillsConfigError(
      'skills capability requires `skills`, `from`, or `lazyFrom`.',
    );
  }
  if (configuredSources > 1) {
    throw new SandboxSkillsConfigError(
      'skills capability accepts only one of `skills`, `from`, or `lazyFrom`.',
    );
  }
  if (capability.from && !isDirectoryLikeEntry(capability.from)) {
    throw new SandboxSkillsConfigError(
      'skills from must be a directory-like entry such as dir, git_repo, or mount.',
    );
  }

  const seenSkillNames = new Set<string>();
  for (const skill of capability.skills) {
    const normalizedName = normalizeRelativePath(skill.name);
    if (seenSkillNames.has(normalizedName)) {
      throw new SandboxSkillsConfigError(`duplicate skill name: ${skill.name}`);
    }
    seenSkillNames.add(normalizedName);
  }
}

function renderSkillDescriptor(skill: SkillDescriptor): Dir {
  const children: Record<string, Entry> = {
    'SKILL.md': normalizeSkillContent(skill.content),
  };

  if (skill.scripts && Object.keys(skill.scripts).length > 0) {
    children.scripts = dir({
      children: skill.scripts,
    });
  }
  if (skill.references && Object.keys(skill.references).length > 0) {
    children.references = dir({
      children: skill.references,
    });
  }
  if (skill.assets && Object.keys(skill.assets).length > 0) {
    children.assets = dir({
      children: skill.assets,
    });
  }

  return dir({
    children,
  });
}

function normalizeSkillContent(
  content: SkillDescriptor['content'],
): File | LocalFile {
  if (typeof content === 'string' || content instanceof Uint8Array) {
    return file({
      content,
    });
  }

  return content;
}

function resolveSkillsMetadata(
  capability: SkillsCapability,
  runtimeMetadata: SkillIndexEntry[] = [],
): SkillIndexEntry[] {
  if (capability.skills.length > 0) {
    return capability.skills
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        path: joinRelativePaths(capability.skillsPath, skill.name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  const configuredIndex =
    resolveLazySkillIndex(capability.lazyFrom) ??
    capability.index ??
    (runtimeMetadata.length > 0 ? runtimeMetadata : undefined) ??
    deriveIndexFromDirEntry(capability.from);

  return configuredIndex
    .map((skill) => ({
      ...skill,
      path: joinRelativePaths(
        capability.skillsPath,
        skill.path ?? normalizeRelativePath(skill.name),
      ),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function parseSkillFrontmatter(
  markdown: string,
): Record<string, string> {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return {};
  }

  const endIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === '---',
  );
  if (endIndex === -1) {
    return {};
  }

  const metadata: Record<string, string> = {};
  for (const line of lines.slice(1, endIndex)) {
    const stripped = line.trim();
    const delimiterIndex = stripped.indexOf(':');
    if (!stripped || stripped.startsWith('#') || delimiterIndex === -1) {
      continue;
    }

    const key = stripped.slice(0, delimiterIndex).trim();
    const rawValue = stripped.slice(delimiterIndex + 1).trim();
    if (!key) {
      continue;
    }
    metadata[key] = unquoteFrontmatterValue(rawValue);
  }

  return metadata;
}

function unquoteFrontmatterValue(value: string): string {
  if (
    value.length >= 2 &&
    value[0] === value[value.length - 1] &&
    (value[0] === '"' || value[0] === "'")
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function resolveLazySkillIndex(
  lazySource: LocalDirLazySkillSource | undefined,
): SkillIndexEntry[] | undefined {
  if (!lazySource) {
    return undefined;
  }
  if (lazySource.index) {
    return lazySource.index;
  }

  const derivedIndex = deriveIndexFromDirEntry(lazySource.source);
  return derivedIndex.length > 0 ? derivedIndex : undefined;
}

function deriveIndexFromDirEntry(entry: Entry | undefined): SkillIndexEntry[] {
  if (!entry || !isDir(entry) || !entry.children) {
    return [];
  }

  return Object.entries(entry.children)
    .filter(([, child]) => child.type === 'dir')
    .map(([name, child]) => ({
      name,
      description: child.description ?? 'No description provided.',
    }));
}

function renderSkillsDiscoveryInstructions(skillsPath: string): string {
  return prompt`
## Skills
${SKILLS_SECTION_INTRO}

### Skill source
- Skills are materialized under ${skillsPath}. Discover available skills by inspecting child directories and their SKILL.md files at runtime.

${HOW_TO_USE_SKILLS_SECTION}
`;
}

function renderSkillsInstructions(args: {
  metadata: SkillIndexEntry[];
  lazy: boolean;
}): string {
  const availableSkills = args.metadata
    .map(
      (skill) =>
        `- ${skill.name}: ${skill.description} (file: ${skill.path ?? skill.name})`,
    )
    .join('\n');
  const lazyLoadingInstructions = args.lazy
    ? prompt`
### Lazy loading
- These skills are indexed for planning, but they are not materialized in the workspace yet.
- Call \`load_skill\` with a single skill name from the list before reading its \`SKILL.md\` or other files from the workspace.
- \`load_skill\` stages exactly one skill under the listed path. If you need more than one skill, call it multiple times.
`
    : '';
  const usageInstructions = args.lazy
    ? HOW_TO_USE_LAZY_SKILLS_SECTION
    : HOW_TO_USE_SKILLS_SECTION;
  const lazyLoadingSection = lazyLoadingInstructions
    ? `${lazyLoadingInstructions}\n\n`
    : '';

  return prompt`
## Skills
${SKILLS_SECTION_INTRO}

### Available skills
${availableSkills}

${lazyLoadingSection}${usageInstructions}
`;
}

function resolveLazySkillMatch(
  capability: SkillsCapability,
  skillName: string,
): SkillIndexEntry {
  const index =
    resolveLazySkillIndex(capability.lazyFrom) ?? capability.index ?? [];
  const matches = index.filter((skill) => {
    const relativePath = normalizeRelativePath(skill.path ?? skill.name);
    const pathBaseName = relativePath.split('/').pop() ?? relativePath;
    return (
      skill.name === skillName ||
      relativePath === skillName ||
      pathBaseName === skillName
    );
  });

  if (matches.length === 0) {
    throw new SandboxSkillsConfigError(`lazy skill not found: ${skillName}`);
  }
  if (matches.length > 1) {
    throw new SandboxSkillsConfigError(
      `lazy skill name is ambiguous: ${skillName}`,
    );
  }

  return matches[0];
}

function joinRelativePaths(left: string, right: string): string {
  const normalizedLeft = normalizeRelativePath(left);
  const normalizedRight = normalizeRelativePath(right);

  if (!normalizedLeft) {
    return normalizedRight;
  }
  if (!normalizedRight) {
    return normalizedLeft;
  }

  return `${normalizedLeft}/${normalizedRight}`;
}

function joinSourcePath(sourceRoot: string, relativePath: string): string {
  const trimmedRoot = sourceRoot.replace(/[\\/]+$/, '');
  if (!trimmedRoot) {
    return relativePath;
  }

  return `${trimmedRoot}/${relativePath}`;
}

function resolveLazySkillEntry(
  source: LocalDirLazySkillSource['source'],
  relativeSkillPath: string,
): Entry {
  if (source.type === 'local_dir') {
    if (!source.src) {
      throw new SandboxSkillsConfigError(
        'Lazy skill local_dir sources require a concrete src value.',
      );
    }
    return {
      ...source,
      type: 'local_dir',
      src: joinSourcePath(source.src, relativeSkillPath),
    };
  }

  if (source.type === 'git_repo') {
    const baseSubpath = source.subpath
      ? normalizeRelativePath(source.subpath)
      : '';
    return {
      ...source,
      type: 'git_repo',
      subpath: joinRelativePaths(baseSubpath, relativeSkillPath),
    };
  }

  if (source.type === 'dir') {
    const child = readDirChild(source, relativeSkillPath);
    if (!child) {
      throw new SandboxSkillsConfigError(
        `lazy skill source path not found: ${relativeSkillPath}`,
      );
    }
    return child;
  }

  throw new SandboxSkillsConfigError(
    `Lazy skill source type is not supported yet: ${(source as Entry).type}`,
  );
}

function readDirChild(
  source: Dir,
  relativeSkillPath: string,
): Entry | undefined {
  let current: Entry | undefined = source;
  for (const segment of normalizeRelativePath(relativeSkillPath).split('/')) {
    if (!segment) {
      continue;
    }
    if (!current || !isDir(current) || !current.children) {
      return undefined;
    }
    current = current.children[segment];
  }
  return current;
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}
