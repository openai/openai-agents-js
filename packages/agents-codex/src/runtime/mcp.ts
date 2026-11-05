import { fileURLToPath } from 'node:url';
import { jsonObject, type JsonObject } from './binding';
import { interceptedCallInfo, type ToolCallInfo } from './call-metadata';
import { invokeWithTimeout, toolIdentity, type ToolDecision } from './tools';
import { webSearch, type WebSearch } from './web-search';
import type { Environment } from './environment';
import type { ToolCallContext, Tool, SessionTool } from './tools';
import { NativeAgents } from './native-agents';

// Only these module-owned constructors may declare the host's reserved alias.
const hostedOptions = new WeakSet<object>();
function hostRegistration<T extends object>(options: T): T {
  hostedOptions.add(options);
  return options;
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

export interface MCPResultContext<Context = unknown> {
  readonly context: Context;
  readonly submission: ToolCallContext<Context>['submission'];
  readonly callId: string;
  readonly serverName: string;
  readonly toolName: string;
}
export interface MCPOptions<Context = unknown> {
  /** Discover selected schemas on supported direct-mode models; never delays connection. */
  deferLoading?: boolean;
  name: string;
  tools: readonly string[];
  approvalMode?: 'auto' | 'approve';
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
  transformResultTimeout?: number;
}

abstract class MCP<Context> {
  readonly kind = 'mcp' as const;
  readonly deferLoading: boolean;
  readonly name: string;
  readonly tools: readonly string[];
  readonly approvalMode: 'auto' | 'approve';
  readonly startupTimeout: number;
  readonly executionTimeout: number;
  readonly before?: MCPOptions<Context>['before'];
  readonly approval?: MCPOptions<Context>['approval'];
  readonly transformResult?: MCPOptions<Context>['transformResult'];
  readonly transformResultTimeout?: number;

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
      !options.tools.length ||
      options.tools.some((name) => typeof name !== 'string' || !name)
    )
      throw new TypeError('MCP tools must select nonempty raw tool names');
    this.deferLoading = options.deferLoading ?? false;
    this.name = options.name;
    this.tools = Object.freeze([...options.tools]);
    this.approvalMode = options.approvalMode ?? 'auto';
    if (!['auto', 'approve'].includes(this.approvalMode))
      throw new TypeError('Invalid MCP approvalMode');
    this.startupTimeout = positive(options.startupTimeout ?? 10);
    this.executionTimeout = positive(options.executionTimeout ?? 60);
    if (
      options.transformResult !== undefined &&
      typeof options.transformResult !== 'function'
    )
      throw new TypeError('MCP transformResult must be callable');
    if (
      options.transformResultTimeout !== undefined &&
      (!options.transformResult ||
        positive(options.transformResultTimeout) > 3600)
    )
      throw new TypeError(
        'MCP transformResultTimeout requires a transform and at most 3600 seconds',
      );
    this.before = options.before;
    this.approval = options.approval;
    for (const key of ['before', 'approval'] as const) {
      if (this[key] !== undefined && typeof this[key] !== 'function')
        throw new TypeError(`MCP ${key} must be callable`);
      Object.defineProperty(this, key, { enumerable: false });
    }
    this.transformResult = options.transformResult;
    Object.defineProperty(this, 'transformResult', { enumerable: false });
    this.transformResultTimeout = options.transformResultTimeout;
    mcpToolNames([this]);
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
  cwd?: string;
  location?: 'host' | 'environment';
  /** Keep the process for the Session, or isolate it to each admitted turn. */
  lifetime?: 'session' | 'turn';
}

/** A native-owned process. Variables come from its explicitly selected location. */
export class StdioMCP<Context = unknown> extends MCP<Context> {
  readonly command: string;
  readonly args: readonly string[];
  readonly envVars: readonly string[];
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
    for (const name of ['command', 'args', 'envVars', 'cwd'])
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
  /** Connect at opening (default), or only when selected by a root operation. */
  activation?: 'session' | 'operation';
}

/** Selected tools on a native-owned HTTP MCP connection. */
export class HttpMCP<Context = unknown> extends MCP<Context> {
  readonly url: string;
  readonly bearerToken?: string;
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
    this.activation = options.activation ?? 'session';
    if (!['session', 'operation'].includes(this.activation))
      throw new TypeError('Invalid HTTP MCP activation');
    if (this.activation === 'operation' && hostedOptions.has(options))
      throw new TypeError(
        'Hosted MCP registrations do not support operation activation',
      );
    this.url = options.url;
    this.bearerToken = options.bearerToken;
    for (const name of ['url', 'bearerToken'])
      Object.defineProperty(this, name, { enumerable: false });
    Object.freeze(this);
  }
}

export type HostedVerificationMCPOptions<Context = unknown> = Omit<
  HttpMCPOptions<Context>,
  'name'
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
  'name'
>;

/**
 * Select personal ChatGPT Apps using the provider's explicit chatGPT credentials.
 * The target is fixed. No stored login, refresh or browser navigation occurs.
 * Connector completion requires authoritative backend grants for that account.
 */
export class ChatGPTAppsMCP<Context = unknown> extends HttpMCP<Context> {
  declare readonly name: 'codex_apps';
  constructor(options: ChatGPTAppsMCPOptions<Context>) {
    if ('url' in options || 'bearerToken' in options)
      throw new TypeError(
        'ChatGPT Apps has a fixed target and no bearerToken option',
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
    ...(server.approvalMode === 'approve'
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
    if (server.bearerToken !== undefined)
      config.http_headers = { Authorization: `Bearer ${server.bearerToken}` };
  } else {
    config.command = server.command;
    config.args = [...server.args];
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
  return new HttpMCP({
    name: server.name,
    url: server.url,
    bearerToken: server.bearerToken,
    activation: server.activation,
    deferLoading: server.deferLoading,
    tools,
    approvalMode: server.approvalMode,
    startupTimeout: server.startupTimeout,
    executionTimeout: server.executionTimeout,
    before: server.before,
    approval: server.approval,
    transformResult: server.transformResult,
    transformResultTimeout: server.transformResultTimeout,
  });
}

/** @internal Project exactly the native names fixed by the opening allowlist. */
export function mcpToolNames(
  servers: readonly Pick<MCP<unknown>, 'name' | 'tools'>[],
): Array<{ namespace: string; name: string }> {
  const project = (name: string) =>
    [...name].map((c) => (/[A-Za-z0-9_]/.test(c) ? c : '_')).join('');
  const namespaces = new Set<string>();
  const combined = new Set<string>();
  return servers.flatMap((server) => {
    const projected = project(server.name);
    const namespace = projected.startsWith('mcp__')
      ? projected
      : `mcp__${projected}`;
    if (namespaces.has(namespace))
      throw new TypeError(
        'MCP server aliases have colliding native namespaces',
      );
    namespaces.add(namespace);
    const leaves = new Set<string>();
    return server.tools.map((raw) => {
      const name = project(raw);
      if (leaves.has(name) || combined.has(namespace + name))
        throw new TypeError('MCP tool names collide after native projection');
      if (namespace.length + name.length + 2 > 128)
        throw new TypeError('MCP native tool name exceeds 128 bytes');
      leaves.add(name);
      combined.add(namespace + name);
      return { namespace, name };
    });
  });
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
        ...(server.deferLoading && !codeMode
          ? { omit_tools_from: ['code_mode'] }
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
  nativeGoals: boolean;
  checklist: boolean;
} {
  const functions: SessionTool[] = [];
  const mcp: McpTool[] = [];
  let nativeAgents: NativeAgents<any> | undefined;
  let search: WebSearch | undefined;
  let nativeGoals = false;
  let checklist = false;
  for (const tool of tools) {
    if (tool instanceof StdioMCP || tool instanceof HttpMCP) mcp.push(tool);
    else if (tool instanceof NativeAgents) {
      if (nativeAgents) throw new TypeError('Declare NativeAgents only once');
      nativeAgents = tool;
    } else if ('kind' in tool && tool.kind === 'web_search') {
      if (search) throw new TypeError('Declare WebSearch only once');
      for (const key of Object.keys(tool))
        if (!['kind', 'mode', 'route'].includes(key))
          throw new TypeError(
            `Unsupported WebSearch declaration field: ${key}`,
          );
      search = webSearch({ mode: tool.mode, route: tool.route });
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
    functions.some((tool) => tool.name === 'web_search')
  )
    throw new TypeError('Hosted WebSearch reserves the tool name web_search');
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
  mcpToolNames(mcp);
  return {
    tools: functions,
    mcp,
    nativeAgents,
    nativeGoals,
    checklist,
    webSearch: search,
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
    servers: Object.fromEntries(
      servers
        .filter((server) => server.transformResult)
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
    result: JsonObject;
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
  if (!server?.transformResult)
    throw new Error('Native MCP result has no selected transform');
  return server.transformResult(
    {
      context,
      submission,
      callId: notice.call_id,
      serverName: notice.server_name,
      toolName: notice.tool_name,
    },
    notice.result,
  );
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
      : mcpToolNames([server]).map((tool) => ({
          ...tool,
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
): Promise<JsonObject> {
  if (String(request._mcp_generation) !== generation.toString())
    return { action: 'deny' };
  const identity = jsonObject.parse(request.tool_name);
  const server = servers.find((candidate) =>
    mcpToolNames([candidate]).some(
      (tool) =>
        tool.namespace === identity.namespace && tool.name === identity.name,
    ),
  );
  if (
    !server ||
    (!server.before && !server.approval) ||
    request.phase !== 'before'
  )
    return { action: 'deny' };
  const names = mcpToolNames([server]);
  const index = names.findIndex(
    (tool) =>
      tool.namespace === identity.namespace && tool.name === identity.name,
  );
  const original = jsonObject.parse(
    request.route === 'direct'
      ? JSON.parse(request.input as string)
      : request.input,
  );
  let effective = jsonObject.parse(original);
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
      originalArguments: Object.freeze(jsonObject.parse(original)),
      effectiveArguments: Object.freeze(jsonObject.parse(effective)),
      signal: callbackSignal,
    });
  check();
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
          effective = jsonObject.parse(decision.arguments);
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
  check();
  // The effective candidate never shares storage with a retained callback view.
  return replaced
    ? { action: 'replace', value: effective }
    : { action: 'continue' };
}
