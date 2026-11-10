import { z } from 'zod';
import { isAbsolute, win32, sep } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
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

/** A caller-owned directory exposed through a command-private read-only bind. */
export interface LocalStorageMount {
  readonly source: string;
  /** Defaults to source. Must use the same canonical path. */
  readonly destination?: string;
  /** Defaults to local_bind. */
  readonly strategy?: 'local_bind';
  /** Defaults to true. Writable mounts are unsupported; use writableRoots. */
  readonly readOnly?: true;
}

const storageMountSchema = z
  .object({
    source: z.string(),
    destination: z.string(),
    strategy: z.literal('local_bind'),
    readOnly: z.literal(true).default(true),
  })
  .strict();
const storageMountInputSchema = storageMountSchema
  .extend({
    destination: z.string().optional(),
    strategy: z.literal('local_bind').default('local_bind'),
  })
  .transform((mount) => ({
    ...mount,
    destination: mount.destination ?? mount.source,
  }));
const storageMountWireSchema = storageMountSchema
  .omit({ readOnly: true })
  .extend({
    read_only: z.literal(true),
  });

function captureStorageMounts(
  value: unknown,
  cwd: string,
  writableRoots: readonly string[],
): readonly LocalStorageMount[] {
  // Do not reflect unknown fields, credentials, or input values in errors.
  try {
    if (process.platform !== 'linux') throw new Error();
    const mounts = z.array(storageMountInputSchema).parse(value);
    const roots = [cwd, ...writableRoots].map((path) =>
      realpathSync(path.startsWith('file:') ? fileURLToPath(path) : path),
    );
    const overlaps = (left: string, right: string) =>
      left === right ||
      left.startsWith(right + sep) ||
      right.startsWith(left + sep) ||
      left === sep ||
      right === sep;
    for (const mount of mounts) {
      if (
        !isAbsolute(mount.source) ||
        mount.source === sep ||
        mount.source !== mount.destination ||
        realpathSync(mount.source) !== mount.source ||
        !statSync(mount.source).isDirectory() ||
        roots.some((root) => overlaps(root, mount.source))
      )
        throw new Error();
      roots.push(mount.source);
    }
    return Object.freeze(mounts.map((mount) => Object.freeze(mount)));
  } catch {
    throw new TypeError(
      'Invalid local storage mounts: require disjoint canonical existing Linux directories, same-path local_bind, and readOnly true',
    );
  }
}

// Core's private credentials, runtime-owned values, and SDK bootstrap controls.
const reservedEnvironmentNames = new Set([
  'CODEX_SDK_BWRAP_SEARCH_PATH',
  'CARGO_BIN_EXE_BWRAP',
  'CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE',
  'CODEX_SANDBOX_COMMAND_ENV_JSON',
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'CODEX_VERSION',
  'CODEX_PERMISSION_PROFILE',
  'CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS',
  'CODEX_PLUGIN_METRICS_OUTPUT',
  'CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN',
  'NODE_REPL_AUTH_TOKEN',
  'CODEX_GUARDIAN_DECISIONS_API_KEY',
  'OPENAI_FEDERATION_RULE_ID',
  'OPENAI_IDENTITY_TOKEN_FILE',
  'OPENAI_WORKLOAD_IDENTITY_CONTEXT',
]);

const environmentValues = z
  .custom<Record<string, string>>(
    (value) =>
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.entries(value).every(([name, entry]) => {
        const normalizedName = name.replace(/[a-z]/g, (letter) =>
          letter.toUpperCase(),
        );
        return (
          name.length > 0 &&
          !reservedEnvironmentNames.has(normalizedName) &&
          !normalizedName.startsWith('CODEX_SANDBOX_COMMAND_ENV_JSON_') &&
          !name.includes('\0') &&
          !name.includes('=') &&
          typeof entry === 'string' &&
          !entry.includes('\0') &&
          Buffer.from(name, 'utf8').toString('utf8') === name &&
          Buffer.from(entry, 'utf8').toString('utf8') === entry
        );
      }),
    'Invalid executor environment variables',
  )
  .transform((value) => Object.fromEntries(Object.entries(value)));

const remoteEnvironmentSchema = z
  .object({
    url: z.string().url(),
    cwd: pathUri,
    capability_directories: z.array(capabilityDirectory).optional(),
    writable_roots: z.array(capabilityDirectory).optional(),
    read_only: z.boolean().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    env_json: z.string().optional(),
    connect_timeout: z.number().nonnegative().finite().nullable().optional(),
    network: networkPolicyWireSchema.optional(),
  })
  .strict();
const localEnvironmentSchema = remoteEnvironmentSchema
  .omit({ url: true, headers: true, connect_timeout: true })
  .extend({
    local: z.literal(true),
    mounts: z.array(storageMountWireSchema).optional(),
    read_only_roots: z.array(capabilityDirectory).optional(),
  });
const environmentSchema = z.union([
  remoteEnvironmentSchema,
  localEnvironmentSchema,
]);
export type EnvironmentConfig = z.infer<typeof environmentSchema>;

export function captureWritableRoots(roots: readonly string[]): string[] {
  return z.array(capabilityDirectory).parse(roots);
}
export type ExecutorToolName =
  | 'exec_command'
  | 'write_stdin'
  | 'apply_patch'
  | 'project_glob'
  | 'project_grep';

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
  readonly session: Session<unknown, Context>;
  readonly agent: Agent<any, any>;
  readonly agentRole: string | null;
  readonly model: string | null;
}

export interface EnvironmentOptions<Context = unknown> {
  /** Storage mounts are available only through Environment.local. */
  mounts?: never;
  readOnlyRoots?: never;
  url: string;
  cwd: string;
  capabilityDirectories?: readonly string[];
  /** Strict writes by default. Legacy remote approval requires explicit opt-in. */
  writePolicy?: 'strict' | 'legacy';
  /** Extra writable directories under strict policy. The workspace is always included. */
  writableRoots?: readonly string[];
  /** Opt-in executor operations. Project search stays rooted at this Environment's cwd. */
  tools?: readonly ExecutorToolName[];
  /** Explicit managed proxy policy. Requires exec_command and a supported executor. */
  network?: NetworkPolicy;
  headers?: Readonly<Record<string, string>>;
  /** Captured command-variable overrides; current declarations only, excluded from saved state. */
  env?: Readonly<Record<string, string>>;
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
  /** Cap native filesystem access within current read/network scope. Strict only.
   * Application callbacks retain their host authority.
   */
  readOnly?: boolean;
}

export type LocalEnvironmentOptions<Context = unknown> = Omit<
  EnvironmentOptions<Context>,
  | 'url'
  | 'headers'
  | 'connectTimeout'
  | 'mounts'
  | 'readOnlyRoots'
  | 'writePolicy'
> & {
  /** Local environments only support strict writes. */
  writePolicy?: 'strict';
  /** Linux only: canonical same-path read-only local_bind mounts. */
  mounts?: readonly LocalStorageMount[];
  /**
   * macOS only. Existing canonical application-owned directories to read at
   * their original paths. Keep them outside the workspace, writable roots,
   * and SDK private state. For a symlinked skill, grant its canonical target
   * directory. Keep the trees stable during use and repeat the same grants
   * when restoring the Session.
   */
  readOnlyRoots?: readonly string[];
};

export class Environment<Context = any> {
  /**
   * Execute in the local Linux or macOS sandbox using packaged helpers.
   * Commands can read the workspace, declared roots, and platform runtime
   * files. They start with a system PATH and no inherited host variables.
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
    return createEnvironmentLease(environment, () => dispose(), sourceSignal);
  }

  #remoteUrl?: string;
  readonly kind: 'local' | 'remote';
  readonly writePolicy: 'strict' | 'legacy';
  readonly readOnly: boolean;
  /** WSS transport URL. A local Environment has no transport URL. */
  get url(): string {
    if (this.#remoteUrl === undefined)
      throw new TypeError('Local executor has no transport URL');
    return this.#remoteUrl;
  }
  readonly cwd: string;
  readonly capabilityDirectories?: readonly string[];
  readonly writableRoots?: readonly string[];
  readonly mounts?: readonly LocalStorageMount[];
  readonly readOnlyRoots?: readonly string[];
  readonly tools: readonly ExecutorToolName[];
  readonly network?: CapturedNetworkPolicy;
  readonly headers: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string>>;
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
    this.writePolicy =
      options.writePolicy === undefined ? 'strict' : options.writePolicy;
    if (options.readOnly !== undefined && typeof options.readOnly !== 'boolean')
      throw new TypeError('readOnly must be a boolean');
    this.readOnly = options.readOnly ?? false;
    if (this.readOnly && this.writePolicy !== 'strict')
      throw new TypeError('Read-only execution requires strict write policy');
    if (
      this.readOnly &&
      this.kind === 'local' &&
      !['linux', 'darwin'].includes(process.platform)
    )
      throw new TypeError('Read-only local execution requires Linux or macOS');
    if (this.writePolicy !== 'strict' && this.writePolicy !== 'legacy')
      throw new TypeError('writePolicy must be strict or legacy');
    if (this.writePolicy === 'legacy') {
      if (this.kind === 'local')
        throw new TypeError(
          'Legacy write policy requires a remote Environment',
        );
      if (options.writableRoots !== undefined)
        throw new TypeError(
          'Legacy write policy does not accept writableRoots; use strict',
        );
    }
    if (this.kind === 'remote' && 'mounts' in options)
      throw new TypeError('Storage mounts require Environment.local on Linux');
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
          ![
            'exec_command',
            'write_stdin',
            'apply_patch',
            'project_glob',
            'project_grep',
          ].includes(name),
      )
    )
      throw new TypeError('Select distinct executor tool names');
    if (this.readOnly && tools.includes('apply_patch'))
      throw new TypeError('Read-only execution does not support apply_patch');
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
    // Reuse the native roots field so existing strict policy identities remain stable.
    this.writableRoots =
      this.writePolicy === 'legacy'
        ? undefined
        : Object.freeze(
            captureWritableRoots(
              options.writableRoots === undefined ? [] : options.writableRoots,
            ),
          );
    if (this.readOnly && this.writableRoots?.length)
      throw new TypeError('Read-only execution does not accept writableRoots');
    if ('mounts' in options && options.mounts !== undefined)
      this.mounts = captureStorageMounts(
        options.mounts,
        this.cwd,
        this.writableRoots ?? [],
      );
    if (options.readOnlyRoots !== undefined) {
      const roots = z
        .array(capabilityDirectory)
        .safeParse(options.readOnlyRoots);
      if (!roots.success)
        throw new TypeError(
          'readOnlyRoots must contain absolute paths or file URIs',
        );
      if (roots.data.length) {
        if (this.kind !== 'local' || process.platform !== 'darwin')
          throw new TypeError(
            'readOnlyRoots requires Environment.local on macOS',
          );
        this.readOnlyRoots = Object.freeze(roots.data);
      }
    }
    this.tools = Object.freeze(tools);
    this.network =
      options.network === undefined
        ? undefined
        : captureNetworkPolicy(options.network);
    this.headers = Object.freeze(headers);
    this.env =
      options.env === undefined
        ? undefined
        : Object.freeze(environmentValues.parse(options.env));
    this.connectTimeout = transport?.connectTimeout;
    this.approval = options.approval;
    this.transformArguments = options.transformArguments;
    this.transformResult = options.transformResult;
    environmentConfig(this);
    for (const name of [
      'headers',
      'env',
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
    ...(environment.env === undefined
      ? {}
      : { env_json: JSON.stringify(environment.env) }),
    ...(environment.readOnly ? { read_only: true } : {}),
    ...(environment.mounts === undefined
      ? {}
      : {
          mounts: environment.mounts.map((mount) => ({
            source: mount.source,
            destination: mount.destination,
            strategy: mount.strategy,
            read_only: true as const,
          })),
        }),
    ...(environment.readOnlyRoots === undefined
      ? {}
      : { read_only_roots: environment.readOnlyRoots }),
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

/** @internal Derive native search authority only from the current trusted Environment. */
export function projectSearchRuntime(
  environment: Environment | null | undefined,
): {
  _sdk_project_search?: {
    root: string;
    tools: ('project_glob' | 'project_grep')[];
  };
} {
  const tools =
    environment?.tools.filter(
      (name) => name === 'project_glob' || name === 'project_grep',
    ) ?? [];
  return environment && tools.length
    ? {
        _sdk_project_search: {
          root: environmentConfig(environment).cwd,
          tools,
        },
      }
    : {};
}
