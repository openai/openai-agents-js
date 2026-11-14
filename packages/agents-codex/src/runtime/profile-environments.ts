import type { CapturedAgentProfile } from './agent-profiles';
import {
  acquireEnvironment,
  type EnvironmentAcquisition,
} from './environment-source';

/** Current acquisitions; pending Sources have no native executor authority. */
export class ProfileEnvironments extends Map<string, EnvironmentAcquisition> {
  readonly deferred = new Set<string>();
  private readonly pending = new Map<string, CapturedAgentProfile<any, any>>();

  constructor(
    private readonly declarations: readonly CapturedAgentProfile<any, any>[],
    private readonly root: EnvironmentAcquisition,
    deferSources: boolean,
  ) {
    super();
    for (const [index, profile] of declarations.entries()) {
      this.set(profile.id, root);
      if (
        deferSources &&
        index !== 0 &&
        typeof profile.declaration.environment === 'function'
      ) {
        this.deferred.add(profile.id);
        this.pending.set(profile.id, profile);
      }
    }
  }

  async prepare(
    id: string,
    signal: AbortSignal,
  ): Promise<EnvironmentAcquisition> {
    const profile = this.pending.get(id);
    if (!profile) return this.get(id)!;
    const owner = await acquireEnvironment(
      profile.declaration.environment,
      AbortSignal.any([this.root.signal, signal]),
    );
    await this.root.adoptProfile(owner);
    signal.throwIfAborted();
    this.root.signal.throwIfAborted();
    this.set(id, owner);
    this.pending.delete(id);
    this.validate();
    return owner;
  }

  validate(): void {
    if (![...this.values()].some((owner) => owner !== this.root)) return;
    if (
      [...this.values()].some(
        ({ environment }) =>
          environment &&
          (environment.approval ||
            environment.transformArguments ||
            environment.transformResult),
      )
    )
      throw new TypeError(
        'Distinct Agent executor hooks require profile-owned interception',
      );
    if (
      this.declarations.some(
        (profile) => profile.declaration.realtime !== undefined,
      )
    )
      throw new TypeError(
        'Distinct Agent resources require a captured non-Realtime roster',
      );
  }
}

/** Open direct declarations; defer destination Sources until captured admission. */
export async function acquireProfileEnvironments(
  profiles: readonly CapturedAgentProfile<any, any>[],
  root: EnvironmentAcquisition,
  deferSources = true,
): Promise<ProfileEnvironments> {
  const owners = new ProfileEnvironments(profiles, root, deferSources);
  for (const [index, profile] of profiles.entries()) {
    const source = profile.declaration.environment;
    if (
      index !== 0 &&
      source !== undefined &&
      !owners.deferred.has(profile.id)
    ) {
      const owner = await acquireEnvironment(source, root.signal);
      await root.adoptProfile(owner);
      owners.set(profile.id, owner);
    }
    root.signal.throwIfAborted();
  }
  owners.validate();
  if (
    owners.deferred.size &&
    profiles.some((profile) => profile.declaration.realtime !== undefined)
  )
    throw new TypeError(
      'Deferred Agent resources require a captured non-Realtime roster',
    );
  return owners;
}
