import { createHash, timingSafeEqual } from 'node:crypto';
import { encode, parseNative } from './binding';
import { parseSessionState, type SessionState } from './state';
import type { EnvironmentSource } from './environment-source';

export function capturedWorkspaceJson(value: unknown): string {
  // Provider serializers use ordinary JSON omission for optional undefined fields.
  const captured: unknown = JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (typeof item === 'number' && !Number.isFinite(item))
        throw new TypeError(
          'Managed provider state must contain finite JSON values',
        );
      return item;
    }),
  );
  const canonical = (item: any): string => {
    if (item === null || typeof item !== 'object') return encode(item);
    if (Array.isArray(item)) return '[' + item.map(canonical).join(',') + ']';
    return (
      '{' +
      Object.keys(item)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(item[key]))
        .join(',') +
      '}'
    );
  };
  return canonical(captured);
}

function association(conversation: string, workspace: string): string {
  return createHash('sha256')
    .update(conversation)
    .update('\0')
    .update(workspace)
    .digest('hex');
}

/** Detached native conversation/workspace pair. Provider data never grants authority. */
export class ManagedWorkspaceCheckpoint {
  readonly conversationJson: string;
  readonly workspaceJson: string;
  readonly association: string;

  constructor(conversationJson: string, workspaceJson: string, digest: string) {
    if (
      [conversationJson, workspaceJson, digest].some(
        (value) => typeof value !== 'string',
      )
    )
      throw new TypeError('Managed checkpoint fields must be strings');
    const expected = association(conversationJson, workspaceJson);
    if (
      !/^[a-f0-9]{64}$/.test(digest) ||
      !timingSafeEqual(Buffer.from(digest), Buffer.from(expected))
    )
      throw new TypeError(
        'Managed conversation/workspace association does not match',
      );
    parseSessionState(conversationJson);
    const workspace = parseNative(workspaceJson);
    if (
      !workspace ||
      typeof workspace !== 'object' ||
      Array.isArray(workspace) ||
      Object.keys(workspace).sort().join(',') !== 'backendId,providerState' ||
      typeof (workspace as any).backendId !== 'string' ||
      !(workspace as any).providerState ||
      typeof (workspace as any).providerState !== 'object' ||
      Array.isArray((workspace as any).providerState) ||
      capturedWorkspaceJson(workspace) !== workspaceJson
    )
      throw new TypeError('Invalid managed provider receipt');
    this.conversationJson = conversationJson;
    this.workspaceJson = workspaceJson;
    this.association = digest;
    Object.freeze(this);
  }

  get conversation(): SessionState {
    return parseSessionState(this.conversationJson);
  }
  get workspace(): {
    backendId: string;
    providerState: Record<string, unknown>;
  } {
    return parseNative(this.workspaceJson) as {
      backendId: string;
      providerState: Record<string, unknown>;
    };
  }
  toJSON() {
    return {
      format: 'native-managed-workspace-v1' as const,
      conversation: this.conversationJson,
      workspace: this.workspaceJson,
      association: this.association,
    };
  }
  static fromJSON(source: string | unknown): ManagedWorkspaceCheckpoint {
    const value = typeof source === 'string' ? parseNative(source) : source;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !==
        'association,conversation,format,workspace' ||
      (value as any).format !== 'native-managed-workspace-v1'
    )
      throw new TypeError('Invalid managed checkpoint envelope');
    const data = value as Record<string, string>;
    return new ManagedWorkspaceCheckpoint(
      data.conversation,
      data.workspace,
      data.association,
    );
  }
  /** @internal Capture only after the existing retirement owner completes. */
  static _capture(
    conversation: SessionState,
    workspace: string,
  ): ManagedWorkspaceCheckpoint {
    const encoded = encode(conversation);
    return new ManagedWorkspaceCheckpoint(
      encoded,
      workspace,
      association(encoded, workspace),
    );
  }
}

export interface ManagedWorkspaceAuthorization {
  readonly authorizedReceipt?: string;
}
export interface ManagedWorkspaceBinding extends ManagedWorkspaceAuthorization {
  captureRequested: boolean;
  receipt?: string;
  capture?: Promise<ManagedWorkspaceCheckpoint>;
}
const managedSource = Symbol('managedWorkspaceSource');
type BoundSource = EnvironmentSource<any> & {
  [managedSource]?: ManagedWorkspaceAuthorization;
};
export function bindManagedWorkspaceSource<Context>(
  source: EnvironmentSource<Context>,
  authorization: ManagedWorkspaceAuthorization,
): EnvironmentSource<Context> {
  Object.defineProperty(source, managedSource, {
    value: Object.freeze(authorization),
  });
  return source;
}
export function managedWorkspaceSource(
  source: unknown,
): ManagedWorkspaceAuthorization | undefined {
  return typeof source === 'function'
    ? (source as BoundSource)[managedSource]
    : undefined;
}
export function validateManagedWorkspaceOpening(
  checkpoint: ManagedWorkspaceCheckpoint,
  source: unknown,
): { state: SessionState } {
  const captured = ManagedWorkspaceCheckpoint.fromJSON(checkpoint.toJSON());
  const binding = managedWorkspaceSource(source);
  if (
    !binding?.authorizedReceipt ||
    binding.authorizedReceipt !== captured.workspaceJson
  )
    throw new TypeError(
      'Managed resume requires matching current authorized serialized provider state',
    );
  return { state: captured.conversation };
}

/** @internal Exact paired opening, consumed only after current-authority preflight. */
export const managedWorkspaceRestore: unique symbol = Symbol(
  'managedWorkspaceRestore',
);
