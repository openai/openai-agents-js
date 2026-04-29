import type { AgentInputItem } from '../../types';
import type { Model } from '../../model';
import type { Tool } from '../../tool';
import { SandboxConfigurationError } from '../errors';
import type { Manifest } from '../manifest';
import type { SandboxSessionLike } from '../session';
import type { SandboxUser } from '../users';

export type CapabilityInstructionsResult =
  | string
  | null
  | Promise<string | null>;

export abstract class Capability {
  abstract readonly type: string;

  protected _session?: SandboxSessionLike;
  protected _runAs?: string;
  protected _modelInstance?: Model;

  clone(): this {
    const cloned = Object.create(Object.getPrototypeOf(this)) as this;

    for (const [key, value] of Object.entries(this)) {
      if (key === '_session' || key === '_runAs' || key === '_modelInstance') {
        continue;
      }
      (cloned as Record<string, unknown>)[key] = cloneCapabilityValue(value);
    }

    return cloned;
  }

  bind(session: SandboxSessionLike): this {
    this._session = session;
    return this;
  }

  bindRunAs(runAs?: string | SandboxUser): this {
    this._runAs = typeof runAs === 'string' ? runAs : runAs?.name;
    return this;
  }

  bindModel(_model: string, modelInstance?: Model): this {
    this._modelInstance = modelInstance;
    return this;
  }

  requiredCapabilityTypes(): Set<string> {
    return new Set();
  }

  tools(): Tool<any>[] {
    return [];
  }

  processManifest(manifest: Manifest): Manifest {
    return manifest;
  }

  instructions(_manifest: Manifest): CapabilityInstructionsResult {
    return null;
  }

  samplingParams(
    _samplingParams: Record<string, unknown>,
  ): Record<string, unknown> {
    return {};
  }

  processContext(context: AgentInputItem[]): AgentInputItem[] {
    return context;
  }
}

export type ConfigureCapabilityTools = (tools: Tool<any>[]) => Tool<any>[];

export function requireBoundSession(
  capabilityType: string,
  session?: SandboxSessionLike,
): SandboxSessionLike {
  if (!session) {
    throw new SandboxConfigurationError(
      `${capitalize(capabilityType)} capability is not bound to a SandboxSession`,
      { capability: capabilityType },
    );
  }

  return session;
}

function cloneCapabilityValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneCapabilityValue(item));
  }
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  if (value instanceof Map) {
    return new Map(value);
  }
  if (value instanceof Set) {
    return new Set(value);
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, childValue]) => [
        key,
        cloneCapabilityValue(childValue),
      ]),
    );
  }

  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
