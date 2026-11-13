import type { Manifest } from '@openai/agents-core/sandbox/internal';
import type { SandboxSessionLike } from '@openai/agents-core/sandbox';

/** Native capability configuration and per-acquisition hooks. */
export interface SandboxCapability {
  readonly type: string;
  clone(): SandboxCapability;
  requiredCapabilityTypes?(): Iterable<string>;
  prepareManifest(manifest: Manifest): Manifest;
  bind(session: SandboxSessionLike, user?: string): unknown;
  bindRunAs?(user?: string): unknown;
  instructions(
    manifest: Manifest,
  ): string | null | undefined | Promise<string | null | undefined>;
}

type ManifestCopy = (manifest: Manifest) => Manifest;
export function captureSandboxCapabilities(
  input: readonly SandboxCapability[] | undefined,
  user: string | undefined,
):
  | {
      open(
        manifest: Manifest,
        copy: ManifestCopy,
        check: ManifestCopy,
        signal: AbortSignal,
      ): SandboxCapabilityLease;
    }
  | undefined {
  if (user !== undefined && (typeof user !== 'string' || !user.trim()))
    throw new TypeError('capabilityUser must be a nonempty string');
  if (input === undefined || (Array.isArray(input) && input.length === 0))
    return undefined;
  if (!Array.isArray(input))
    throw new TypeError('capabilities must be an array');
  const seen = new WeakSet<object>(input);
  const clone = (value: SandboxCapability): SandboxCapability => {
    if (!value || typeof value.clone !== 'function')
      throw new TypeError('Capabilities require clone()');
    const result = value.clone();
    if (result instanceof Promise) {
      void result.catch(() => {});
      throw new TypeError('Capability clone() must be synchronous');
    }
    if (!result || typeof result !== 'object' || seen.has(result))
      throw new TypeError(
        'Capability clone() must return a fresh configuration',
      );
    if (
      typeof result.type !== 'string' ||
      !result.type.trim() ||
      typeof result.clone !== 'function' ||
      typeof result.prepareManifest !== 'function' ||
      typeof result.bind !== 'function' ||
      typeof result.instructions !== 'function'
    )
      throw new TypeError('Invalid SandboxCapability lifecycle');
    seen.add(result);
    return result;
  };
  const templates = input.map(clone);
  return {
    open(manifest, copy, check, signal) {
      signal.throwIfAborted();
      const capabilities = templates.map(clone);
      const types = new Set(capabilities.map((value) => value.type));
      for (const capability of capabilities) {
        const required = [...(capability.requiredCapabilityTypes?.() ?? [])];
        if (required.some((type) => typeof type !== 'string' || !type.trim()))
          throw new TypeError(
            'Capability requirements must be nonempty strings',
          );
        const missing = required.filter((type) => !types.has(type));
        if (missing.length)
          throw new TypeError(
            `${capability.type} requires missing capabilities: ${missing.sort().join(', ')}`,
          );
      }
      let prepared = copy(manifest);
      for (const capability of capabilities) {
        prepared = check(capability.prepareManifest(prepared));
        signal.throwIfAborted();
      }
      return new SandboxCapabilityLease(
        capabilities,
        copy(prepared),
        user,
        copy,
        signal,
      );
    },
  };
}

export class SandboxCapabilityLease {
  private bound = false;
  private retired = false;
  constructor(
    private readonly capabilities: SandboxCapability[],
    readonly manifest: Manifest,
    private readonly user: string | undefined,
    private readonly copy: ManifestCopy,
    private readonly signal: AbortSignal,
  ) {}
  bind(session: SandboxSessionLike): void {
    if (this.bound || this.retired)
      throw new Error('Capability binding requires its fresh resource');
    this.signal.throwIfAborted();
    this.bound = true;
    for (const capability of this.capabilities) {
      const result = capability.bind(session, this.user);
      if (result !== undefined && result !== capability)
        throw new TypeError('Capability bind() must retain its clone');
      if (this.user !== undefined) capability.bindRunAs?.(this.user);
      this.signal.throwIfAborted();
    }
  }
  async instructions(manifest: Manifest): Promise<string | undefined> {
    if (!this.bound || this.retired)
      throw new Error('Capability instructions require their bound resource');
    const results = await Promise.allSettled(
      this.capabilities.map((capability) =>
        Promise.resolve().then(() =>
          capability.instructions(this.copy(manifest)),
        ),
      ),
    );
    this.signal.throwIfAborted();
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length === 1) throw failures[0].reason;
    if (failures.length)
      throw new AggregateError(
        failures.map((value) => value.reason),
        'Capability instructions failed',
      );
    const fragments = results.map(
      (result) => (result as PromiseFulfilledResult<unknown>).value,
    );
    if (fragments.some((value) => value != null && typeof value !== 'string'))
      throw new TypeError('Capability instructions must be text');
    return (
      fragments
        .filter(
          (value): value is string =>
            typeof value === 'string' && value.length > 0,
        )
        .join('\n\n') || undefined
    );
  }
  retire(): void {
    this.retired = true;
  }
}
