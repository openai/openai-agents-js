import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  jsonObject,
  losslessJsonObjectSchema,
  type JsonObject,
} from './binding';
import { interceptedCallInfo, type ToolCallInfo } from './call-metadata';
import {
  invokeWithTimeout,
  withToolApplicationData,
  toolIdentity,
  toolRef,
  type ToolDecision,
  type ToolRef,
} from './tools';
import { webSearch, type WebSearch } from './web-search';
import { captureHostedTool, type HostedTool } from './hosted-tools';
import type { Environment } from './environment';
import type { ToolCallContext, Tool, SessionTool } from './tools';
import { NativeAgents } from './native-agents';
import { nativeGoalToolNames } from './goals';

// Only these module-owned constructors may declare the host's reserved alias.
// Narrowed selectors retain their captured raw-name source, never a peer client.
const mcpNameSources = new WeakMap<object, readonly string[]>();
const mcpRefIdentities = new WeakMap<object, readonly [string, string]>();
/** @internal Raw provenance only; admission still belongs to the captured binding. */
export function mcpRefIdentity(
  ref: ToolRef,
): readonly [string, string] | undefined {
  return mcpRefIdentities.get(ref);
}
export function mcpToolSelections(
  servers: readonly McpTool[],
): Array<[string, string, { namespace: string; name: string }]> {
  const selections = new Map<
    string,
    [string, string, { namespace: string; name: string }]
  >();
  for (const server of servers) {
    const names = mcpToolNames([server]);
    server.tools.forEach((raw, index) => {
      const key = JSON.stringify([server.name, raw]);
      if (!selections.has(key))
        selections.set(key, [server.name, raw, names[index]!]);
    });
  }
  return [...selections.values()];
}
const hostedOptions = new WeakSet<object>();
function hostRegistration<T extends object>(options: T): T {
  hostedOptions.add(options);
  return options;
}

/** Resource metadata in the native MCP transport shape. */
export interface MCPResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  annotations?: Record<string, unknown>;
  icons?: Record<string, unknown>[];
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A URI template advertised by an ordinary MCP server. */
export interface MCPResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: Record<string, unknown>;
  icons?: Record<string, unknown>[];
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Text is returned as data; the SDK does not add it to model instructions. */
export interface MCPTextResourceContents {
  uri: string;
  mimeType?: string;
  text: string;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Binary contents remain base64 encoded in the transport result. */
export interface MCPBlobResourceContents {
  uri: string;
  mimeType?: string;
  blob: string;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One resource page. Pass nextCursor explicitly to request another page. */
export interface MCPListResourcesResult {
  resultType?: string;
  ttlMs?: number;
  cacheScope?: 'public' | 'private';
  resources: MCPResource[];
  nextCursor?: string;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One template page, without automatic pagination. */
export interface MCPListResourceTemplatesResult {
  resultType?: string;
  ttlMs?: number;
  cacheScope?: 'public' | 'private';
  resourceTemplates: MCPResourceTemplate[];
  nextCursor?: string;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Native text/blob results, including transport metadata and extensions. */
export interface MCPReadResourceResult {
  resultType?: string;
  ttlMs?: number;
  cacheScope?: 'public' | 'private';
  contents: (MCPTextResourceContents | MCPBlobResourceContents)[];
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One argument accepted by a server-defined prompt. */
export interface MCPPromptArgument {
  name: string;
  title?: string;
  description?: string;
  required?: boolean;
}

/** Prompt metadata returned in a complete caller-owned inventory. */
export interface MCPPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: MCPPromptArgument[];
  icons?: Record<string, unknown>[];
  _meta?: Record<string, unknown>;
}

/** Prompt content remains data, including base64 image/audio and resource contents. */
export type MCPPromptContent =
  | {
      type: 'text';
      text: string;
      annotations?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    }
  | {
      type: 'image';
      data: string;
      mimeType: string;
      annotations?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    }
  | {
      type: 'audio';
      data: string;
      mimeType: string;
      annotations?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    }
  | {
      type: 'resource';
      resource: MCPTextResourceContents | MCPBlobResourceContents;
      annotations?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    }
  | (MCPResource & { type: 'resource_link' });

/** A server-authored message returned only to the caller. */
export interface MCPPromptMessage {
  role: 'user' | 'assistant';
  content: MCPPromptContent;
}

/** A named prompt result; the SDK never inserts these messages into model context. */
export interface MCPGetPromptResult {
  messages: MCPPromptMessage[];
  description?: string;
  resultType?: string;
  _meta?: Record<string, unknown>;
}

export interface MCPCallContext<Context = unknown> {
  readonly context: Context;
  readonly submission: ToolCallContext<Context>['submission'];
  readonly call: ToolCallInfo;
  readonly serverName: string;
  readonly toolName: string;
  readonly originalArguments: Readonly<JsonObject>;
  readonly effectiveArguments: Readonly<JsonObject>;
  readonly signal: AbortSignal;
}
/** Stop the owning native turn. The optional reason stays private to the app. */
export interface MCPStopDecision {
  action: 'stop';
  reason?: string;
}
export type MCPBeforeDecision =
  | MCPStopDecision
  | Extract<ToolDecision<JsonObject>, { action: 'allow' | 'replaceArguments' }>;

/** Effective arguments after approval, before native file-reference substitution. */
export interface MCPMetadataContext<Context = unknown> {
  readonly context: Context;
  readonly submission: ToolCallContext<Context>['submission'];
  readonly call: ToolCallInfo;
  readonly serverName: string;
  readonly toolName: string;
  readonly arguments: Readonly<JsonObject>;
}

export interface MCPResultContext<Context = unknown> {
  readonly context: Context;
  readonly submission: ToolCallContext<Context>['submission'];
  readonly callId: string;
  readonly serverName: string;
  readonly toolName: string;
}
/** Captured MCP inputs and naming for application-only result extraction. */
export interface MCPApplicationDataContext<
  Context = unknown,
> extends MCPResultContext<Context> {
  readonly arguments: Readonly<JsonObject>;
  readonly toolDisplayName: string;
}

export interface MCPOptions<Context = unknown> {
  /** Discover selected schemas on supported direct-mode models; never delays connection. */
  deferLoading?: boolean;
  name: string;
  /** Selected raw tool names. Use [] for a resource-only server. */
  tools: readonly string[];
  /** Follow native rules (default), or preapprove selected tools. Application approval still applies. */
  approvalMode?: 'native' | 'preapproved';
  /** Inspect or replace arguments before native dispatch; has a 30-second deadline. */
  before?: (
    context: MCPCallContext<Context>,
  ) => MCPBeforeDecision | Promise<MCPBeforeDecision>;
  /** Application approval, independent of the native approval mode. */
  approval?: (
    context: MCPCallContext<Context>,
  ) => boolean | MCPStopDecision | Promise<boolean | MCPStopDecision>;
  startupTimeout?: number;
  executionTimeout?: number;
  transformResult?: (
    context: MCPResultContext<Context>,
    result: JsonObject,
  ) => JsonObject | Promise<JsonObject>;
  /** Attach application-only JSON after the optional transform; never provider data. */
  extractApplicationData?: (
    context: MCPApplicationDataContext<Context>,
    result: JsonObject,
  ) => JsonObject | null | undefined | Promise<JsonObject | null | undefined>;
  transformResultTimeout?: number;
  /** Return detached outbound MCP metadata; native identity and policy keys are reserved. */
  requestMetadata?: (
    context: MCPMetadataContext<Context>,
  ) => JsonObject | null | undefined | Promise<JsonObject | null | undefined>;
}

abstract class MCP<Context> {
  readonly kind = 'mcp' as const;
  readonly deferLoading: boolean;
  readonly name: string;
  readonly tools: readonly string[];
  readonly approvalMode: 'native' | 'preapproved';
  readonly startupTimeout: number;
  readonly executionTimeout: number;
  readonly before?: MCPOptions<Context>['before'];
  readonly approval?: MCPOptions<Context>['approval'];
  readonly transformResult?: MCPOptions<Context>['transformResult'];
  readonly extractApplicationData?: MCPOptions<Context>['extractApplicationData'];
  readonly transformResultTimeout?: number;
  readonly requestMetadata?: MCPOptions<Context>['requestMetadata'];

  constructor(options: MCPOptions<Context>) {
    if (
      options.deferLoading !== undefined &&
      typeof options.deferLoading !== 'boolean'
    )
      throw new TypeError('MCP deferLoading must be a boolean');
    if (
      !/^[a-zA-Z0-9_:@/.-]+$/.test(options.name) ||
      (options.name === 'codex_apps' && !hostedOptions.has(options))
    )
      throw new TypeError('MCP name must be an ordinary native server alias');
    if (
      !Array.isArray(options.tools) ||
      options.tools.some((name) => typeof name !== 'string' || !name)
    )
      throw new TypeError('MCP tools must select nonempty raw tool names');
    this.deferLoading = options.deferLoading ?? false;
    this.name = options.name;
    this.tools = Object.freeze([...options.tools]);
    this.approvalMode = options.approvalMode ?? 'native';
    if (!['native', 'preapproved'].includes(this.approvalMode))
      throw new TypeError('Invalid MCP approvalMode');
    this.startupTimeout = positive(options.startupTimeout ?? 10);
    this.executionTimeout = positive(options.executionTimeout ?? 60);
    if (
      options.transformResult !== undefined &&
      typeof options.transformResult !== 'function'
    )
      throw new TypeError('MCP transformResult must be callable');
    if (
      options.extractApplicationData !== undefined &&
      typeof options.extractApplicationData !== 'function'
    )
      throw new TypeError('MCP extractApplicationData must be callable');
    if (
      options.transformResultTimeout !== undefined &&
      ((!options.transformResult && !options.extractApplicationData) ||
        positive(options.transformResultTimeout) > 3600)
    )
      throw new TypeError(
        'MCP transformResultTimeout requires a transform or extractor and at most 3600 seconds',
      );
    this.before = options.before;
    this.approval = options.approval;
    for (const key of ['before', 'approval'] as const) {
      if (this[key] !== undefined && typeof this[key] !== 'function')
        throw new TypeError(`MCP ${key} must be callable`);
      Object.defineProperty(this, key, { enumerable: false });
    }
    if (
      options.requestMetadata !== undefined &&
      typeof options.requestMetadata !== 'function'
    )
      throw new TypeError('MCP requestMetadata must be callable');
    if (options.requestMetadata && options.name === 'codex_apps')
      throw new TypeError(
        'MCP requestMetadata requires an ordinary StdioMCP or HttpMCP declaration',
      );
    this.requestMetadata = options.requestMetadata;
    Object.defineProperty(this, 'requestMetadata', { enumerable: false });
    this.extractApplicationData = options.extractApplicationData;
    Object.defineProperty(this, 'extractApplicationData', {
      enumerable: false,
    });
    this.transformResult = options.transformResult;
    Object.defineProperty(this, 'transformResult', { enumerable: false });
    this.transformResultTimeout = options.transformResultTimeout;
    mcpNameSources.set(this, this.tools);
    mcpToolNames([this]);
  }

  /** Select one declared raw MCP tool without exposing native name projection. */
  tool(rawName: string): ToolRef {
    const index = this.tools.indexOf(rawName);
    if (index < 0)
      throw new TypeError(
        `MCP tool ${rawName} is not declared on server ${this.name}`,
      );
    const selected = mcpToolNames([this])[index]!;
    const ref = toolRef(selected.name, selected.namespace);
    mcpRefIdentities.set(ref, [this.name, rawName]);
    return ref;
  }
}

function positive(value: number): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new TypeError('MCP timeouts must be positive and finite');
  return value;
}
function launchText(value: string, allowEmpty = false): void {
  if (
    typeof value !== 'string' ||
    (!value && !allowEmpty) ||
    value.includes('\0')
  )
    throw new TypeError('Invalid MCP launch text');
}

export interface StdioMCPOptions<
  Context = unknown,
> extends MCPOptions<Context> {
  command: string;
  args?: readonly string[];
  envVars?: readonly string[];
  /** Captured child values override inherited names; reserved process identity variables stay excluded. */
  env?: Readonly<Record<string, string>>;
  cwd?: string;
  location?: 'host' | 'environment';
  /** Keep the process for the Session, or isolate it to each admitted turn. */
  lifetime?: 'session' | 'turn';
}

/** A native-owned process with inherited names and captured literal environment values. */
export class StdioMCP<Context = unknown> extends MCP<Context> {
  readonly command: string;
  readonly args: readonly string[];
  readonly envVars: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly location: 'host' | 'environment';
  readonly lifetime: 'session' | 'turn';

  constructor(options: StdioMCPOptions<Context>) {
    super(options);
    launchText(options.command);
    for (const value of options.args ?? []) launchText(value, true);
    for (const value of options.envVars ?? [])
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
        throw new TypeError('MCP envVars must name environment variables');
    if (options.env !== undefined) {
      if (
        options.env === null ||
        typeof options.env !== 'object' ||
        Array.isArray(options.env)
      )
        throw new TypeError('MCP env must be an object of strings');
      const entries = Object.entries(options.env);
      for (const [name, value] of entries) {
        launchText(name);
        if (name.includes('='))
          throw new TypeError('MCP env names must contain no equals sign');
        launchText(value, true);
        if (
          Buffer.from(name, 'utf8').toString('utf8') !== name ||
          Buffer.from(value, 'utf8').toString('utf8') !== value
        )
          throw new TypeError(
            'MCP env names and values must contain valid Unicode',
          );
      }
      this.env = Object.freeze(Object.fromEntries(entries));
    }
    if (options.cwd !== undefined) launchText(options.cwd);
    this.command = options.command;
    this.args = Object.freeze([...(options.args ?? [])]);
    this.envVars = Object.freeze([...(options.envVars ?? [])]);
    this.cwd = options.cwd;
    this.location = options.location ?? 'host';
    this.lifetime = options.lifetime ?? 'session';
    if (!['host', 'environment'].includes(this.location))
      throw new TypeError('Invalid MCP location');
    if (!['session', 'turn'].includes(this.lifetime))
      throw new TypeError('Invalid MCP lifetime');
    for (const name of ['command', 'args', 'envVars', 'env', 'cwd'])
      Object.defineProperty(this, name, { enumerable: false });
    Object.freeze(this);
  }
}

function remoteFilePath(value: string): string {
  const url = new URL(value);
  const windows =
    (!!url.hostname && url.hostname !== 'localhost') ||
    /^\/[A-Za-z]:\//.test(url.pathname);
  return fileURLToPath(url, { windows });
}

export interface HttpMCPOptions<Context = unknown> extends MCPOptions<Context> {
  url: string;
  bearerToken?: string;
  /** Captured HTTP fields. Do not combine Authorization with bearerToken. */
  headers?: Readonly<Record<string, string>>;
  /** Connect at opening (default), or only when selected by a root operation. */
  activation?: 'session' | 'operation';
}

/** Selected tools on a native-owned HTTP MCP connection. */
export class HttpMCP<Context = unknown> extends MCP<Context> {
  readonly url: string;
  readonly bearerToken?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly activation: 'session' | 'operation';

  constructor(options: HttpMCPOptions<Context>) {
    super(options);
    const url = new URL(options.url);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      /\s/.test(options.url)
    )
      throw new TypeError(
        'MCP URL must be HTTP(S) without userinfo or fragments',
      );
    if (
      options.bearerToken !== undefined &&
      !/^[\x21-\x7e]+$/.test(options.bearerToken)
    )
      throw new TypeError(
        'MCP bearerToken must contain visible ASCII characters',
      );
    if (options.headers !== undefined) {
      if (
        typeof options.headers !== 'object' ||
        options.headers === null ||
        Array.isArray(options.headers)
      )
        throw new TypeError('MCP headers must be a string map');
      const entries = Object.entries(options.headers);
      const names = new Set<string>();
      for (const [name, value] of entries) {
        if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name))
          throw new TypeError('MCP header names must be HTTP tokens');
        if (
          typeof value !== 'string' ||
          // eslint-disable-next-line no-control-regex -- HTTP field values must exclude controls except horizontal tab.
          /[\x00-\x08\x0a-\x1f\x7f]/.test(value) ||
          Buffer.from(value, 'utf8').toString('utf8') !== value
        )
          throw new TypeError(
            'MCP header values must be valid HTTP field values',
          );
        const normalized = name.toLowerCase();
        if (names.has(normalized))
          throw new TypeError(
            'MCP headers must have distinct case-insensitive names',
          );
        if (normalized === 'authorization' && options.bearerToken !== undefined)
          throw new TypeError(
            'Use either bearerToken or an Authorization header',
          );
        names.add(normalized);
      }
      this.headers = Object.freeze(Object.fromEntries(entries));
    }
    this.activation = options.activation ?? 'session';
    if (!['session', 'operation'].includes(this.activation))
      throw new TypeError('Invalid HTTP MCP activation');
    if (this.activation === 'operation' && hostedOptions.has(options))
      throw new TypeError(
        'Hosted MCP registrations do not support operation activation',
      );
    this.url = options.url;
    this.bearerToken = options.bearerToken;
    for (const name of ['url', 'bearerToken', 'headers'])
      Object.defineProperty(this, name, { enumerable: false });
    Object.freeze(this);
  }
}

export type HostedVerificationMCPOptions<Context = unknown> = Omit<
  HttpMCPOptions<Context>,
  'name' | 'requestMetadata'
>;

/**
 * Register the application's trusted verification service for this Session.
 * The service verifies and consumes proofs; enqueueing a reply grants nothing.
 * Open a new Session to replace this registration.
 */
export class HostedVerificationMCP<Context = unknown> extends HttpMCP<Context> {
  declare readonly name: 'codex_apps';
  constructor(options: HostedVerificationMCPOptions<Context>) {
    super(hostRegistration({ ...options, name: 'codex_apps' }));
  }
}

export type ChatGPTAppsMCPOptions<Context = unknown> = Omit<
  MCPOptions<Context>,
  'name' | 'requestMetadata'
>;

/**
 * Select personal ChatGPT Apps using the provider's explicit chatGPT credentials.
 * The target is fixed. No stored login, refresh or browser navigation occurs.
 * Connector completion requires authoritative backend grants for that account.
 */
export class ChatGPTAppsMCP<Context = unknown> extends HttpMCP<Context> {
  declare readonly name: 'codex_apps';
  constructor(options: ChatGPTAppsMCPOptions<Context>) {
    if ('url' in options || 'bearerToken' in options || 'headers' in options)
      throw new TypeError(
        'ChatGPT Apps has a fixed target and no bearerToken or headers option',
      );
    super(
      hostRegistration({
        ...options,
        name: 'codex_apps',
        url: 'https://chatgpt.com/backend-api/ps/mcp',
      }),
    );
  }
}

/** @internal The original declaration is a live capability, not serialized authority. */
export function isHostedRegistration(
  server: unknown,
): server is HostedVerificationMCP | ChatGPTAppsMCP {
  return (
    server instanceof HostedVerificationMCP || server instanceof ChatGPTAppsMCP
  );
}

/** @internal Native settings are assembled only by the Session owner. */
function mcpServerConfig(
  server: McpTool,
  environment?: Environment,
): JsonObject {
  const config: JsonObject = {
    enabled_tools: [...server.tools],
    required: true,
    startup_readiness: 'connection',
    startup_timeout_sec: server.startupTimeout,
    tool_timeout_sec: server.executionTimeout,
    ...(server.approvalMode === 'preapproved'
      ? {
          tools: Object.fromEntries(
            server.tools.map((name) => [name, { approval_mode: 'approve' }]),
          ),
        }
      : {}),
  };
  if (server instanceof HttpMCP) {
    config.url = server.url;
    if (server instanceof ChatGPTAppsMCP) config.auth = 'chatgpt';
    const headers: Record<string, string> = { ...server.headers };
    if (server.bearerToken !== undefined)
      headers.Authorization = `Bearer ${server.bearerToken}`;
    if (Object.keys(headers).length) config.http_headers = headers;
  } else {
    config.command = server.command;
    config.args = [...server.args];
    if (server.env !== undefined) config.env = { ...server.env };
    if (server.lifetime === 'turn') config.sdk_turn_scoped_stdio = true;
    if (server.location === 'environment') {
      if (!environment)
        throw new TypeError('Environment MCP requires a Session environment');
      const cwd = server.cwd ?? environment.cwd;
      config.environment_id = environment.kind;
      config.env_vars =
        environment.kind === 'local'
          ? [...server.envVars]
          : server.envVars.map((name) => ({ name, source: 'remote' }));
      config.cwd = cwd.startsWith('file:') ? remoteFilePath(cwd) : cwd;
    } else {
      config.env_vars = [...server.envVars];
      if (server.cwd !== undefined) config.cwd = server.cwd;
    }
  }
  return config;
}

export type McpTool<Context = any> = StdioMCP<Context> | HttpMCP<Context>;

/** @internal Narrow an ordinary captured HTTP binding without replacing its authority. */
export function selectHttpLeaves(
  server: HttpMCP,
  tools: readonly string[],
): HttpMCP {
  const selected = new HttpMCP({
    name: server.name,
    url: server.url,
    bearerToken: server.bearerToken,
    headers: server.headers,
    activation: server.activation,
    deferLoading: server.deferLoading,
    tools,
    approvalMode: server.approvalMode,
    startupTimeout: server.startupTimeout,
    executionTimeout: server.executionTimeout,
    before: server.before,
    approval: server.approval,
    transformResult: server.transformResult,
    extractApplicationData: server.extractApplicationData,
    requestMetadata: server.requestMetadata,
    transformResultTimeout: server.transformResultTimeout,
  });
  mcpNameSources.set(selected, mcpNameSources.get(server) ?? server.tools);
  return selected;
}

/** @internal Activate one ordinary resource connection without granting tools. */
export function resourceMcpBinding(server: McpTool): McpTool {
  if (server instanceof HttpMCP) return selectHttpLeaves(server, []);
  return new StdioMCP({
    name: server.name,
    tools: [],
    command: server.command,
    args: server.args,
    envVars: server.envVars,
    env: server.env,
    cwd: server.cwd,
    location: server.location,
    lifetime: server.lifetime,
    deferLoading: server.deferLoading,
    approvalMode: server.approvalMode,
    startupTimeout: server.startupTimeout,
    executionTimeout: server.executionTimeout,
    before: server.before,
    approval: server.approval,
    transformResult: server.transformResult,
    extractApplicationData: server.extractApplicationData,
    requestMetadata: server.requestMetadata,
    transformResultTimeout: server.transformResultTimeout,
  });
}

/** @internal Synchronous projection of the existing native catalog name owner. */
export function projectMcpToolNames(
  servers: readonly { name: string; tools: readonly string[] }[],
  prefix = true,
): Map<string, { namespace: string; name: string }> {
  const project = (value: string) =>
    [...value]
      .map((c) => (/[A-Za-z0-9_]/.test(c) || (!prefix && c === '-') ? c : '_'))
      .join('') || '_';
  const suffix = (value: string) =>
    '_' + createHash('sha1').update(value, 'utf8').digest('hex').slice(0, 12);
  for (const server of servers) {
    for (const raw of [server.name, ...server.tools]) {
      if (
        typeof raw !== 'string' ||
        !raw ||
        raw.includes('\0') ||
        Buffer.from(raw, 'utf8').toString('utf8') !== raw
      )
        throw new TypeError(
          'MCP raw identities require nonempty valid Unicode without NUL',
        );
    }
    if (new Set(server.tools).size !== server.tools.length)
      throw new TypeError('MCP raw tool names must be unique');
  }
  const candidates = servers.flatMap((server) => {
    const rawNamespace = `${server.name}\0${server.name}\0`;
    const projected = project(server.name);
    const namespace =
      prefix && !projected.startsWith('mcp__')
        ? `mcp__${projected}`
        : projected;
    return server.tools.map((raw) => ({
      server: server.name,
      raw,
      namespace,
      name: project(raw),
      rawNamespace,
      identity: `${rawNamespace}\0${raw}\0${raw}`,
    }));
  });
  const namespaces = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const identities = namespaces.get(candidate.namespace) ?? new Set<string>();
    identities.add(candidate.rawNamespace);
    namespaces.set(candidate.namespace, identities);
  }
  for (const candidate of candidates) {
    if (namespaces.get(candidate.namespace)!.size > 1) {
      const hash = suffix(candidate.rawNamespace);
      candidate.namespace = candidate.namespace.endsWith('__')
        ? candidate.namespace.slice(0, -2) + hash + '__'
        : candidate.namespace + hash;
    }
  }
  const leaves = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.namespace, candidate.name]);
    const identities = leaves.get(key) ?? new Set<string>();
    identities.add(candidate.identity);
    leaves.set(key, identities);
  }
  for (const candidate of candidates) {
    if (
      leaves.get(JSON.stringify([candidate.namespace, candidate.name]))!.size >
      1
    )
      candidate.name += suffix(candidate.identity);
  }
  const result = new Map<string, { namespace: string; name: string }>();
  const used = new Set<string>();
  candidates.sort((a, b) =>
    Buffer.compare(Buffer.from(a.identity), Buffer.from(b.identity)),
  );
  for (const candidate of candidates) {
    let { namespace, name } = candidate;
    if (
      namespace.length + name.length + 2 > 128 ||
      used.has(namespace + name)
    ) {
      for (let attempt = 0; ; attempt++) {
        const hash = suffix(
          attempt === 0
            ? candidate.identity
            : `${candidate.identity}\0${attempt}`,
        );
        const budget = Math.max(0, 128 - candidate.namespace.length - 2);
        if (budget >= hash.length) {
          namespace = candidate.namespace;
          name = candidate.name.slice(0, budget - hash.length) + hash;
        } else {
          namespace = candidate.namespace.slice(0, 128 - hash.length - 2);
          name = hash;
        }
        if (!used.has(namespace + name)) break;
      }
    }
    used.add(namespace + name);
    result.set(JSON.stringify([candidate.server, candidate.raw]), {
      namespace,
      name,
    });
  }
  return result;
}

/** @internal Project names without loading the native addon during declaration. */
export function mcpToolNames(
  servers: readonly Pick<MCP<unknown>, 'name' | 'tools'>[],
): Array<{ namespace: string; name: string }> {
  const namespaces = new Set<string>();
  for (const server of servers) {
    const projected = [...server.name]
      .map((c) => (/[A-Za-z0-9_]/.test(c) ? c : '_'))
      .join('');
    const namespace = projected.startsWith('mcp__')
      ? projected
      : `mcp__${projected}`;
    if (namespaces.has(namespace))
      throw new TypeError(
        'MCP server aliases have colliding native namespaces',
      );
    namespaces.add(namespace);
  }
  const bases = new Map<string, string>();
  for (const server of servers) {
    const project = (raw: string) =>
      [...raw].map((c) => (/[A-Za-z0-9_]/.test(c) ? c : '_')).join('');
    const rawNamespace = project(server.name);
    const namespace = rawNamespace.startsWith('mcp__')
      ? rawNamespace
      : `mcp__${rawNamespace}`;
    for (const raw of mcpNameSources.get(server) ?? server.tools) {
      const key = namespace + project(raw);
      if (bases.has(key) && bases.get(key) !== server.name)
        throw new TypeError('MCP names have a native concatenation collision');
      bases.set(key, server.name);
    }
  }
  const names = projectMcpToolNames(
    servers.map((server) => ({
      name: server.name,
      tools: mcpNameSources.get(server) ?? server.tools,
    })),
  );
  return servers.flatMap((server) =>
    server.tools.map((raw) => names.get(JSON.stringify([server.name, raw]))!),
  );
}

export function mcpConfig(
  servers: readonly McpTool[],
  environment?: Environment,
  codeMode = false,
  reserved: readonly McpTool[] = servers,
): JsonObject {
  mcpToolNames(reserved);
  return Object.fromEntries(
    reserved.map((declared) => {
      const selected = servers.find((server) => server.name === declared.name);
      const server = selected ?? declared;
      const config = {
        ...mcpServerConfig(server, environment),
        ...(!codeMode
          ? {
              omit_tools_from: server.deferLoading
                ? ['code_mode']
                : ['deferred', 'code_mode'],
            }
          : {}),
        ...(!selected ? { enabled: false, required: false } : {}),
      };
      return [declared.name, config];
    }),
  );
}

export function splitToolDeclarations(tools: readonly Tool[]): {
  tools: SessionTool[];
  mcp: McpTool[];
  nativeAgents?: NativeAgents<any>;
  webSearch?: WebSearch;
  hostedTools: readonly HostedTool[];
  nativeGoals: boolean;
  checklist: boolean;
} {
  const functions: SessionTool[] = [];
  const mcp: McpTool[] = [];
  let nativeAgents: NativeAgents<any> | undefined;
  let search: WebSearch | undefined;
  const hostedTools: HostedTool[] = [];
  let nativeGoals = false;
  let checklist = false;
  for (const tool of tools) {
    if (tool instanceof StdioMCP || tool instanceof HttpMCP) mcp.push(tool);
    else if (tool instanceof NativeAgents) {
      if (nativeAgents) throw new TypeError('Declare NativeAgents only once');
      nativeAgents = tool;
    } else if ('kind' in tool && tool.kind === 'web_search') {
      if (search) throw new TypeError('Declare WebSearch only once');
      const { kind: _kind, ...options } = tool;
      search = webSearch(options);
    } else if (
      'kind' in tool &&
      (tool.kind === 'file_search' ||
        tool.kind === 'code_interpreter' ||
        tool.kind === 'image_generation')
    ) {
      if (hostedTools.some((prior) => prior.kind === tool.kind))
        throw new TypeError(`Declare ${tool.kind} only once`);
      hostedTools.push(captureHostedTool(tool));
    } else if ('kind' in tool && tool.kind === 'native_goals')
      nativeGoals = true;
    else if ('kind' in tool && tool.kind === 'checklist') {
      if (checklist) throw new TypeError('Declare Checklist only once');
      checklist = true;
    } else functions.push(tool);
  }
  if (
    mcp.some(
      (server) =>
        server instanceof HttpMCP && server.activation === 'operation',
    ) &&
    (nativeAgents || mcp.some(isHostedRegistration))
  )
    throw new TypeError(
      'Operation HTTP activation requires ordinary root/direct MCP',
    );
  if (
    search?.route === 'hosted' &&
    functions.some((tool) => {
      const identity = toolIdentity(tool);
      return (
        identity.namespace === 'functions' && identity.name === 'web_search'
      );
    })
  )
    throw new TypeError('Hosted WebSearch reserves the tool name web_search');
  if (
    nativeAgents &&
    functions.some((tool) => toolIdentity(tool).namespace === 'collaboration')
  )
    throw new TypeError(
      'NativeAgents reserves the collaboration namespace; use another namespace for custom functions',
    );
  if (
    checklist &&
    functions.some((tool) => {
      const identity = toolIdentity(tool);
      return (
        identity.namespace === 'functions' && identity.name === 'update_plan'
      );
    })
  )
    throw new TypeError('Checklist reserves the tool name update_plan');
  for (const hosted of hostedTools)
    if (
      functions.some((tool) => {
        const identity = toolIdentity(tool);
        return (
          identity.namespace === 'functions' && identity.name === hosted.kind
        );
      })
    )
      throw new TypeError(`Hosted tool reserves the tool name ${hosted.kind}`);
  if (
    nativeGoals &&
    functions.some((tool) => {
      const identity = toolIdentity(tool);
      return (
        identity.namespace === 'functions' &&
        (nativeGoalToolNames as readonly string[]).includes(identity.name)
      );
    })
  )
    throw new TypeError(
      'NativeGoals reserves create_goal, get_goal and update_goal',
    );
  mcpToolNames(mcp);
  return {
    tools: functions,
    mcp,
    nativeAgents,
    nativeGoals,
    checklist,
    webSearch: search,
    hostedTools: Object.freeze(hostedTools),
  };
}

/** @internal Kept with the descriptor generation; never stored in checkpoints. */
export function mcpPolicies(
  servers: readonly McpTool[],
  generation: bigint,
): string {
  return JSON.stringify({
    generation: JSON.rawJSON(generation.toString()),
    pre_policy: Object.fromEntries(
      servers
        .filter((server) => server.before || server.approval)
        .map((server) => [server.name, [...server.tools]]),
    ),
    metadata_servers: Object.fromEntries(
      servers
        .filter((server) => server.requestMetadata)
        .map((server) => [server.name, [...server.tools]]),
    ),
    servers: Object.fromEntries(
      servers
        .filter(
          (server) => server.transformResult || server.extractApplicationData,
        )
        .map((server) => [
          server.name,
          Object.fromEntries(
            server.tools.map((tool) => [
              tool,
              server.transformResultTimeout ?? 30,
            ]),
          ),
        ]),
    ),
  });
}

/** @internal Confirm connected catalogs or explicit native turn-start deferral. */
export function checkMcpPublication(
  receipt: unknown,
  servers: readonly McpTool[],
  generation: bigint,
  reserved: readonly McpTool[] = servers,
): void {
  const result = (
    receipt as {
      result?: {
        publication?: string;
        ready?: boolean;
        deferred_until_turn?: boolean;
        policy_generation?: string | number;
        servers?: Record<
          string,
          {
            accepted?: boolean;
            ready?: boolean;
            deferred_until_turn?: boolean;
            status?: string | null;
            listing_error?: boolean;
            tools?: string[];
          }
        >;
      };
    }
  )?.result;
  if (
    result?.publication !== 'published' ||
    (result.ready !== true && result.deferred_until_turn !== true) ||
    String(result.policy_generation) !== generation.toString()
  )
    throw new Error('Native MCP publication was not confirmed');
  let hasDeferred = false;
  for (const declared of reserved) {
    const report = result.servers?.[declared.name];
    const server = servers.find((selected) => selected.name === declared.name);
    if (!server) {
      if (
        report?.accepted !== true ||
        report.ready !== true ||
        report.status !== 'disabled' ||
        report.deferred_until_turn === true ||
        !Array.isArray(report.tools) ||
        report.tools.length !== 0
      )
        throw new Error(
          `Native MCP reservation ${declared.name} was not confirmed disabled`,
        );
      continue;
    }
    if (
      result.ready === false &&
      result.deferred_until_turn === true &&
      server instanceof StdioMCP &&
      server.lifetime === 'turn' &&
      report?.accepted === true &&
      report.ready === false &&
      report.deferred_until_turn === true &&
      report.status === null &&
      report.listing_error === false &&
      Array.isArray(report.tools) &&
      report.tools.length === 0
    ) {
      hasDeferred = true;
      continue;
    }
    if (
      report?.accepted !== true ||
      report.deferred_until_turn === true ||
      report.ready !== true ||
      report.status !== 'connected' ||
      report.listing_error !== false ||
      !Array.isArray(report.tools) ||
      server.tools.some((tool) => !report.tools!.includes(tool))
    )
      throw new Error(
        `Native MCP server ${server.name} did not confirm every selected tool ready`,
      );
  }
  if ((result.deferred_until_turn === true) !== hasDeferred)
    throw new Error('Native MCP publication deferral was not confirmed');
}

/** @internal Dispatch only the descriptor captured for this accepted native generation. */
export async function transformMcpResult<Context>(
  servers: readonly McpTool<Context>[],
  generation: bigint,
  context: Context,
  submission: ToolCallContext<Context>['submission'],
  notice: {
    generation: string | number;
    source: string;
    server_name: string;
    tool_name: string;
    call_id: string;
    result?: JsonObject;
    arguments?: JsonObject;
    phase?: 'metadata';
    route?: 'direct' | 'code';
    model?: string;
    cell_id?: string;
    runtime_tool_call_id?: string;
    callable_namespace?: string;
    callable_name?: string;
    incarnation?: string | null;
    turn_id?: string;
  },
): Promise<JsonObject> {
  if (
    String(notice.generation) !== generation.toString() ||
    notice.source !== 'config'
  )
    throw new Error('Expired native MCP result generation');
  const server = servers.find(
    (server) =>
      server.name === notice.server_name &&
      server.tools.includes(notice.tool_name),
  );
  if (notice.phase === 'metadata') {
    if (!server?.requestMetadata || !notice.arguments || !notice.route)
      throw new Error('Native MCP metadata has no selected resolver');
    const call = interceptedCallInfo(submission, {
      tool_name: {
        name: notice.callable_name!,
        namespace: notice.callable_namespace!,
      },
      turn_id: notice.turn_id!,
      call_id: notice.route === 'direct' ? notice.call_id : null,
      incarnation: notice.incarnation ?? null,
      route: notice.route === 'code' ? 'code_mode' : 'direct',
      model: notice.model ?? null,
      cell_id: notice.cell_id ?? null,
      runtime_tool_call_id: notice.runtime_tool_call_id ?? null,
    });
    const value = await server.requestMetadata(
      Object.freeze({
        context,
        submission,
        call,
        serverName: server.name,
        toolName: notice.tool_name,
        arguments: Object.freeze(
          losslessJsonObjectSchema.parse(notice.arguments),
        ),
      }),
    );
    return value == null ? {} : losslessJsonObjectSchema.parse(value);
  }
  if (!server || (!server.transformResult && !server.extractApplicationData))
    throw new Error('Native MCP result has no selected transform or extractor');
  const resultContext = Object.freeze({
    context,
    submission,
    callId: notice.call_id,
    serverName: notice.server_name,
    toolName: notice.tool_name,
  });
  const original = losslessJsonObjectSchema.parse(notice.result);
  const result = server.transformResult
    ? losslessJsonObjectSchema.parse(
        await server.transformResult(resultContext, original),
      )
    : original;
  let data: JsonObject | null | undefined;
  if (server.extractApplicationData) {
    if (notice.arguments === undefined || notice.callable_name === undefined)
      throw new Error('Native MCP extraction has no captured input or name');
    data = await server.extractApplicationData(
      Object.freeze({
        ...resultContext,
        arguments: Object.freeze(
          losslessJsonObjectSchema.parse(notice.arguments),
        ),
        toolDisplayName: notice.callable_name,
      }),
      losslessJsonObjectSchema.parse(result),
    );
  }
  return withToolApplicationData(result, data);
}

/** @internal Enrollment does not by itself change ordinary MCP update admission. */
export function hasMcpPrePolicy(servers: readonly McpTool[]): boolean {
  return servers.some((server) => !!(server.before || server.approval));
}

/** @internal A selected native reservation captures this exact generation. */
export function mcpPrePolicyRules(
  servers: readonly McpTool[],
  generation: bigint,
): JsonObject[] {
  return servers.flatMap((server) =>
    !server.before && !server.approval
      ? []
      : mcpToolNames([server]).map((tool, index) => ({
          ...tool,
          mcp_identity: [server.name, server.tools[index]!],
          generation: generation.toString(),
          timeout: server.approval ? null : 30,
          scope: 'thread_tree',
        })),
  );
}

/** @internal Called only after the nonce, owner and captured generation match. */
export async function applyMcpPrePolicy<Context>(
  servers: readonly McpTool<Context>[],
  generation: bigint,
  context: Context,
  submission: ToolCallContext<Context>['submission'],
  request: JsonObject,
  signal: AbortSignal,
  admit: () => void,
  deny: () => void,
  stop: () => void = () => {},
  realtimeEnabled?: () => Promise<boolean>,
): Promise<JsonObject> {
  if (String(request._mcp_generation) !== generation.toString())
    return { action: 'deny' };
  const identity = jsonObject.parse(request.tool_name);
  const rawIdentity = request._mcp_identity as unknown as
    readonly [string, string] | undefined;
  const server = servers.find((candidate) =>
    rawIdentity
      ? candidate.name === rawIdentity[0] &&
        candidate.tools.includes(rawIdentity[1])
      : mcpToolNames([candidate]).some(
          (tool) =>
            tool.namespace === identity.namespace &&
            tool.name === identity.name,
        ),
  );
  if (
    !server ||
    (!server.before && !server.approval && !realtimeEnabled) ||
    request.phase !== 'before'
  )
    return { action: 'deny' };
  const names = mcpToolNames([server]);
  const index = rawIdentity
    ? server.tools.indexOf(rawIdentity[1])
    : names.findIndex(
        (tool) =>
          tool.namespace === identity.namespace && tool.name === identity.name,
      );
  const original = losslessJsonObjectSchema.parse(
    request.route === 'direct'
      ? JSON.parse(request.input as string)
      : request.input,
  );
  let effective = losslessJsonObjectSchema.parse(original);
  const check = () => {
    signal.throwIfAborted();
    admit();
  };
  const view = (callbackSignal: AbortSignal): MCPCallContext<Context> =>
    Object.freeze({
      context,
      submission,
      call: interceptedCallInfo(submission, request),
      serverName: server.name,
      toolName: server.tools[index]!,
      originalArguments: Object.freeze(
        losslessJsonObjectSchema.parse(original),
      ),
      effectiveArguments: Object.freeze(
        losslessJsonObjectSchema.parse(effective),
      ),
      signal: callbackSignal,
    });
  check();
  if (realtimeEnabled) {
    const enabled = await realtimeEnabled();
    check();
    if (!enabled) return { action: 'deny' };
  }
  let replaced = false;
  if (server.before) {
    const allowed = await invokeWithTimeout(
      async (beforeSignal) => {
        const decision = await server.before!(view(beforeSignal));
        beforeSignal.throwIfAborted();
        check();
        if (decision?.action === 'stop') {
          stop();
          return false;
        }
        if (decision?.action === 'replaceArguments') {
          effective = losslessJsonObjectSchema.parse(decision.arguments);
          replaced = true;
          return true;
        }
        return decision?.action === 'allow';
      },
      signal,
      30,
      'MCP before',
      deny,
    );
    check();
    if (!allowed) return { action: 'deny' };
  }
  check();
  if (server.approval) {
    const approved = await server.approval(view(signal));
    check();
    if (typeof approved === 'object' && approved?.action === 'stop') {
      stop();
      return { action: 'deny' };
    }
    if (approved !== true) return { action: 'deny' };
  }
  if (realtimeEnabled && (server.before || server.approval)) {
    const enabled = await realtimeEnabled();
    check();
    if (!enabled) return { action: 'deny' };
  }
  check();
  // The effective candidate never shares storage with a retained callback view.
  return replaced
    ? { action: 'replace', value: effective }
    : { action: 'continue' };
}
