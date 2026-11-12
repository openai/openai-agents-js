import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  createSkillConfiguration,
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

function capturedTreeUsage(entry: Entry): SkillTreeUsage {
  if (entry.type === 'file')
    return {
      members: 1,
      bytes:
        typeof entry.content === 'string'
          ? Buffer.byteLength(entry.content)
          : entry.content.byteLength,
    };
  if (entry.type !== 'dir')
    throw new Error('Captured skill tree contains an unsupported entry');
  const usage = { members: 1, bytes: 0 };
  for (const child of Object.values(entry.children ?? {})) {
    const next = capturedTreeUsage(child);
    usage.members += next.members;
    usage.bytes += next.bytes;
  }
  return usage;
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
  readonly #retained = new Map<string, SkillTreeUsage>();
  #retainedBytes = 0;
  #retainedMembers = 0;
  #loadTail: Promise<void> = Promise.resolve();

  constructor(
    readonly binding: SandboxSkillBinding,
    sandbox: SandboxSessionLike,
    environment: Environment,
    trustedManifest: Manifest,
    readonly workspaceRoot: string,
  ) {
    this.#sandbox = sandbox;
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
    const pending = this.#loadTail.then(() =>
      this.loadDestination(match, signal),
    );
    this.#loadTail = pending.then(
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
    const exists = await sandbox.pathExists(
      joinRelativePaths(destination, 'SKILL.md'),
    );
    this.admit();
    signal.throwIfAborted();
    if (!exists) {
      const relative = configuration.skillsPath
        ? destination.slice(configuration.skillsPath.length + 1)
        : destination;
      const previous = this.#retained.get(destination) ?? {
        members: 0,
        bytes: 0,
      };
      const entry = await resolveLazySkillEntry(
        configuration.lazyFrom!.source,
        relative,
        {
          limits: {
            maxMembers:
              treeLimits.maxMembers - this.#retainedMembers + previous.members,
            maxDepth: treeLimits.maxDepth,
            maxBytes:
              treeLimits.maxBytes - this.#retainedBytes + previous.bytes,
          },
          sourceGrants: sandbox.state.manifest.extraPathGrants,
        },
      );
      this.admit();
      signal.throwIfAborted();
      const usage = capturedTreeUsage(entry);
      await sandbox.materializeEntry({ path: destination, entry });
      // Successful writes retain these bytes even if the caller then observes cancellation.
      if (this.#active) {
        this.#retainedMembers += usage.members - previous.members;
        this.#retainedBytes += usage.bytes - previous.bytes;
        this.#retained.set(destination, usage);
      }
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
    this.#retained.clear();
    this.#retainedBytes = 0;
    this.#retainedMembers = 0;
    this.#sandbox = undefined;
    this.#environment = undefined;
  }
}
