import { z } from 'zod';
import { isAbsolute, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { JsonValue } from './binding';
import type {
  ExecutorPolicyDecision,
  stopExecutorTurn,
} from './executor-decisions';
import type { Session, Agent } from './public-agent';
import type { ToolCallContext } from './tools';
import {
  createEnvironmentLease,
  type EnvironmentLease,
} from './environment-source';
import {
  captureNetworkPolicy,
  networkPolicyWire,
  networkPolicyWireSchema,
  type CapturedNetworkPolicy,
  type NetworkPolicy,
} from './network-policy';

const pathUri = z
  .string()
  .min(1)
  .transform((path, context) => {
    if (path.startsWith('file:')) {
      try {
        return new URL(path).href;
      } catch {
        context.addIssue({ code: 'custom', message: 'Invalid file URI' });
        return z.NEVER;
      }
    }
    if (isAbsolute(path)) return pathToFileURL(path).href;
    if (win32.isAbsolute(path))
      return pathToFileURL(path, { windows: true }).href;
    context.addIssue({
      code: 'custom',
      message: 'Executor paths must be absolute or file URIs',
    });
    return z.NEVER;
  });

const capabilityDirectory = z
  .string()
  .refine(
    (path) =>
      path.startsWith('file:')
        ? path.startsWith('file:/') &&
          (!path.startsWith('file://') ||
            path.slice('file://'.length).includes('/'))
        : isAbsolute(path) ||
          (win32.isAbsolute(path) && win32.parse(path).root !== win32.sep),
    'Capability directories must be absolute remote paths or file URIs',
  )
  .pipe(pathUri)
  .refine((value) => {
    const uri = new URL(value);
    return (
      uri.protocol === 'file:' &&
      uri.pathname.startsWith('/') &&
      !uri.search &&
      !uri.hash
    );
  }, 'Capability directories cannot contain URI queries or fragments');

const remoteEnvironmentSchema = z
  .object({
    url: z.string().url(),
    cwd: pathUri,
    capability_directories: z.array(capabilityDirectory).optional(),
    writable_roots: z.array(capabilityDirectory).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    connect_timeout: z.number().nonnegative().finite().nullable().optional(),
    network: networkPolicyWireSchema.optional(),
  })
  .strict();
const localEnvironmentSchema = remoteEnvironmentSchema
  .omit({ url: true, headers: true, connect_timeout: true })
  .extend({ local: z.literal(true) });
const environmentSchema = z.union([
  remoteEnvironmentSchema,
  localEnvironmentSchema,
]);
export type EnvironmentConfig = z.infer<typeof environmentSchema>;

export function captureWritableRoots(roots: readonly string[]): string[] {
  return z.array(capabilityDirectory).parse(roots);
}
export type ExecutorToolName = 'exec_command' | 'write_stdin' | 'apply_patch';

export interface ExecutorContext<Context = unknown> {
  readonly call?: import('./call-metadata').ToolCallInfo;
  readonly context: Context;
  readonly submission: ToolCallContext<Context>['submission'];
  readonly toolName: ExecutorToolName;
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string | null;
  readonly outerCallId: string | null;
  readonly cellId: string | null;
  readonly runtimeToolCallId: string | null;
  readonly session: Session;
  readonly agent: Agent<any, any>;
  readonly agentRole: string | null;
  readonly model: string | null;
}

export interface EnvironmentOptions<Context = unknown> {
  url: string;
  cwd: string;
  capabilityDirectories?: readonly string[];
  /** Extra writable directories on the executor. The workspace is always included. */
  writableRoots?: readonly string[];
  tools?: readonly ExecutorToolName[];
  /** Explicit managed proxy policy. Requires exec_command and a supported executor. */
  network?: NetworkPolicy;
  headers?: Readonly<Record<string, string>>;
  connectTimeout?: number;
  approval?: (
    context: ExecutorContext<Context>,
    argumentsValue: JsonValue,
  ) =>
    | boolean
    | ReturnType<typeof stopExecutorTurn>
    | Promise<boolean | ReturnType<typeof stopExecutorTurn>>;
  transformArguments?: (
    context: ExecutorContext<Context>,
    value: JsonValue,
  ) =>
    | JsonValue
    | ExecutorPolicyDecision
    | Promise<JsonValue | ExecutorPolicyDecision>;
  transformResult?: (
    context: ExecutorContext<Context>,
    value: JsonValue,
  ) => JsonValue | Promise<JsonValue>;
  policyTimeout?: number;
}

export type LocalEnvironmentOptions<Context = unknown> = Omit<
  EnvironmentOptions<Context>,
  'url' | 'headers' | 'connectTimeout'
>;

export class Environment<Context = any> {
  /**
   * Execute in the local Linux or macOS sandbox using packaged helpers.
   * Commands can read the workspace, declared writable roots, and platform
   * runtime files. They start with a system PATH and no inherited host variables.
   * Install the SDK helpers outside every writable root, including the workspace.
   */
  static local<Context>(
    options: LocalEnvironmentOptions<Context>,
  ): Environment<Context> {
    return new Environment({ ...options, local: true });
  }

  /**
   * Capture a source's resource scope and release it after native retirement.
   * An optional sourceSignal requests retirement if that resource ends early.
   * The returned lease is single-use and a Session owns its disposal once claimed.
   */
  static lease<Context>(
    environment: Environment<Context>,
    dispose: () => void | Promise<void>,
    sourceSignal?: AbortSignal,
  ): EnvironmentLease<Context> {
    return createEnvironmentLease(environment, dispose, sourceSignal);
  }

  #remoteUrl?: string;
  readonly kind: 'local' | 'remote';
  /** WSS transport URL. A local Environment has no transport URL. */
  get url(): string {
    if (this.#remoteUrl === undefined)
      throw new TypeError('Local executor has no transport URL');
    return this.#remoteUrl;
  }
  readonly cwd: string;
  readonly capabilityDirectories?: readonly string[];
  readonly writableRoots?: readonly string[];
  readonly tools: readonly ExecutorToolName[];
  readonly network?: CapturedNetworkPolicy;
  readonly headers: Readonly<Record<string, string>>;
  readonly connectTimeout?: number;
  readonly approval?: EnvironmentOptions<Context>['approval'];
  readonly transformArguments?: EnvironmentOptions<Context>['transformArguments'];
  readonly transformResult?: EnvironmentOptions<Context>['transformResult'];
  readonly policyTimeout: number;

  constructor(
    options:
      | EnvironmentOptions<Context>
      | (LocalEnvironmentOptions<Context> & { local: true }),
  ) {
    this.kind = 'local' in options ? 'local' : 'remote';
    if ('local' in options) {
      if (
        'url' in options ||
        'headers' in options ||
        'connectTimeout' in options
      )
        throw new TypeError(
          'Local executor does not accept connection settings',
        );
    } else {
      let url: URL;
      try {
        url = new URL(options.url);
      } catch {
        throw new TypeError('Invalid executor URL');
      }
      if (
        url.protocol !== 'wss:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        // eslint-disable-next-line no-control-regex -- Transport metadata must exclude controls.
        /[\s\x00-\x1f\x7f]/.test(options.url)
      )
        throw new TypeError(
          'Executor URL must use wss:// without userinfo, query or fragment',
        );
      this.#remoteUrl = options.url;
    }
    const tools = [...(options.tools ?? [])];
    if (
      new Set(tools).size !== tools.length ||
      tools.some(
        (name) =>
          !['exec_command', 'write_stdin', 'apply_patch'].includes(name),
      )
    )
      throw new TypeError('Select distinct executor tool names');
    if (tools.includes('write_stdin') && !tools.includes('exec_command'))
      throw new TypeError('write_stdin requires exec_command');
    if (options.network !== undefined && !tools.includes('exec_command'))
      throw new TypeError('Network policy requires exec_command');
    const transport = 'local' in options ? undefined : options;
    if (
      transport?.connectTimeout !== undefined &&
      (!Number.isFinite(transport.connectTimeout) ||
        transport.connectTimeout <= 0)
    )
      throw new TypeError(
        'Executor connectTimeout must be positive and finite',
      );
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(transport?.headers ?? {})) {
      const key = name.toLowerCase();
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        key in headers ||
        [
          'connection',
          'content-length',
          'host',
          'transfer-encoding',
          'upgrade',
        ].includes(key) ||
        key.startsWith('sec-websocket-')
      )
        throw new TypeError('Invalid or reserved executor header');
      // eslint-disable-next-line no-control-regex -- Transport metadata must exclude controls.
      if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value))
        throw new TypeError('Invalid executor header value');
      headers[key] = value;
    }
    for (const name of [
      'approval',
      'transformArguments',
      'transformResult',
    ] as const)
      if (options[name] !== undefined && typeof options[name] !== 'function')
        throw new TypeError(`Executor ${name} must be callable`);
    this.policyTimeout = options.policyTimeout ?? 30;
    if (
      !Number.isFinite(this.policyTimeout) ||
      this.policyTimeout <= 0 ||
      this.policyTimeout > 3600
    )
      throw new TypeError(
        'Executor policyTimeout must be in (0, 3600] seconds',
      );
    this.cwd = options.cwd;
    this.capabilityDirectories =
      options.capabilityDirectories === undefined
        ? undefined
        : Object.freeze(
            z.array(capabilityDirectory).parse(options.capabilityDirectories),
          );
    this.writableRoots =
      options.writableRoots === undefined
        ? undefined
        : Object.freeze(captureWritableRoots(options.writableRoots));
    this.tools = Object.freeze(tools);
    this.network =
      options.network === undefined
        ? undefined
        : captureNetworkPolicy(options.network);
    this.headers = Object.freeze(headers);
    this.connectTimeout = transport?.connectTimeout;
    this.approval = options.approval;
    this.transformArguments = options.transformArguments;
    this.transformResult = options.transformResult;
    environmentConfig(this);
    for (const name of [
      'headers',
      'approval',
      'transformArguments',
      'transformResult',
    ])
      Object.defineProperty(this, name, { enumerable: false });
    Object.freeze(this);
  }
}

/** @internal Construct transport settings from the current immutable declaration. */
export function environmentConfig(environment: Environment): EnvironmentConfig {
  const native = environmentSchema.parse({
    ...(environment.kind === 'local'
      ? { local: true }
      : { url: environment.url, headers: environment.headers }),
    cwd: environment.cwd,
    ...(environment.capabilityDirectories === undefined
      ? {}
      : { capability_directories: environment.capabilityDirectories }),
    ...(environment.writableRoots === undefined
      ? {}
      : { writable_roots: environment.writableRoots }),
    ...(environment.connectTimeout === undefined
      ? {}
      : { connect_timeout: environment.connectTimeout }),
    ...(environment.network === undefined
      ? {}
      : { network: networkPolicyWire(environment.network) }),
  });
  const path = new URL(native.cwd);
  if (
    path.protocol !== 'file:' ||
    !path.pathname.startsWith('/') ||
    path.search ||
    path.hash
  )
    throw new TypeError('Executor cwd must be an absolute path or file URI');
  return native;
}
