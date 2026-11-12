import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  createSkillConfiguration,
  beforeGitRepoCopy,
  gitRepoCopiesTree,
  getSandboxStateIdentity,
  getLocalSandboxStateAuthority,
  isDeserializedSandboxState,
  isSandboxPathNotFoundError,
  resolveSkillRuntimeMetadata,
  resolveSkillsMetadata,
  renderSkillsDiscoveryInstructions,
  renderSkillsInstructions,
  resolveLazySkillEntry,
  joinRelativePaths,
  modelWorkspaceResourcePath,
  type Manifest,
  type SkillConfiguration,
  type SkillIndexEntry,
  type SkillsArgs,
} from '@openai/agents-core/sandbox/internal';
import type { Entry, SandboxSessionLike } from '@openai/agents-core/sandbox';
import type { Environment } from './environment';
import {
  tool,
  _nativeSandboxSkillLease,
  type FunctionTool,
  type ToolCallContext,
} from './tools';

type SkillLoadResult = { status: string; skill_name: string; path: string };
type SkillTreeUsage = { members: number; bytes: number };
const treeLimits = Object.freeze({
  maxMembers: 4096,
  maxDepth: 32,
  maxBytes: 64 * 1024 * 1024,
});

function capturedTreeUsage(
  entry: Entry,
  maxMembers: number = treeLimits.maxMembers,
  maxBytes: number = treeLimits.maxBytes,
  path = '',
  known?: ReadonlyMap<string, unknown>,
): SkillTreeUsage {
  const usage = { members: 0, bytes: 0 };
  const pending = [{ entry, path }];
  while (pending.length) {
    const current = pending.pop()!;
    if (known?.has(current.path)) continue;
    if (++usage.members > maxMembers)
      throw new Error('Skill tree member limit exceeded');
    if (current.entry.type === 'file') {
      const content = current.entry.content;
      if (typeof content !== 'string' && !(content instanceof Uint8Array))
        throw new Error('Captured skill file requires bytes or text');
      const remaining = maxBytes - usage.bytes;
      if (content.length > remaining)
        throw new Error('Skill tree byte limit exceeded');
      usage.bytes +=
        typeof content === 'string'
          ? Buffer.byteLength(content)
          : content.byteLength;
      if (usage.bytes > maxBytes)
        throw new Error('Skill tree byte limit exceeded');
    } else if (current.entry.type === 'dir') {
      for (const name in current.entry.children ?? {}) {
        if (!Object.prototype.hasOwnProperty.call(current.entry.children, name))
          continue;
        const childPath = joinRelativePaths(current.path, name);
        if (known?.has(childPath)) continue;
        if (usage.members + pending.length >= maxMembers)
          throw new Error('Skill tree member limit exceeded');
        pending.push({ entry: current.entry.children![name], path: childPath });
      }
    } else throw new Error('Captured skill tree contains an unsupported entry');
  }
  return usage;
}

type SandboxSkillBudget = {
  readonly retained: Map<string, 'incomplete' | 'complete'>;
  bytes: number;
  members: number;
  tail: Promise<void>;
  needsRecount: boolean;
};
// Retained manifest entries outlive acquisition leases. Trusted state aliases
// share their physical owner; dropping an Environment never resets its budget.
const sandboxSkillBudgets = new WeakMap<object, SandboxSkillBudget>();
function sandboxSkillBudget(
  sandbox: SandboxSessionLike,
  created?: boolean,
): SandboxSkillBudget {
  const owner = getSandboxStateIdentity(sandbox.state);
  let budget = sandboxSkillBudgets.get(owner);
  if (!budget) {
    budget = {
      retained: new Map(),
      bytes: 0,
      members: 0,
      tail: Promise.resolve(),
      needsRecount:
        created === false ||
        isDeserializedSandboxState(sandbox.state) ||
        (created !== true && !getLocalSandboxStateAuthority(sandbox.state)),
    };
    sandboxSkillBudgets.set(owner, budget);
  }
  return budget;
}

// The Source rebind may replace saved declarations before resume. Measure the
// current authorized workspace, and cover retained manifest payloads as well.
// Unknown cold lineage conservatively includes unrelated workspace files.
// Seed inside the shared load queue; acquisition inspection must never await it.
async function seedRestoredSkillBudget(
  budget: SandboxSkillBudget,
  sandbox: SandboxSessionLike,
  signal: AbortSignal,
  admit: () => void,
): Promise<void> {
  if (!budget.needsRecount) return;
  signal.throwIfAborted();
  admit();
  const authority = getLocalSandboxStateAuthority(sandbox.state);
  if (!authority)
    throw new Error(
      'The configured native Skills quota cannot be measured for this restored provider; use a fresh owned source',
    );
  // The verified provider binding supplies this root, never saved path fields.
  // The existing capture bounds traversal and uses retained, nonblocking reads.
  const restored = await resolveLazySkillEntry(
    { type: 'local_dir', src: authority.workspaceRootPath },
    '',
    {
      limits: treeLimits,
      sourceGrants: [{ path: authority.workspaceRootPath, readOnly: true }],
    },
  );
  signal.throwIfAborted();
  admit();
  const physical = capturedTreeUsage(restored);
  const manifest = sandbox.state.manifest;
  const additions = new Set<string>();
  let members = budget.members,
    bytes = budget.bytes;
  for (const path in manifest.entries) {
    if (
      !Object.prototype.hasOwnProperty.call(manifest.entries, path) ||
      budget.retained.has(path)
    )
      continue;
    const entry = manifest.entries[path];
    if (entry.type !== 'file' && entry.type !== 'dir') continue;
    const usage = capturedTreeUsage(
      entry,
      treeLimits.maxMembers - members,
      treeLimits.maxBytes - bytes,
      path,
      budget.retained,
    );
    members += usage.members;
    bytes += usage.bytes;
    additions.add(path);
  }
  for (const path of additions) budget.retained.set(path, 'complete');
  budget.members = Math.max(members, physical.members);
  budget.bytes = Math.max(bytes, physical.bytes);
  budget.needsRecount = false;
}

const metadataLimits = Object.freeze({
  maxEntries: 1024,
  maxFileBytes: 64 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
});

export type Skills = SkillConfiguration;
export type {
  SkillsArgs,
  SkillDescriptor,
  SkillIndexEntry,
  LocalDirLazySkillSource,
} from '@openai/agents-core/sandbox/internal';

/** Resource declarations, explicitly selected through sandboxEnvironment(). */
export function skills(args: SkillsArgs): Skills {
  return Object.freeze(createSkillConfiguration(args));
}

function grantStamp(manifest: Manifest): string {
  return JSON.stringify([
    manifest.root,
    manifest.extraPathGrants.map(({ path, readOnly, hostPath }) => [
      path,
      readOnly,
      hostPath,
    ]),
  ]);
}

function remotePath(path: string): URL {
  return path.startsWith('file:')
    ? new URL(path)
    : pathToFileURL(path, { windows: false });
}

function within(path: string, root: string): boolean {
  const child = remotePath(path);
  const parent = remotePath(root);
  const prefix = parent.pathname.replace(/\/+$/, '');
  return (
    child.host === parent.host &&
    (child.pathname === prefix || child.pathname.startsWith(`${prefix}/`))
  );
}

/** @internal Stable tool identity; mutable resource state belongs to each acquisition. */
export class SandboxSkillBinding<Context = any> {
  readonly tools: readonly FunctionTool<Context>[];

  constructor(readonly configuration: Skills) {
    this.tools = Object.freeze(
      configuration.lazyFrom
        ? [
            tool({
              name: 'load_skill',
              description:
                'Load one indexed skill into the current sandbox before reading its SKILL.md and supporting files.',
              parameters: z.object({ skill_name: z.string().min(1) }),
              errorFunction: null,
              before: (context) => {
                this.admit(context);
                return { action: 'allow' };
              },
              execute: ({ skill_name }, context) =>
                this.admit(context).load(skill_name, context.signal),
            }),
          ]
        : [],
    );
  }

  async stageOwnedResume(
    sandbox: SandboxSessionLike,
    trustedManifest: Manifest,
    entries: readonly [string, Entry][],
    signal: AbortSignal,
  ): Promise<void> {
    if (!sandbox.materializeEntry)
      throw new Error(
        'Eager resumed Skills require sandbox materializeEntry()',
      );
    const expectedGrants = grantStamp(trustedManifest);
    if (grantStamp(sandbox.state.manifest) !== expectedGrants)
      throw new Error('Sandbox skill grants do not match the current manifest');
    const cleanRestored = async (declaredPaths: readonly string[]) => {
      const stale = await this.restoredEagerSkillFiles(
        sandbox,
        declaredPaths,
        signal,
      );
      if (stale.length) {
        const remove = sandbox.removeEntryNoFollow?.bind(sandbox);
        const editor = remove ? undefined : sandbox.createEditor?.();
        if (!remove && (stale.some(({ directory }) => directory) || !editor))
          throw new Error(
            'Restored eager Skills require confined empty-directory removal',
          );
        for (const { path } of stale) {
          signal.throwIfAborted();
          if (grantStamp(sandbox.state.manifest) !== expectedGrants)
            throw new Error('Sandbox skill grants changed before cleanup');
          if (remove) await remove(path);
          else {
            const result = await editor!.deleteFile({
              type: 'delete_file',
              path,
            });
            if (result?.status === 'failed')
              throw new Error('Could not remove a restored eager skill file');
          }
        }
      }
    };
    const copiedGitRoot = entries.find(
      ([path, entry]) =>
        path === this.configuration.skillsPath &&
        entry.type === 'git_repo' &&
        gitRepoCopiesTree(entry),
    );
    if (copiedGitRoot && !sandbox[beforeGitRepoCopy])
      throw new Error(
        'Restored eager Git Skills require source preparation support',
      );
    if (!copiedGitRoot)
      await cleanRestored(
        entries.flatMap(([path, entry]) =>
          path === this.configuration.skillsPath && entry.type === 'dir'
            ? Object.keys(entry.children ?? {}).map((name) =>
                joinRelativePaths(path, name),
              )
            : [path],
        ),
      );
    for (const [path, entry] of entries) {
      signal.throwIfAborted();
      if (grantStamp(sandbox.state.manifest) !== expectedGrants)
        throw new Error(
          'Sandbox skill grants do not match the current manifest',
        );
      let prepared = false;
      const prepare =
        copiedGitRoot?.[1] === entry
          ? async (children: readonly string[]) => {
              if (prepared)
                throw new Error('Git skill source was prepared more than once');
              prepared = true;
              await cleanRestored([
                path,
                ...children.map((name) => joinRelativePaths(path, name)),
              ]);
            }
          : undefined;
      await sandbox.materializeEntry({
        path,
        entry,
        [beforeGitRepoCopy]: prepare,
      });
      if (prepare && !prepared)
        throw new Error(
          'Restored eager Git Skills require source preparation support',
        );
      signal.throwIfAborted();
      if (grantStamp(sandbox.state.manifest) !== expectedGrants)
        throw new Error('Sandbox skill grants changed during materialization');
    }
  }

  private async restoredEagerSkillFiles(
    sandbox: SandboxSessionLike,
    declaredPaths: readonly string[],
    signal: AbortSignal,
  ): Promise<{ path: string; directory: boolean }[]> {
    const listDir = sandbox.listDir?.bind(sandbox);
    if (!listDir)
      throw new Error('Restored eager Skills require sandbox listDir()');
    const removeOpaqueDirectories =
      declaredPaths.includes(this.configuration.skillsPath) &&
      Boolean(sandbox.removeEntryNoFollow);
    let remaining = treeLimits.maxMembers;
    const list = async (path: string, missingAllowed = false) => {
      signal.throwIfAborted();
      const children = await listDir({ path, maxEntries: remaining }).catch(
        (error: unknown) => {
          if (missingAllowed && isSandboxPathNotFoundError(error)) return [];
          throw error;
        },
      );
      remaining -= children.length;
      if (remaining < 0) throw new Error('Skill tree member limit exceeded');
      return children.map(({ name, type }) => {
        if (
          !name ||
          name === '.' ||
          name === '..' ||
          name.includes('/') ||
          name.includes('\\') ||
          name.includes('\0')
        )
          throw new Error(
            'Restored skill tree contains an invalid member name',
          );
        return { name, type, path: joinRelativePaths(path, name) };
      });
    };
    const files: { path: string; directory: boolean }[] = [];
    for (const root of await list(this.configuration.skillsPath, true)) {
      const declared = declaredPaths.includes(root.path);
      if (root.type !== 'dir') {
        if (declared) {
          if (root.type !== 'file')
            throw new Error(
              'Restored skill tree contains an unsupported member',
            );
          files.push({ path: root.path, directory: false });
        }
        continue;
      }
      if (
        !declared &&
        sandbox.pathExists &&
        !(await sandbox.pathExists(joinRelativePaths(root.path, 'SKILL.md')))
      )
        continue;
      const children = await list(root.path);
      if (
        !declared &&
        !children.some(
          ({ name, type }) => name === 'SKILL.md' && type !== 'dir',
        )
      )
        continue;
      const pending = children.map((child) => ({ ...child, depth: 1 }));
      while (pending.length) {
        const member = pending.pop()!;
        if (member.depth > treeLimits.maxDepth)
          throw new Error('Skill tree depth limit exceeded');
        if (member.type === 'file')
          files.push({ path: member.path, directory: false });
        else if (member.type === 'dir') {
          // Opaque eager sources do not expose their current child names here.
          // A retained sentinel identifies a managed root; only a confined
          // provider primitive may remove its emptied directories.
          if (declared || removeOpaqueDirectories)
            files.push({ path: member.path, directory: true });
          const children = await list(member.path);
          pending.push(
            ...children.map((child) => ({ ...child, depth: member.depth + 1 })),
          );
        } else
          throw new Error('Restored skill tree contains an unsupported member');
      }
    }
    return files.sort(
      (a, b) => b.path.split('/').length - a.path.split('/').length,
    );
  }

  private admit(context: ToolCallContext): SandboxSkillLease {
    context.signal.throwIfAborted();
    const lease = _nativeSandboxSkillLease(context);
    if (!lease || lease.binding !== this)
      throw new Error('Skill loader belongs to a different sandbox source');
    lease.admit();
    return lease;
  }
}

/** @internal Retired with the existing Environment lease, after native callback joining. */
export class SandboxSkillLease {
  #sandbox?: SandboxSessionLike;
  #environment?: Environment;
  #index: SkillIndexEntry[] = [];
  #active = false;
  readonly #grants: string;
  readonly #budget: SandboxSkillBudget;

  constructor(
    readonly binding: SandboxSkillBinding,
    sandbox: SandboxSessionLike,
    environment: Environment,
    trustedManifest: Manifest,
    readonly workspaceRoot: string,
    created?: boolean,
  ) {
    this.#sandbox = sandbox;
    this.#budget = sandboxSkillBudget(sandbox, created);
    this.#environment = environment;
    this.#grants = grantStamp(trustedManifest);
  }

  get environment(): Environment | undefined {
    return this.#environment;
  }

  private modelPath(path: string): string {
    return modelWorkspaceResourcePath(this.workspaceRoot, path);
  }

  private checkPaths(metadata: readonly SkillIndexEntry[] = []): void {
    const environment = this.#environment!;
    const paths = [
      this.binding.configuration.skillsPath,
      ...metadata.map((item) => item.path ?? item.name),
    ];
    for (const path of paths) {
      if (
        !(environment.capabilityDirectories ?? []).some((root) =>
          within(this.modelPath(path), root),
        )
      ) {
        throw new Error(
          'Skill paths require a selected current Environment capability directory',
        );
      }
    }
  }

  async activate(): Promise<string | null> {
    // Current configuration, not an older borrowed session, supplies source grants.
    if (grantStamp(this.#sandbox!.state.manifest) !== this.#grants)
      throw new Error('Sandbox skill grants do not match the current manifest');
    // Namespace admission precedes an application index callback or filesystem read.
    this.checkPaths();
    const configuration = this.binding.configuration;
    const sandbox = this.#sandbox!;
    const runtime = await resolveSkillRuntimeMetadata(
      configuration,
      sandbox,
      undefined,
      metadataLimits,
    );
    const metadata = resolveSkillsMetadata(
      configuration,
      runtime,
      sandbox.state.manifest,
      metadataLimits,
    );
    if (grantStamp(sandbox.state.manifest) !== this.#grants)
      throw new Error('Sandbox skill grants changed during index discovery');
    this.checkPaths(metadata);
    this.#index = metadata;
    this.#active = true;
    const rendered = metadata.map((item) => ({
      ...item,
      path: this.modelPath(item.path ?? item.name),
    }));
    if (rendered.length)
      return renderSkillsInstructions({
        metadata: rendered,
        lazy: Boolean(configuration.lazyFrom),
      });
    return configuration.from
      ? renderSkillsDiscoveryInstructions(
          this.modelPath(configuration.skillsPath),
        )
      : null;
  }

  admit(): void {
    if (!this.#active || !this.#sandbox || !this.#environment)
      throw new Error('Sandbox skill source has been retired');
    if (grantStamp(this.#sandbox.state.manifest) !== this.#grants)
      throw new Error('Sandbox skill grants have changed');
    this.checkPaths(this.#index);
  }

  async load(name: string, signal: AbortSignal): Promise<SkillLoadResult> {
    this.admit();
    signal.throwIfAborted();
    const configuration = this.binding.configuration;
    const matches = this.#index.filter((item) => {
      const destination = item.path ?? item.name;
      const relative = configuration.skillsPath
        ? destination.slice(configuration.skillsPath.length + 1)
        : destination;
      return (
        item.name === name ||
        relative === name ||
        relative.split('/').pop() === name
      );
    });
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? `Lazy skill name is ambiguous: ${name}`
          : `Lazy skill not found: ${name}`,
      );
    const match = matches[0];
    // Admission stays with this lease; each queued caller retains its own signal.
    const pending = this.#budget.tail.then(() =>
      this.loadDestination(match, signal),
    );
    this.#budget.tail = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }

  private async loadDestination(
    match: SkillIndexEntry,
    signal: AbortSignal,
  ): Promise<SkillLoadResult> {
    this.admit();
    signal.throwIfAborted();
    const configuration = this.binding.configuration;
    const destination = match.path ?? match.name;
    const sandbox = this.#sandbox!;
    if (!sandbox.pathExists || !sandbox.materializeEntry)
      throw new Error(
        'Skills require sandbox pathExists() and materializeEntry()',
      );
    if (this.#budget.retained.get(destination) === 'incomplete')
      throw new Error(
        'Skill materialization is incomplete in this workspace; use a fresh workspace',
      );
    const exists = await sandbox.pathExists(
      joinRelativePaths(destination, 'SKILL.md'),
    );
    this.admit();
    signal.throwIfAborted();
    if (!exists) {
      await seedRestoredSkillBudget(this.#budget, sandbox, signal, () =>
        this.admit(),
      );
      const relative = configuration.skillsPath
        ? destination.slice(configuration.skillsPath.length + 1)
        : destination;
      // Provider directory writes overlay existing contents. Never credit an old
      // capture while its physical assets could survive a replacement.
      const occupied =
        this.#budget.retained.has(destination) ||
        (await sandbox.pathExists(destination));
      this.admit();
      signal.throwIfAborted();
      if (occupied)
        throw new Error(
          'Skill destination cannot be reloaded in this workspace; restore SKILL.md or use a fresh workspace',
        );
      const entry = await resolveLazySkillEntry(
        configuration.lazyFrom!.source,
        relative,
        {
          limits: {
            maxMembers: treeLimits.maxMembers - this.#budget.members,
            maxDepth: treeLimits.maxDepth,
            maxBytes: treeLimits.maxBytes - this.#budget.bytes,
          },
          sourceGrants: sandbox.state.manifest.extraPathGrants,
        },
      );
      this.admit();
      signal.throwIfAborted();
      if (
        entry.type !== 'dir' ||
        !Object.prototype.hasOwnProperty.call(
          entry.children ?? {},
          'SKILL.md',
        ) ||
        entry.children?.['SKILL.md']?.type !== 'file'
      ) {
        throw new Error('Captured skill requires a regular SKILL.md');
      }
      const usage = capturedTreeUsage(entry);
      // Reserve under the shared load queue before provider I/O: a failed
      // materialization can leave partial files. Never refund an attempted write.
      this.#budget.members += usage.members;
      this.#budget.bytes += usage.bytes;
      this.#budget.retained.set(destination, 'incomplete');
      await sandbox.materializeEntry({ path: destination, entry });
      this.#budget.retained.set(destination, 'complete');
      this.admit();
      signal.throwIfAborted();
    }
    return {
      status: exists ? 'already_loaded' : 'loaded',
      skill_name: match.name,
      path: this.modelPath(destination),
    };
  }

  retire(): void {
    this.#active = false;
    this.#index = [];
    this.#sandbox = undefined;
    this.#environment = undefined;
  }
}
