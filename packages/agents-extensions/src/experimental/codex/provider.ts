import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  Usage,
  UserError,
  protocol,
  type ApplyPatchCallItem,
  type AssistantMessageItem,
  type FunctionCallItem,
  type HostedToolCallItem,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelRetryAdvice,
  type ReasoningItem,
  type ShellCallItem,
  type ToolSearchCallItem,
  type ToolSearchOutputItem,
} from '@openai/agents-core';
import type { ThreadOptions } from '@openai/codex-sdk';
import { getToolCallDisplayName } from '@openai/agents-core/utils';
import { fromOpenAIToolSearchOutputToolPayload } from '@openai/agents-core/utils/internal';
import { z } from 'zod';
import { openCodexAppServer, type CodexAppServerOptions } from './appServer';
import { prepareCodexHistory, verifyAudioModel } from './history';

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
  deferLoading?: boolean;
};
type ToolNamespace = {
  type: 'namespace';
  name: string;
  description: string;
  tools: ToolSpec[];
};
type CodexStreamEvent =
  | protocol.StreamEventResponseStarted
  | protocol.StreamEventGenericItem
  | { type: 'output_text_delta'; delta: string; itemId: string }
  | {
      type: 'response_done';
      response: {
        id: string;
        output: CodexOutputItem[];
        usage: Usage;
        rawUsage?: Record<string, unknown>;
      };
    };
type CodexOutputItem =
  | AssistantMessageItem
  | FunctionCallItem
  | ShellCallItem
  | ApplyPatchCallItem
  | HostedToolCallItem
  | ReasoningItem
  | ToolSearchCallItem
  | ToolSearchOutputItem;
type ToolIdentity = {
  name: string;
  namespace?: string;
  kind?: 'shell' | 'apply_patch';
};
type HostedWebSearch = {
  mode: 'cached' | 'live';
  contentTypes?: string[];
  contextSize?: unknown;
  allowedDomains?: unknown;
  location?: Record<string, unknown>;
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
    sdkLocalTools: true,
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
    const { effort, summary, verbosity, sdkSandbox, encryptedReasoning } =
      prepareModelSettings(request);
    const { history, turnInput } = prepareCodexHistory(
      request.input,
      request.tools,
    );
    const { tools, identities, deferred, localExecution, webSearch } =
      prepareDynamicTools(request);
    const isolateNativeTools = sdkSandbox || localExecution;
    const threadOptions = this.options.threadOptions;
    const cwd = resolve(threadOptions?.workingDirectory ?? process.cwd());
    request.signal?.throwIfAborted();
    if (!threadOptions?.skipGitRepoCheck) await requireGitRepository(cwd);

    const server = await initializeCodexAppServer({
      codexOptions: appServerOptions(
        this.options,
        isolateNativeTools,
        deferred,
        webSearch,
      ),
      cwd,
      signal: request.signal,
    });
    let threadId: string;
    let usage = new Usage();
    let rawUsage: Record<string, unknown> | undefined;
    const reasoningSummaries: string[] = [];
    const output = new Map<string, CodexOutputItem>();
    const streamedItems = new Set<string>();
    let sdkCall:
      FunctionCallItem | ShellCallItem | ApplyPatchCallItem | undefined;
    let completed = false;
    const threadConfig: Record<string, unknown> = {
      ...(verbosity !== undefined && { model_verbosity: verbosity }),
    };
    try {
      server.notify('initialized');
      if (this.options.codexOptions?.apiKey) {
        await server.request('account/login/start', {
          type: 'apiKey',
          apiKey: this.options.codexOptions.apiKey,
        });
      }
      if (isolateNativeTools || webSearch || deferred) {
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
        if (isolateNativeTools || deferred) {
          const configuredNamespaces = record(
            record(config.features)?.code_mode,
          )?.direct_only_tool_namespaces;
          const directNamespaces = new Set<string>(
            Array.isArray(configuredNamespaces) ? configuredNamespaces : [],
          );
          for (const tool of tools) {
            if (tool.type !== 'namespace') continue;
            if (tool.tools.some((member) => member.deferLoading)) {
              // Preserve deferral even when an inherited override makes this
              // SDK namespace eager. Unrelated namespace choices remain intact.
              directNamespaces.delete(tool.name);
            } else if (isolateNativeTools && tool.name === 'agents_sdk') {
              directNamespaces.add(tool.name);
            }
          }
          if (deferred) {
            // Catalog code-mode-only settings override the code_mode feature.
            // Keep native discovery direct so Codex emits genuine search items
            // that the Runner uses to authorize deferred SDK execution.
            directNamespaces.add('functions');
            threadConfig['features.code_mode_tool_search'] = true;
          }
          threadConfig['features.code_mode.direct_only_tool_namespaces'] = [
            ...directNamespaces,
          ];
        }
        if (webSearch) {
          const capabilities = record(
            await server.request('modelProvider/capabilities/read', {}),
          );
          const requirements = record(
            record(await server.request('configRequirements/read', {}))
              ?.requirements,
          );
          const allowedModes = requirements?.allowedWebSearchModes;
          if (
            capabilities?.webSearch !== true ||
            config.model_catalog_json != null ||
            config.web_search !== webSearch.mode ||
            record(config.features)?.standalone_web_search !== false ||
            (Array.isArray(allowedModes) &&
              !allowedModes.includes(webSearch.mode) &&
              !(webSearch.mode === 'live' && allowedModes.includes('cached')))
          ) {
            throw new UserError(
              'CodexProvider could not enable hosted web search under the effective Codex provider and managed policy.',
            );
          }
          const effective = record(record(config.tools)?.web_search);
          if (
            (webSearch.contextSize !== undefined &&
              effective?.context_size !== webSearch.contextSize) ||
            (webSearch.allowedDomains !== undefined &&
              !isDeepStrictEqual(
                effective?.allowed_domains,
                webSearch.allowedDomains,
              )) ||
            Object.entries(webSearch.location ?? {}).some(
              ([key, value]) =>
                value != null && record(effective?.location)?.[key] !== value,
            )
          ) {
            throw new UserError(
              'CodexProvider could not apply the requested hosted web search context size, domains, or location.',
            );
          }
        }
        const mcpServers = record(config.mcp_servers);
        if (
          isolateNativeTools &&
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
      const startedThread = await server.request('thread/start', {
        cwd,
        ephemeral: true,
        model: this.modelName,
        developerInstructions:
          [
            request.systemInstructions,
            isolateNativeTools &&
              'Use the agents_sdk namespace for workspace commands, file access, and editing. Native workspace tools have no execution environment in this run.',
            request.outputType !== 'text' &&
              !request.outputType.strict &&
              `Return your final answer as JSON matching this schema. Omit Markdown fences and surrounding text.\n${JSON.stringify(request.outputType.schema)}`,
          ]
            .filter(Boolean)
            .join('\n\n') || undefined,
        approvalPolicy: threadOptions?.approvalPolicy,
        sandbox: threadOptions?.sandboxMode,
        threadSource: threadOptions?.threadSource,
        ...(isolateNativeTools && { environments: [] }),
        ...(Object.keys(threadConfig).length && { config: threadConfig }),
        ...(tools.length && { dynamicTools: tools }),
        ...((deferred || webSearch || encryptedReasoning) && {
          experimentalRawEvents: true,
        }),
        ...(threadOptions?.additionalDirectories?.length && {
          runtimeWorkspaceRoots: [
            cwd,
            ...threadOptions.additionalDirectories.map((path) =>
              resolve(cwd, path),
            ),
          ],
        }),
      });
      threadId = responseId(startedThread, 'thread');
      const effectiveModel = record(startedThread)?.model;
      if (
        webSearch &&
        (!(
          typeof effectiveModel === 'string' &&
          ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'].includes(effectiveModel)
        ) ||
          (webSearch.mode === 'cached' &&
            record(record(startedThread)?.sandbox)?.type ===
              'dangerFullAccess'))
      ) {
        throw new UserError(
          'CodexProvider hosted web search requires a verified stock model (gpt-5.5, gpt-5.4, or gpt-5.4-mini), and cached-only search requires a Codex sandbox. Other stock models may use client web tools instead of hosted web search.',
        );
      }
      if (webSearch?.contentTypes) {
        const supportedTypes =
          effectiveModel === 'gpt-5.5' ? ['text', 'image'] : ['text'];
        if (
          webSearch.contentTypes.length !== supportedTypes.length ||
          !supportedTypes.every((type) =>
            webSearch.contentTypes!.includes(type),
          )
        ) {
          throw new UserError(
            `CodexProvider cannot preserve the requested hosted web search content types on ${effectiveModel}.`,
          );
        }
      }
      await verifyAudioModel(
        { history, turnInput },
        record(startedThread)?.model,
        server,
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
          ...(isolateNativeTools && { environments: [] }),
          outputSchema:
            request.outputType !== 'text' && request.outputType.strict
              ? request.outputType.schema
              : undefined,
        }),
        'turn',
      );
      yield { type: 'response_started' };
      const summaryOutputIndices = new Map<string, number>();
      let sequenceNumber = 0;
      for await (const event of server.events) {
        sequenceNumber++;
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
            if (
              call.type === 'function_call' &&
              (call.namespace ||
                !request.handoffs.some(
                  (handoff) => handoff.toolName === call.name,
                )) &&
              request.tools.some(
                (tool) =>
                  tool.type === 'function' &&
                  tool.name === call.name &&
                  tool.namespace === call.namespace &&
                  !tool.deferLoading,
              )
            ) {
              // Stock delivers the complete arguments in a single callback.
              const event = { method: 'item/tool/call', callId: call.callId };
              yield {
                type: 'model',
                event,
                toolInput: {
                  type: 'start',
                  callId: call.callId,
                  name: getToolCallDisplayName(call) ?? call.name,
                },
              };
              yield {
                type: 'model',
                event,
                toolInput: {
                  type: 'delta',
                  callId: call.callId,
                  delta: call.arguments,
                },
              };
            }
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
          summary !== undefined &&
          (event.method === 'item/reasoning/summaryPartAdded' ||
            event.method === 'item/reasoning/summaryTextDelta') &&
          typeof params.itemId === 'string' &&
          typeof params.summaryIndex === 'number'
        ) {
          const isDelta = event.method === 'item/reasoning/summaryTextDelta';
          if (isDelta && typeof params.delta !== 'string') continue;
          let outputIndex = summaryOutputIndices.get(params.itemId);
          if (outputIndex === undefined) {
            if (!output.has(params.itemId)) {
              output.set(params.itemId, {
                type: 'reasoning',
                id: params.itemId,
                content: [],
              });
            }
            outputIndex = [...output.keys()].indexOf(params.itemId);
            summaryOutputIndices.set(params.itemId, outputIndex);
          }
          yield {
            type: 'model',
            event: {
              ...(isDelta
                ? {
                    type: 'response.reasoning_summary_text.delta',
                    delta: params.delta,
                  }
                : {
                    type: 'response.reasoning_summary_part.added',
                    part: { type: 'summary_text', text: '' },
                  }),
              item_id: params.itemId,
              summary_index: params.summaryIndex,
              output_index: outputIndex,
              sequence_number: sequenceNumber,
            },
          };
          continue;
        }

        if (
          (deferred || webSearch || encryptedReasoning) &&
          event.method === 'rawResponseItem/completed'
        ) {
          const raw = record(params.item);
          if (
            encryptedReasoning &&
            raw?.type === 'reasoning' &&
            typeof raw.id === 'string'
          ) {
            const content = Array.isArray(raw.summary)
              ? raw.summary.flatMap((value) => {
                  const part = record(value);
                  return typeof part?.text === 'string'
                    ? [{ type: 'input_text' as const, text: part.text }]
                    : [];
                })
              : [];
            output.set(raw.id, {
              type: 'reasoning',
              id: raw.id,
              content,
              ...(typeof raw.encrypted_content === 'string' && {
                providerData: { encrypted_content: raw.encrypted_content },
              }),
            });
          }
          const item = deferred
            ? sdkToolSearchItem(raw, identities)
            : undefined;
          if (item) output.set(`${item.type}:${item.id ?? item.call_id}`, item);
          if (
            webSearch &&
            raw?.type === 'web_search_call' &&
            typeof raw.id === 'string'
          ) {
            const {
              internal_chat_message_metadata_passthrough: _metadata,
              status,
              ...providerData
            } = raw;
            output.set(raw.id, {
              type: 'hosted_tool_call',
              id: raw.id,
              name: 'web_search_call',
              ...(typeof status === 'string' && { status }),
              providerData,
            });
          }
          continue;
        }
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
          if (
            item?.type === 'reasoning' &&
            summary !== undefined &&
            !encryptedReasoning
          ) {
            if (Array.isArray(item.summary)) {
              const parts = item.summary.filter(
                (part): part is string => typeof part === 'string',
              );
              reasoningSummaries.push(...parts);
              if (parts.length && typeof item.id === 'string') {
                output.set(item.id, {
                  type: 'reasoning',
                  id: item.id,
                  content: parts.map((text) => ({ type: 'input_text', text })),
                });
              }
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
        ...items[items.length - 1].providerData,
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
    providerData,
    ...unsupported
  } = request.modelSettings;
  const { effort, summary, ...unsupportedReasoning } = reasoning ?? {};
  const { verbosity, ...unsupportedText } = text ?? {};
  const { include, ...unsupportedProviderData } = providerData ?? {};
  if (
    include !== undefined &&
    (!Array.isArray(include) ||
      include.some((value) => value !== 'reasoning.encrypted_content'))
  ) {
    throw new UserError(
      'CodexProvider supports only providerData.include=["reasoning.encrypted_content"].',
    );
  }
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
    ['providerData.', unsupportedProviderData],
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
    encryptedReasoning:
      Array.isArray(include) && include.includes('reasoning.encrypted_content'),
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

async function initializeCodexAppServer(
  options: Parameters<typeof openCodexAppServer>[0],
) {
  // Concurrent first starts can race stock Codex's SQLite initialization. Retry
  // exited children with bounded backoff before any thread, login, model
  // request, or tool execution. The winning cold start needs time to finish.
  const retryDelays = [200, 800, 2000];
  for (let attempt = 0; ; attempt++) {
    options?.signal?.throwIfAborted();
    const server = await openCodexAppServer(options);
    try {
      await server.request('initialize', {
        clientInfo: { name: 'openai_agents_sdk', version: '1' },
        capabilities: { experimentalApi: true },
      });
      return server;
    } catch (error) {
      await server.close();
      options?.signal?.throwIfAborted();
      if (
        attempt >= retryDelays.length ||
        record(error)?.code !== 'CODEX_APP_SERVER_EXITED'
      ) {
        throw error;
      }
      await delay(retryDelays[attempt], undefined, { signal: options?.signal });
    }
  }
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
  const identities = new Map<string, ToolIdentity>();
  let deferred = false;
  let localExecution = false;
  const localToolKinds = new Set<string>();
  let webSearch: HostedWebSearch | undefined;
  const add = (
    tool: ToolSpec,
    namespace?: string,
    namespaceDescription?: string,
    sdkIdentity: ToolIdentity = { name: tool.name, namespace },
  ) => {
    const identity = toolIdentity(tool.name, namespace);
    if (identities.has(identity)) {
      throw new UserError('CodexProvider requires unique SDK tool names.');
    }
    identities.set(identity, sdkIdentity);
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
      tool.type === 'hosted_tool' &&
      tool.providerData?.type === 'web_search'
    ) {
      const data = tool.providerData;
      if (
        webSearch ||
        tool.name !== 'web_search' ||
        data.name !== 'web_search' ||
        data.image_settings !== undefined ||
        (data.search_content_types !== undefined &&
          (!Array.isArray(data.search_content_types) ||
            data.search_content_types.length < 1 ||
            data.search_content_types.length > 2 ||
            !data.search_content_types.includes('text') ||
            data.search_content_types.some(
              (type: unknown) => type !== 'text' && type !== 'image',
            )))
      )
        throw new UserError(
          'CodexProvider supports one canonical hosted web_search tool with stock content types, without image settings.',
        );
      const { type: _locationType, ...location } =
        record(data.user_location) ?? {};
      webSearch = {
        mode: data.external_web_access === false ? 'cached' : 'live',
        contentTypes: data.search_content_types,
        contextSize: data.search_context_size,
        allowedDomains: record(data.filters)?.allowed_domains,
        ...(data.user_location != null && { location }),
      };
      continue;
    }
    if (tool.type === 'shell' || tool.type === 'apply_patch') {
      if (localToolKinds.has(tool.type)) {
        throw new UserError(
          `CodexProvider supports one SDK ${tool.type} tool so the Runner can select its execution and approval handlers unambiguously.`,
        );
      }
      localToolKinds.add(tool.type);
      if (
        tool.allowedCallers?.some((caller) => caller !== 'direct') ||
        (tool.type === 'shell' &&
          tool.environment?.type !== undefined &&
          tool.environment.type !== 'local')
      ) {
        throw new UserError(
          'CodexProvider supports local SDK shell and apply-patch tools with direct callers.',
        );
      }
      localExecution = true;
      let description =
        tool.type === 'shell'
          ? 'Run commands through the SDK shell. The SDK owns execution and approvals.'
          : 'Apply a V4A file operation through the SDK editor. The SDK owns execution and approvals.';
      if (
        tool.type === 'shell' &&
        tool.environment?.type === 'local' &&
        tool.environment.skills?.length
      ) {
        const skills = tool.environment.skills.map(
          ({ name, description, path }) => ({ name, description, path }),
        );
        description += ` Available local skills: ${JSON.stringify(skills)}. Read SKILL.md in the selected skill directory using this shell.`;
      }
      const schema =
        tool.type === 'shell'
          ? z.object({
              action: z.object({
                commands: protocol.ShellAction.shape.commands,
                timeout_ms: protocol.ShellAction.shape.timeoutMs,
                max_output_length: protocol.ShellAction.shape.maxOutputLength,
              }),
            })
          : z.object({
              operation: z.union([
                protocol.ApplyPatchOperationCreateFile,
                protocol.ApplyPatchOperationUpdateFile.omit({
                  moveTo: true,
                }).extend({
                  move_to: protocol.ApplyPatchOperationUpdateFile.shape.moveTo,
                }),
                protocol.ApplyPatchOperationDeleteFile,
              ]),
            });
      add(
        {
          type: 'function',
          name: tool.name,
          description,
          inputSchema: z.toJSONSchema(schema),
        },
        'agents_sdk',
        'Tools executed by the Agents SDK.',
        { name: tool.name, kind: tool.type },
      );
      continue;
    }
    if (
      tool.type === 'hosted_tool' &&
      tool.name === 'tool_search' &&
      tool.providerData?.type === 'tool_search' &&
      tool.providerData.execution !== 'client' &&
      tool.providerData.description == null &&
      tool.providerData.parameters == null
    ) {
      // Stock Codex discovers deferred dynamic tools itself. Client callbacks
      // and custom search schemas require the SDK's own search executor.
      continue;
    }
    if (
      tool.type !== 'function' ||
      tool.outputSchema !== undefined ||
      tool.allowedCallers?.some((caller) => caller !== 'direct')
    ) {
      throw new UserError(
        'CodexProvider supports direct SDK function tools and handoffs.',
      );
    }
    deferred ||= tool.deferLoading === true;
    if (tool.deferLoading && (tool.namespace ?? tool.name) === 'functions') {
      throw new UserError(
        'Codex native tool discovery reserves the functions namespace; choose a different deferred SDK tool namespace or name.',
      );
    }
    add(
      {
        type: 'function',
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
        ...(tool.deferLoading && { deferLoading: true }),
      },
      tool.namespace ?? (tool.deferLoading ? tool.name : undefined),
      tool.namespaceDescription ??
        (tool.deferLoading ? tool.description || tool.name : undefined),
      { name: tool.name, namespace: tool.namespace },
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
  return { tools, identities, deferred, localExecution, webSearch };
}

function sdkToolCall(
  params: Record<string, unknown>,
  identities: Map<string, ToolIdentity>,
): FunctionCallItem | ShellCallItem | ApplyPatchCallItem {
  const { callId, namespace, tool } = params;
  const args = JSON.stringify(params.arguments);
  const identity =
    typeof tool === 'string' &&
    (typeof namespace === 'string' || namespace === null)
      ? identities.get(toolIdentity(tool, namespace))
      : undefined;
  if (
    typeof callId !== 'string' ||
    !callId ||
    typeof tool !== 'string' ||
    !(typeof namespace === 'string' || namespace === null) ||
    !identity ||
    args === undefined
  ) {
    throw new Error('Codex requested an unrecognized SDK tool call.');
  }
  if (identity.kind === 'shell') {
    const action = record(record(params.arguments)?.action);
    return protocol.ShellCallItem.parse({
      type: 'shell_call',
      callId,
      status: 'completed',
      action: {
        commands: action?.commands,
        timeoutMs: action?.timeout_ms,
        maxOutputLength: action?.max_output_length,
      },
      providerData: { codexToolNamespace: namespace, codexToolName: tool },
    });
  }
  if (identity.kind === 'apply_patch') {
    const operation = record(record(params.arguments)?.operation);
    return protocol.ApplyPatchCallItem.parse({
      type: 'apply_patch_call',
      callId,
      status: 'completed',
      operation: {
        ...operation,
        ...(operation?.move_to !== undefined && { moveTo: operation.move_to }),
      },
      providerData: { codexToolNamespace: namespace, codexToolName: tool },
    });
  }
  return {
    type: 'function_call',
    callId,
    name: identity.name,
    ...(identity.namespace !== undefined && { namespace: identity.namespace }),
    status: 'completed',
    arguments: args,
    ...(namespace !== (identity.namespace ?? null) && {
      providerData: { codexToolNamespace: namespace, codexToolName: tool },
    }),
  };
}

function sdkToolSearchItem(
  value: unknown,
  identities: Map<string, ToolIdentity>,
): ToolSearchCallItem | ToolSearchOutputItem | undefined {
  const item = record(value);
  if (
    !item ||
    (item.type !== 'tool_search_call' && item.type !== 'tool_search_output') ||
    item.execution !== 'client' ||
    !(typeof item.call_id === 'string' || item.call_id === null)
  )
    return undefined;
  const common = {
    ...(typeof item.id === 'string' && { id: item.id }),
    call_id: item.call_id,
    execution: 'client' as const,
    ...(typeof item.status === 'string' && { status: item.status }),
  };
  if (item.type === 'tool_search_call') {
    if (typeof item.arguments !== 'string' && !record(item.arguments))
      return undefined;
    return {
      ...common,
      type: 'tool_search_call',
      arguments: item.arguments as string | Record<string, unknown>,
    };
  }
  if (!Array.isArray(item.tools)) return undefined;
  // Native discovery may also return Codex MCP tools. Only expose descriptors
  // for SDK-owned functions to the Runner's discovery and execution machinery.
  const tools = item.tools.flatMap((value) => {
    const tool = record(value);
    if (
      tool?.type !== 'namespace' ||
      typeof tool.name !== 'string' ||
      !Array.isArray(tool.tools)
    )
      return [];
    const members = tool.tools.filter((value) => {
      const member = record(value);
      return (
        member?.type === 'function' &&
        typeof member.name === 'string' &&
        identities.has(toolIdentity(member.name, tool.name as string))
      );
    });
    return members.length
      ? [fromOpenAIToolSearchOutputToolPayload({ ...tool, tools: members })]
      : [];
  });
  return { ...common, type: 'tool_search_output', tools };
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
  deferred = false,
  hostedWebSearch?: HostedWebSearch,
): CodexAppServerOptions | undefined {
  const thread = options.threadOptions;
  const configOverrides = [...(options.codexOptions?.configOverrides ?? [])];
  if (deferred) {
    // Nested code-mode search does not emit the discovery items the Runner
    // needs to authorize deferred SDK calls.
    configOverrides.push('features.code_mode=false');
  }
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
      'features.shell_tool=false',
      'features.view_image=false',
      'features.plugins=false',
      'features.multi_agent=false',
      'features.multi_agent_v2=false',
      'features.hooks=false',
      'features.code_mode=false',
      'notify=[]',
      'web_search="disabled"',
    );
  }
  if (hostedWebSearch) {
    if (webSearch === 'disabled') {
      throw new UserError(
        'CodexProvider cannot expose hosted web search when threadOptions disable web search.',
      );
    }
    configOverrides.push(
      'features.standalone_web_search=false',
      `web_search=${JSON.stringify(hostedWebSearch.mode)}`,
    );
    for (const [key, value] of Object.entries({
      context_size: hostedWebSearch.contextSize,
      allowed_domains: hostedWebSearch.allowedDomains,
      location: hostedWebSearch.location,
    })) {
      if (value !== undefined) {
        if (key === 'location') {
          for (const [field, setting] of Object.entries(
            value as Record<string, unknown>,
          )) {
            if (setting != null)
              configOverrides.push(
                `tools.web_search.location.${field}=${JSON.stringify(setting)}`,
              );
          }
        } else
          configOverrides.push(
            `tools.web_search.${key}=${JSON.stringify(value)}`,
          );
      }
    }
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
