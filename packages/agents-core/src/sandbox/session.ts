import type { Editor } from '../editor';
import { UserError } from '../errors';
import type { ToolOutputImage } from '../tool';
import type { Entry } from './entries';
import type { Manifest } from './manifest';
import type { Snapshot } from './snapshot';

export const SANDBOX_SESSION_STATE_VERSION = 1 as const;

export type ExposedPortScheme = 'http' | 'ws';

export type ExposedPortEndpoint = {
  host: string;
  port: number;
  tls?: boolean;
  query?: string;
  protocol?: string;
  url?: string;
  [key: string]: unknown;
};

export type SandboxSessionStateEnvelope = {
  version: typeof SANDBOX_SESSION_STATE_VERSION;
  backendId: string;
  manifest: Record<string, unknown>;
  snapshot?: Snapshot | null;
  snapshotFingerprint?: string | null;
  snapshotFingerprintVersion?: string | null;
  workspaceReady: boolean;
  exposedPorts?: Record<string, ExposedPortEndpoint>;
  providerState: Record<string, unknown>;
};

export interface SandboxSessionState {
  manifest: Manifest;
  snapshot?: Snapshot | null;
  snapshotFingerprint?: string | null;
  snapshotFingerprintVersion?: string | null;
  workspaceReady?: boolean;
  environment?: Record<string, string>;
  exposedPorts?: Record<string, ExposedPortEndpoint>;
  [key: string]: unknown;
}

export type ExecCommandArgs = {
  cmd: string;
  workdir?: string;
  shell?: string;
  login?: boolean;
  tty?: boolean;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
  runAs?: string;
};

export type SandboxExecResult = {
  output: string;
  stdout: string;
  stderr: string;
  wallTimeSeconds: number;
  exitCode?: number | null;
  sessionId?: number;
  originalTokenCount?: number;
};

export type WriteStdinArgs = {
  sessionId: number;
  chars?: string;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
};

export type ViewImageArgs = {
  path: string;
  runAs?: string;
};

export type ReadFileArgs = {
  path: string;
  runAs?: string;
  maxBytes?: number;
};

export type ListDirectoryArgs = {
  path: string;
  runAs?: string;
};

export type SandboxDirectoryEntry = {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'other';
};

export type MaterializeEntryArgs = {
  path: string;
  entry: Entry;
  runAs?: string;
};

export type WorkspaceArchiveData = string | ArrayBuffer | Uint8Array;

export type SandboxSessionLifecycleOptions = {
  reason?: string;
  [key: string]: unknown;
};

export type SandboxPreStopHook = () => Promise<void> | void;

export function normalizeExposedPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new UserError('Exposed ports must be integers between 1 and 65535.');
  }
  return port;
}

export function exposedPortStateKey(port: number): string {
  return String(normalizeExposedPort(port));
}

export function recordExposedPortEndpoint(
  state: SandboxSessionState,
  endpoint: ExposedPortEndpoint,
  keyPort: number = endpoint.port,
): ExposedPortEndpoint {
  const normalizedEndpoint: ExposedPortEndpoint = {
    ...endpoint,
    port: normalizeExposedPort(endpoint.port),
    tls: endpoint.tls ?? false,
    query: endpoint.query ?? '',
  };
  state.exposedPorts = {
    ...(state.exposedPorts ?? {}),
    [exposedPortStateKey(keyPort)]: normalizedEndpoint,
  };
  return normalizedEndpoint;
}

export function getRecordedExposedPortEndpoint(
  state: SandboxSessionState,
  port: number,
): ExposedPortEndpoint | undefined {
  return state.exposedPorts?.[exposedPortStateKey(port)];
}

export function urlForExposedPort(
  endpoint: ExposedPortEndpoint,
  scheme: ExposedPortScheme,
): string {
  if (scheme !== 'http' && scheme !== 'ws') {
    throw new UserError('Exposed port URL schemes must be "http" or "ws".');
  }

  const tls = endpoint.tls ?? false;
  let prefix: string;
  if (scheme === 'http') {
    prefix = tls ? 'https' : 'http';
  } else {
    prefix = tls ? 'wss' : 'ws';
  }
  const defaultPort = tls ? 443 : 80;
  const host =
    endpoint.host.includes(':') && !endpoint.host.startsWith('[')
      ? `[${endpoint.host}]`
      : endpoint.host;
  const base =
    endpoint.port === defaultPort
      ? `${prefix}://${host}/`
      : `${prefix}://${host}:${endpoint.port}/`;
  const query = endpoint.query ?? '';
  return query ? `${base}?${query}` : base;
}

export interface SandboxSession<
  TState extends SandboxSessionState = SandboxSessionState,
> {
  state: TState;
  start?(options?: SandboxSessionLifecycleOptions): Promise<void>;
  running?(): Promise<boolean>;
  registerPreStopHook?(hook: SandboxPreStopHook): (() => void) | void;
  runPreStopHooks?(): Promise<void>;
  preStop?(options?: SandboxSessionLifecycleOptions): Promise<void>;
  stop?(options?: SandboxSessionLifecycleOptions): Promise<void>;
  shutdown?(options?: SandboxSessionLifecycleOptions): Promise<void>;
  delete?(options?: SandboxSessionLifecycleOptions): Promise<void>;
  createEditor?(runAs?: string): Editor;
  exec?(args: ExecCommandArgs): Promise<SandboxExecResult>;
  execCommand?(args: ExecCommandArgs): Promise<string>;
  writeStdin?(args: WriteStdinArgs): Promise<string>;
  viewImage?(args: ViewImageArgs): Promise<ToolOutputImage>;
  readFile?(args: ReadFileArgs): Promise<string | Uint8Array>;
  listDir?(args: ListDirectoryArgs): Promise<SandboxDirectoryEntry[]>;
  pathExists?(path: string, runAs?: string): Promise<boolean>;
  materializeEntry?(args: MaterializeEntryArgs): Promise<void>;
  applyManifest?(manifest: Manifest, runAs?: string): Promise<void>;
  persistWorkspace?(): Promise<Uint8Array>;
  hydrateWorkspace?(data: WorkspaceArchiveData): Promise<void>;
  resolveExposedPort?(port: number): Promise<ExposedPortEndpoint>;
  supportsPty?(): boolean;
  close?(): Promise<void>;
}

export type SandboxSessionLike<
  TState extends SandboxSessionState = SandboxSessionState,
> = SandboxSession<TState>;
