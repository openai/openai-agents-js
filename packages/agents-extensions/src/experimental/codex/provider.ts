import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  Usage,
  UserError,
  type AssistantMessageItem,
  type FunctionCallItem,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelRetryAdvice,
} from '@openai/agents-core';
import type { ThreadOptions } from '@openai/codex-sdk';
import { openCodexAppServer, type CodexAppServerOptions } from './appServer';
import { prepareCodexHistory } from './history';

export type CodexProviderOptions = {
  /** Options for the stock Codex client, including its configuration and credentials. */
  codexOptions?: CodexAppServerOptions;
  /** Local workspace and permissions for each Codex thread. */
  threadOptions?: Omit<ThreadOptions, 'model'>;
};

type ToolSpec = {
  type: 'function';
  name: string;
  description: string;
  inputSchema: unknown;
};
type ToolNamespace = {
  type: 'namespace';
  name: string;
  description: string;
  tools: ToolSpec[];
};
type CodexStreamEvent =
  | { type: 'output_text_delta'; delta: string; itemId: string }
  | {
      type: 'response_done';
      response: {
        id: string;
        output: (AssistantMessageItem | FunctionCallItem)[];
        usage: Usage;
        rawUsage?: Record<string, unknown>;
      };
    };

/**
 * Experimental model provider backed by stock Codex App Server.
 * The Agents SDK Runner owns function tools, handoffs, and history.
 */
export class CodexProvider implements ModelProvider {
  constructor(private readonly options: CodexProviderOptions = {}) {}

  getModel(modelName?: string): Model {
    return new CodexModel(this.options, modelName || undefined);
  }
}

class CodexModel implements Model {
  readonly _supportsStoredResponseId = false;
  readonly _sandboxModelCapabilities = {
    responsesCompaction: false,
    hostedApplyPatch: false,
    toolNamespace: 'agents_sdk',
    useProviderDefaults: true,
  };

  constructor(
    private readonly options: CodexProviderOptions,
    private readonly modelName?: string,
  ) {}

  async getResponse(request: ModelRequest) {
    for await (const event of this.getStreamedResponse(request)) {
      if (event.type === 'response_done') {
        const { id, ...response } = event.response;
        return { responseId: id, ...response };
      }
    }
    throw new Error('Codex finished without a response.');
  }

  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncGenerator<CodexStreamEvent> {
    const { effort, summary, verbosity, sdkSandbox } =
      prepareModelSettings(request);
    const { history, turnInput } = prepareCodexHistory(request.input);
    const { tools, identities } = prepareDynamicTools(request);
    const threadOptions = this.options.threadOptions;
    const cwd = resolve(threadOptions?.workingDirectory ?? process.cwd());
    request.signal?.throwIfAborted();
    if (!threadOptions?.skipGitRepoCheck) await requireGitRepository(cwd);

    const server = await openCodexAppServer({
      codexOptions: appServerOptions(this.options, sdkSandbox),
      cwd,
      signal: request.signal,
    });
    let threadId: string;
    let usage = new Usage();
    let rawUsage: Record<string, unknown> | undefined;
    const reasoningSummaries: string[] = [];
    const output = new Map<string, AssistantMessageItem>();
    const streamedItems = new Set<string>();
    let sdkCall: FunctionCallItem | undefined;
    let completed = false;
    try {
      await server.request('initialize', {
        clientInfo: { name: 'openai_agents_sdk', version: '1' },
        capabilities: { experimentalApi: true },
      });
      server.notify('initialized');
      if (sdkSandbox) {
        // MCP callbacks can access resources without an execution environment.
        // Read the effective configuration before starting a thread (and MCP).
        const config = record(
          record(
            await server.request('config/read', { cwd, includeLayers: false }),
          )?.config,
        );
        if (!config) {
          throw new UserError(
            'CodexProvider could not verify MCP configuration for the SDK sandbox.',
          );
        }
        const mcpServers = record(config.mcp_servers);
        if (
          mcpServers &&
          Object.values(mcpServers).some(
            (entry) => record(entry)?.enabled !== false,
          )
        ) {
          throw new UserError(
            'CodexProvider with SandboxAgent requires Codex MCP servers to be disabled. Set mcp_servers.<name>.enabled=false in the Codex configuration; expose tools through the SDK instead.',
          );
        }
      }
      threadId = responseId(
        await server.request('thread/start', {
          cwd,
          ephemeral: true,
          model: this.modelName,
          developerInstructions: request.systemInstructions,
          approvalPolicy: threadOptions?.approvalPolicy,
          sandbox: threadOptions?.sandboxMode,
          threadSource: threadOptions?.threadSource,
          ...(sdkSandbox && { environments: [] }),
          ...(verbosity !== undefined && {
            config: { model_verbosity: verbosity },
          }),
          ...(tools.length && { dynamicTools: tools }),
          ...(threadOptions?.additionalDirectories?.length && {
            runtimeWorkspaceRoots: [
              cwd,
              ...threadOptions.additionalDirectories.map((path) =>
                resolve(cwd, path),
              ),
            ],
          }),
        }),
        'thread',
      );
      if (history.length) {
        await server.request('thread/inject_items', {
          threadId,
          items: history,
        });
      }
      const turnId = responseId(
        await server.request('turn/start', {
          threadId,
          input: turnInput,
          effort: effort ?? threadOptions?.modelReasoningEffort,
          summary,
          ...(sdkSandbox && { environments: [] }),
          outputSchema:
            request.outputType === 'text'
              ? undefined
              : request.outputType.schema,
        }),
        'turn',
      );
      for await (const event of server.events) {
        const params = record(event.params);
        if (event.id !== undefined) {
          if (
            event.method !== 'item/tool/call' ||
            params?.threadId !== threadId ||
            params.turnId !== turnId
          ) {
            throw new Error(
              'Codex requested an unsupported approval or client action.',
            );
          }
          const call = sdkToolCall(params, identities);
          if (!sdkCall) {
            sdkCall = call;
            // Stop the Codex turn before handing control to the Runner. The
            // Runner can pause for approval without keeping a child process alive.
            await server.request('turn/interrupt', { threadId, turnId });
          }
          continue;
        }
        if (params?.threadId !== threadId) continue;
        if (event.method === 'turn/completed') {
          const turn = record(params.turn);
          if (turn?.id !== turnId) continue;
          if (turn.status !== (sdkCall ? 'interrupted' : 'completed')) {
            throw new Error('Codex did not finish the turn successfully.');
          }
          completed = true;
          break;
        }
        if (params.turnId !== turnId) continue;
        if (
          event.method === 'item/agentMessage/delta' &&
          typeof params.itemId === 'string' &&
          typeof params.delta === 'string'
        ) {
          streamedItems.add(params.itemId);
          yield {
            type: 'output_text_delta',
            delta: params.delta,
            itemId: params.itemId,
          };
        } else if (event.method === 'item/completed') {
          const item = record(params.item);
          if (item?.type === 'reasoning' && summary !== undefined) {
            if (Array.isArray(item.summary)) {
              reasoningSummaries.push(
                ...item.summary.filter(
                  (part): part is string => typeof part === 'string',
                ),
              );
            }
            continue;
          }
          if (
            item?.type !== 'agentMessage' ||
            typeof item.id !== 'string' ||
            typeof item.text !== 'string'
          ) {
            continue;
          }
          if (
            !streamedItems.has(item.id) &&
            !output.has(item.id) &&
            item.text
          ) {
            yield {
              type: 'output_text_delta',
              delta: item.text,
              itemId: item.id,
            };
          }
          output.set(item.id, {
            type: 'message',
            id: item.id,
            role: 'assistant',
            status: 'completed',
            ...(item.phase === 'commentary' || item.phase === 'final_answer'
              ? { phase: item.phase }
              : {}),
            content: [{ type: 'output_text', text: item.text }],
          });
        } else if (event.method === 'thread/tokenUsage/updated') {
          const tokenUsage = record(params.tokenUsage);
          usage = readUsage(tokenUsage?.total);
          if (request.modelSettings.preserveRawUsage) rawUsage = tokenUsage;
        }
      }
    } finally {
      await server.close();
    }
    request.signal?.throwIfAborted();
    if (!completed || (!sdkCall && output.size === 0)) {
      throw new Error('Codex finished without a completed response.');
    }
    const items = [...output.values(), ...(sdkCall ? [sdkCall] : [])];
    if (reasoningSummaries.length) {
      items[items.length - 1].providerData = {
        codexReasoningSummary: reasoningSummaries,
      };
    }
    yield {
      type: 'response_done',
      response: {
        id: threadId,
        output: items,
        usage,
        ...(rawUsage !== undefined && { rawUsage }),
      },
    };
  }

  getRetryAdvice(): ModelRetryAdvice {
    // Codex may have already executed native tools or changed files.
    return { replaySafety: 'unsafe' };
  }
}

function prepareModelSettings(request: ModelRequest) {
  if (
    request.previousResponseId !== undefined ||
    request.conversationId !== undefined ||
    request.prompt !== undefined
  ) {
    throw new UserError(
      'CodexProvider does not support Responses API state or prompt IDs.',
    );
  }

  const {
    timeoutMs: _timeoutMs,
    retry: _retry,
    preserveRawUsage: _preserveRawUsage,
    toolChoice,
    store,
    reasoning,
    text,
    ...unsupported
  } = request.modelSettings;
  const { effort, summary, ...unsupportedReasoning } = reasoning ?? {};
  const { verbosity, ...unsupportedText } = text ?? {};
  for (const [prefix, settings] of [
    [
      '',
      {
        ...unsupported,
        toolChoice: toolChoice === 'auto' ? undefined : toolChoice,
        store: store === false ? undefined : store,
      },
    ],
    ['reasoning.', unsupportedReasoning],
    ['text.', unsupportedText],
  ] as const) {
    const entry = Object.entries(settings).find(
      ([, value]) => value !== undefined,
    );
    if (entry) {
      throw new UserError(
        `CodexProvider does not support modelSettings.${prefix}${entry[0]}. Configure Codex through CodexProvider options.`,
      );
    }
  }

  const { _internal } = request as ModelRequest & {
    _internal?: {
      reasoningEffortImplicit?: boolean;
      textVerbosityImplicit?: boolean;
      sdkSandbox?: boolean;
    };
  };
  return {
    sdkSandbox: _internal?.sdkSandbox === true,
    effort: _internal?.reasoningEffortImplicit
      ? undefined
      : (effort ?? undefined),
    summary: summary ?? undefined,
    verbosity: _internal?.textVerbosityImplicit
      ? undefined
      : (verbosity ?? undefined),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function responseId(result: unknown, field: 'thread' | 'turn'): string {
  const id = record(record(result)?.[field])?.id;
  if (typeof id !== 'string' || !id) {
    throw new Error(`Codex did not return a ${field} ID.`);
  }
  return id;
}

function toolIdentity(name: string, namespace?: string | null) {
  return JSON.stringify([namespace ?? null, name]);
}

function prepareDynamicTools(request: ModelRequest) {
  const tools: (ToolSpec | ToolNamespace)[] = [];
  const namespaces = new Map<string, ToolNamespace>();
  const identities = new Set<string>();
  const add = (
    tool: ToolSpec,
    namespace?: string,
    namespaceDescription?: string,
  ) => {
    const identity = toolIdentity(tool.name, namespace);
    if (identities.has(identity)) {
      throw new UserError('CodexProvider requires unique SDK tool names.');
    }
    identities.add(identity);
    if (namespace === undefined) {
      tools.push(tool);
      return;
    }
    let group = namespaces.get(namespace);
    if (!group) {
      if (!namespaceDescription) {
        throw new UserError(
          'CodexProvider requires a tool namespace description.',
        );
      }
      group = {
        type: 'namespace',
        name: namespace,
        description: namespaceDescription,
        tools: [],
      };
      namespaces.set(namespace, group);
      tools.push(group);
    }
    group.tools.push(tool);
  };

  for (const tool of request.tools) {
    if (
      tool.type !== 'function' ||
      tool.deferLoading ||
      tool.outputSchema !== undefined ||
      tool.allowedCallers?.some((caller) => caller !== 'direct')
    ) {
      throw new UserError(
        'CodexProvider supports direct SDK function tools and handoffs.',
      );
    }
    add(
      {
        type: 'function',
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      },
      tool.namespace,
      tool.namespaceDescription,
    );
  }
  for (const handoff of request.handoffs) {
    add({
      type: 'function',
      name: handoff.toolName,
      description: handoff.toolDescription,
      inputSchema: handoff.inputJsonSchema,
    });
  }
  return { tools, identities };
}

function sdkToolCall(
  params: Record<string, unknown>,
  identities: Set<string>,
): FunctionCallItem {
  const { callId, namespace, tool } = params;
  const args = JSON.stringify(params.arguments);
  if (
    typeof callId !== 'string' ||
    !callId ||
    typeof tool !== 'string' ||
    !(typeof namespace === 'string' || namespace === null) ||
    !identities.has(toolIdentity(tool, namespace)) ||
    args === undefined
  ) {
    throw new Error('Codex requested an unrecognized SDK tool call.');
  }
  return {
    type: 'function_call',
    callId,
    name: tool,
    ...(namespace !== null && { namespace }),
    status: 'completed',
    arguments: args,
  };
}

function readUsage(value: unknown) {
  const total = record(value);
  const number = (key: string) => {
    const count = total?.[key];
    return typeof count === 'number' ? count : 0;
  };
  return new Usage({
    inputTokens: number('inputTokens'),
    outputTokens: number('outputTokens'),
    inputTokensDetails: {
      cached_tokens: number('cachedInputTokens'),
      cache_write_tokens: number('cacheWriteInputTokens'),
    },
    outputTokensDetails: { reasoning_tokens: number('reasoningOutputTokens') },
  });
}

function appServerOptions(
  options: CodexProviderOptions,
  sdkSandbox = false,
): CodexAppServerOptions | undefined {
  const thread = options.threadOptions;
  const configOverrides = [...(options.codexOptions?.configOverrides ?? [])];
  if (thread?.networkAccessEnabled !== undefined) {
    configOverrides.push(
      `sandbox_workspace_write.network_access=${thread.networkAccessEnabled}`,
    );
  }
  const webSearch =
    thread?.webSearchMode ??
    (thread?.webSearchEnabled === undefined
      ? undefined
      : thread.webSearchEnabled
        ? 'live'
        : 'disabled');
  if (webSearch)
    configOverrides.push(`web_search=${JSON.stringify(webSearch)}`);
  if (sdkSandbox) {
    // Append after caller options so inherited/explicit Codex tools cannot
    // bypass the SDK's sandbox tools, approvals, roles, and path policy.
    configOverrides.push(
      'features.apps=false',
      'features.plugins=false',
      'features.multi_agent=false',
      'features.multi_agent_v2=false',
      'features.hooks=false',
      'features.code_mode=false',
      'notify=[]',
      'web_search="disabled"',
    );
  }
  return configOverrides.length
    ? { ...options.codexOptions, configOverrides }
    : options.codexOptions;
}

async function requireGitRepository(cwd: string) {
  for (let dir = cwd; ; dir = dirname(dir)) {
    try {
      const entry = await stat(join(dir, '.git'));
      if (entry.isDirectory() || entry.isFile()) return;
    } catch (error) {
      const code = record(error)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    if (dirname(dir) === dir) break;
  }
  throw new UserError(
    'CodexProvider requires a Git repository. Set skipGitRepoCheck to run elsewhere.',
  );
}
