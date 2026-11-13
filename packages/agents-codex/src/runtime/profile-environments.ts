import type { CapturedAgentProfile } from './agent-profiles';
import {
  acquireEnvironment,
  type EnvironmentAcquisition,
} from './environment-source';

/** Captured declarations have been opening their own resources before native admission. */
export async function acquireProfileEnvironments(
  profiles: readonly CapturedAgentProfile<any, any>[],
  root: EnvironmentAcquisition,
): Promise<ReadonlyMap<string, EnvironmentAcquisition>> {
  const owners = new Map<string, EnvironmentAcquisition>();
  for (const [index, profile] of profiles.entries()) {
    const source = profile.declaration.environment;
    let owner = root;
    if (index !== 0 && source !== undefined) {
      owner = await acquireEnvironment(source, root.signal);
      await root.adoptProfile(owner);
    }
    root.signal.throwIfAborted();
    owners.set(profile.id, owner);
  }
  if ([...owners.values()].some((owner) => owner !== root)) {
    if (
      [...owners.values()].some(
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
    if (profiles.some((profile) => profile.declaration.realtime !== undefined))
      throw new TypeError(
        'Distinct Agent resources require a captured non-Realtime roster',
      );
  }
  return owners;
}
