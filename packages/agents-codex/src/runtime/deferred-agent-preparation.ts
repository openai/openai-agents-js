import type { AgentProfileRuntime } from './agent-profiles';
import type { JsonObject } from './binding';
import type { EnvironmentAcquisition } from './environment-source';
import type { ProfileEnvironments } from './profile-environments';
import type {
  SandboxCapabilityLease,
  SandboxWorkspacePreparation,
} from './sandbox-capabilities';

type PreparedDestination = Readonly<{
  runtime: AgentProfileRuntime;
  declaration: JsonObject;
  owner: EnvironmentAcquisition;
}>;

/** The captured destination callback owns acquisition; Core still owns admission. */
export class DeferredAgentPreparation {
  private readonly prepared = new Map<string, PreparedDestination>();
  private readonly confirmed = new Set<string>();
  private failureOwner?: Pick<SandboxCapabilityLease, 'failWorkspace'>;

  constructor(
    readonly resources: ProfileEnvironments,
    private readonly build: (
      id: string,
      owner: EnvironmentAcquisition,
    ) => Promise<Omit<PreparedDestination, 'owner'>>,
    private readonly fallback?: Pick<
      SandboxCapabilityLease,
      'prepareWorkspace' | 'failWorkspace'
    >,
  ) {}

  async capture(
    id: string,
    signal: AbortSignal,
    check: () => void,
    opening = false,
  ): Promise<PreparedDestination> {
    check();
    const existing = this.prepared.get(id);
    if (existing) return existing;
    if (!this.resources.deferred.has(id))
      throw new TypeError('Destination has no captured Environment Source');
    const owner = await this.resources.prepare(id, signal);
    check();
    const captured = await this.build(id, owner);
    check();
    signal.throwIfAborted();
    if (!opening) owner.opened();
    const prepared = Object.freeze({ ...captured, owner });
    this.prepared.set(id, prepared);
    return prepared;
  }

  declaration(id: string): JsonObject | undefined {
    return this.prepared.get(id)?.declaration;
  }

  runtime(id: string): AgentProfileRuntime | undefined {
    return this.prepared.get(id)?.runtime;
  }

  configured(id: string): void {
    if (this.prepared.has(id)) this.confirmed.add(id);
  }

  confirm(id: string, generation: bigint): AgentProfileRuntime | undefined {
    const prepared = this.prepared.get(id);
    if (!prepared || this.confirmed.has(id)) return;
    this.confirmed.add(id);
    return Object.freeze({
      ...prepared.runtime,
      catalog: Object.freeze({ ...prepared.runtime.catalog, generation }),
    });
  }

  async prepareWorkspace(
    id: string,
    signal: AbortSignal,
    check: () => void,
  ): Promise<SandboxWorkspacePreparation> {
    if (!this.resources.deferred.has(id)) {
      if (!this.fallback)
        throw new TypeError('Workspace target has no captured preparation');
      this.failureOwner = this.fallback;
      return this.fallback.prepareWorkspace(id, signal, check);
    }
    const prepared = await this.capture(id, signal, check);
    const capability = prepared.owner.sandboxCapabilities;
    this.failureOwner = capability?.hasManifestChanges ? capability : undefined;
    const workspace = capability?.hasManifestChanges
      ? await capability.prepareWorkspace(id, signal, check)
      : {
          instructions: prepared.runtime.instructions,
          workspace_instructions:
            prepared.owner.profileWorkspaceInstructions ??
            prepared.owner.workspaceInstructions ??
            '',
        };
    check();
    signal.throwIfAborted();
    return {
      ...workspace,
      ...(!this.confirmed.has(id) ? { profile: prepared.declaration } : {}),
    };
  }

  async failWorkspace(error: unknown): Promise<never> {
    if (this.failureOwner) return this.failureOwner.failWorkspace(error);
    // Session retirement has been joining callbacks before acquisition disposal.
    throw error;
  }
}
