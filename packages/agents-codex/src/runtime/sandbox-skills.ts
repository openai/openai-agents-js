import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  createSkillConfiguration,
  getSandboxStateIdentity,
  isDeserializedSandboxState,
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
  known?: ReadonlySet<string>,
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
  readonly retained: Set<string>;
  bytes: number;
  members: number;
  tail: Promise<void>;
  needsRecount: boolean;
};
// Retained manifest entries outlive acquisition leases. Trusted state aliases
// share their physical owner; dropping an Environment never resets its budget.
const sandboxSkillBudgets = new WeakMap<object, SandboxSkillBudget>();
function sandboxSkillBudget(sandbox: SandboxSessionLike): SandboxSkillBudget {
  const owner = getSandboxStateIdentity(sandbox.state);
  let budget = sandboxSkillBudgets.get(owner);
  if (!budget) {
    budget = {
      retained: new Set(),
      bytes: 0,
      members: 0,
      tail: Promise.resolve(),
      needsRecount: isDeserializedSandboxState(sandbox.state),
    };
    sandboxSkillBudgets.set(owner, budget);
  }
  return budget;
}

// Restored captures already carry their accepted payloads in the provider manifest.
// Saved manifests do not distinguish captured skills from other inline files.
// Charge retained File/Dir payloads across namespaces only when lineage is lost.
// Seed inside the shared load queue; acquisition inspection must never await it.
function seedRestoredSkillBudget(
  budget: SandboxSkillBudget,
  manifest: Manifest,
): void {
  if (!budget.needsRecount) return;
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
  for (const path of additions) budget.retained.add(path);
  budget.members = members;
  budget.bytes = bytes;
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
    for (const [path, entry] of entries) {
      signal.throwIfAborted();
      if (grantStamp(sandbox.state.manifest) !== expectedGrants)
        throw new Error(
          'Sandbox skill grants do not match the current manifest',
        );
      await sandbox.materializeEntry({ path, entry });
      signal.throwIfAborted();
      if (grantStamp(sandbox.state.manifest) !== expectedGrants)
        throw new Error('Sandbox skill grants changed during materialization');
    }
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
  ) {
    this.#sandbox = sandbox;
    this.#budget = sandboxSkillBudget(sandbox);
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
    seedRestoredSkillBudget(this.#budget, sandbox.state.manifest);
    if (!sandbox.pathExists || !sandbox.materializeEntry)
      throw new Error(
        'Skills require sandbox pathExists() and materializeEntry()',
      );
    const exists = await sandbox.pathExists(
      joinRelativePaths(destination, 'SKILL.md'),
    );
    this.admit();
    signal.throwIfAborted();
    if (!exists) {
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
      await sandbox.materializeEntry({ path: destination, entry });
      // Successful writes retain these bytes even if the caller then observes cancellation.
      this.#budget.members += usage.members;
      this.#budget.bytes += usage.bytes;
      this.#budget.retained.add(destination);
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
