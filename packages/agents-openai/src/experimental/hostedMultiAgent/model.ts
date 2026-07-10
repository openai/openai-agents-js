import {
  Usage,
  UserError,
  protocol,
  type ModelRequest,
} from '@openai/agents-core';
import OpenAI from 'openai';
import { ResponsesWS } from 'openai/resources/beta/responses/ws';
import type { OpenAIClient } from '../../openaiClient';
import { HEADERS } from '../../defaults';
import {
  OpenAIResponsesModel,
  convertToOutputItem,
} from '../../openaiResponsesModel';
import {
  applyHeadersToAccumulator,
  createHeaderAccumulator,
  headerAccumulatorToRecord,
  mergeQueryParamsIntoURL,
} from '../../responsesTransportUtils';
import {
  withAbortSignal,
  withTimeout,
} from '../../responsesWebSocketConnection';
import {
  searchParamsToAuthHeaderQuery,
  toRequestUsageEntry,
} from '../../responsesUtils';
import type { HostedMultiAgentConfig } from './config';

const ROOT_AGENT_NAME = '/root';
const MULTI_AGENT_BETA = 'responses_multi_agent=v1';
const HOSTED_COLLABORATION_ITEM_TYPES = new Set([
  'agent_message',
  'multi_agent_call',
  'multi_agent_call_output',
]);
const HOSTED_TERMINAL_RESPONSE_EVENT_TYPES = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete',
  'response.error',
]);

type ResponsesWebSocketLike = Pick<ResponsesWS, 'send' | 'close' | 'socket'> &
  AsyncIterable<Record<string, any>>;

const WEBSOCKET_CONNECTING_READY_STATE = 0;
const WEBSOCKET_OPEN_READY_STATE = 1;

function isReusableWebSocket(webSocket: ResponsesWebSocketLike): boolean {
  return (
    webSocket.socket.readyState === WEBSOCKET_CONNECTING_READY_STATE ||
    webSocket.socket.readyState === WEBSOCKET_OPEN_READY_STATE
  );
}

type ActiveHostedResponse = {
  responseId?: string;
  responseTemplate?: Record<string, any>;
  responseCreateInput: Array<Record<string, any>>;
  responseCreatePreviousResponseId?: string;
  responseStored: boolean;
  pendingCallIds: Set<string>;
  emittedCallIds: Set<string>;
  queuedFunctionCalls: Array<Record<string, any>>;
  terminalEvent?: Record<string, any>;
  pendingContinuationFrame?: Record<string, any>;
  fallbackInput: Array<Record<string, any>>;
  requestUsages: Array<OpenAI.Responses.ResponseUsage | undefined>;
};

type WebSocketRequestTimeoutDeadline = {
  configuredTimeoutMs: number;
  deadlineAtMs: number;
};

function isHostedTerminalResponseEventType(eventType: unknown): boolean {
  return (
    typeof eventType === 'string' &&
    HOSTED_TERMINAL_RESPONSE_EVENT_TYPES.has(eventType)
  );
}

type HostedWebSocketTransportOptions = {
  extraHeaders?: Record<string, unknown>;
  extraQuery?: Record<string, unknown>;
};

type HostedWebSocketCreationOptions = {
  client: OpenAI;
  headers: Record<string, string>;
};

type OpenAIClientInternals = OpenAI & {
  _options?: {
    defaultHeaders?: unknown;
    timeout?: unknown;
  };
  authHeaders?: (options: Record<string, unknown>) => Promise<unknown>;
  _callApiKey?: () => Promise<boolean>;
};

function createWebSocketClient(
  client: OpenAI,
  extraQuery: Record<string, unknown> | undefined,
): OpenAI {
  const websocketClient = Object.create(client) as OpenAI;
  // ResponsesWS adds client.apiKey after applying the finalized header merge.
  // Keep authentication entirely in the explicit headers so null unsets survive.
  websocketClient.apiKey = null;
  websocketClient.buildURL = (path, query, defaultBaseURL) => {
    const url = new URL(client.buildURL(path, query, defaultBaseURL));
    mergeQueryParamsIntoURL(url, extraQuery);
    return url.toString();
  };
  return websocketClient;
}

function mergeResponseUsages(
  usages: Array<OpenAI.Responses.ResponseUsage | undefined>,
): Usage {
  return new Usage({
    requests: usages.length,
    inputTokens: usages.reduce(
      (total, usage) => total + (usage?.input_tokens ?? 0),
      0,
    ),
    outputTokens: usages.reduce(
      (total, usage) => total + (usage?.output_tokens ?? 0),
      0,
    ),
    totalTokens: usages.reduce(
      (total, usage) => total + (usage?.total_tokens ?? 0),
      0,
    ),
    inputTokensDetails: usages.map((usage) => ({
      ...usage?.input_tokens_details,
    })),
    outputTokensDetails: usages.map((usage) => ({
      ...usage?.output_tokens_details,
    })),
    requestUsageEntries: usages.map((usage) =>
      toRequestUsageEntry(usage, 'responses.create'),
    ),
  });
}

function sortedEntries(
  record: Record<string, string>,
): Array<[string, string]> {
  return Object.entries(record).sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function getTransportOverridesKey(
  client: OpenAI,
  options: HostedWebSocketTransportOptions,
): string {
  const websocketClient = createWebSocketClient(client, options.extraQuery);
  const url = websocketClient.buildURL('/responses', {}, undefined);
  const headerAccumulator = createHeaderAccumulator();
  applyHeadersToAccumulator(headerAccumulator, options.extraHeaders, {
    allowBlockedOverride: true,
  });
  return JSON.stringify([
    url,
    sortedEntries(headerAccumulatorToRecord(headerAccumulator)),
    [...headerAccumulator.blockedLowercaseNames].sort(),
  ]);
}

function validateConfig(
  config: HostedMultiAgentConfig | undefined,
): HostedMultiAgentConfig {
  const maxConcurrentSubagents = config?.maxConcurrentSubagents;
  if (
    typeof maxConcurrentSubagents !== 'undefined' &&
    (!Number.isInteger(maxConcurrentSubagents) || maxConcurrentSubagents <= 0)
  ) {
    throw new UserError(
      'HostedMultiAgentConfig.maxConcurrentSubagents must be a positive integer.',
    );
  }

  return Object.freeze(
    typeof maxConcurrentSubagents === 'undefined'
      ? {}
      : { maxConcurrentSubagents },
  );
}

function isRootFinalMessage(item: Record<string, any>): boolean {
  return (
    item.type === 'message' &&
    item.agent?.agent_name === ROOT_AGENT_NAME &&
    item.phase === 'final_answer'
  );
}

function toResponseCreateFrame(
  requestData: Record<string, any>,
): Record<string, any> {
  const { betas: _betas, stream: _stream, ...frame } = requestData;
  return { ...frame, type: 'response.create' };
}

function getFunctionCallOutputs(
  requestData: Record<string, any>,
  pendingCallIds: Set<string>,
): Array<Record<string, any>> {
  if (!Array.isArray(requestData.input)) {
    return [];
  }
  return requestData.input.filter(
    (item: unknown): item is Record<string, any> =>
      Boolean(
        item &&
        typeof item === 'object' &&
        (item as Record<string, any>).type === 'function_call_output' &&
        typeof (item as Record<string, any>).call_id === 'string' &&
        pendingCallIds.has((item as Record<string, any>).call_id),
      ),
  );
}

/**
 * Experimental OpenAI Responses model that opts into service-hosted Multi-agent orchestration.
 *
 * The hosted beta requires a persistent Responses WebSocket because local tool outputs must be
 * injected into the active response. Call {@link close} when the model is no longer needed.
 */
export class OpenAIHostedMultiAgentModel extends OpenAIResponsesModel {
  public readonly config: HostedMultiAgentConfig;
  #webSocket?: ResponsesWebSocketLike;
  #webSocketIterator?: AsyncIterator<Record<string, any>>;
  #webSocketConnectionKey?: string;
  #webSocketTransportOverridesKey?: string;
  #activeResponse?: ActiveHostedResponse;
  #normalizedResponses = new WeakMap<
    OpenAI.Responses.Response,
    OpenAI.Responses.Response
  >();
  #responseUsages = new WeakMap<OpenAI.Responses.Response, Usage>();
  #syntheticBoundaryEvents = new WeakSet<Record<string, any>>();
  #requestInProgress = false;

  constructor(
    client: OpenAIClient,
    model: string,
    config?: HostedMultiAgentConfig,
  ) {
    super(client, model);
    this.config = validateConfig(config);
  }

  /** Close the persistent Responses WebSocket owned by this model. */
  async close(): Promise<void> {
    this.#activeResponse = undefined;
    this.#dropWebSocketConnection();
  }

  #dropWebSocketConnection(): void {
    this.#webSocketIterator = undefined;
    const webSocket = this.#webSocket;
    this.#webSocket = undefined;
    this.#webSocketConnectionKey = undefined;
    this.#webSocketTransportOverridesKey = undefined;
    webSocket?.close();
  }

  /** @internal */
  protected _createResponsesWebSocket(
    options: HostedWebSocketCreationOptions,
  ): ResponsesWebSocketLike {
    return new ResponsesWS(options.client, {
      headers: options.headers,
    }) as ResponsesWebSocketLike;
  }

  protected override _getResponsesCreateRequestOverrides(
    request: ModelRequest,
    requestData: Record<string, any>,
  ): Record<string, any> {
    if (request.handoffs.length > 0) {
      throw new UserError(
        'OpenAIHostedMultiAgentModel does not support SDK handoffs. Remove the Agent handoffs or use OpenAIResponsesModel.',
      );
    }

    if (requestData.reasoning?.summary != null) {
      throw new UserError(
        'OpenAIHostedMultiAgentModel does not support reasoning.summary. Remove the reasoning summary setting.',
      );
    }

    if (requestData.max_tool_calls != null) {
      throw new UserError(
        'OpenAIHostedMultiAgentModel does not support max_tool_calls. Remove that provider setting.',
      );
    }

    return {
      multi_agent: {
        enabled: true,
        ...(typeof this.config.maxConcurrentSubagents === 'number'
          ? {
              max_concurrent_subagents: this.config.maxConcurrentSubagents,
            }
          : {}),
      },
    };
  }

  protected override _convertResponseOutputItems(
    items: Array<Record<string, any>>,
  ): protocol.OutputModelItem[] {
    const stableItems = items.filter(
      (item) =>
        !HOSTED_COLLABORATION_ITEM_TYPES.has(item.type) &&
        (item.type !== 'message' || isRootFinalMessage(item)),
    );
    return convertToOutputItem(
      stableItems as Parameters<typeof convertToOutputItem>[0],
    );
  }

  protected override _getResponseForSDKOutput(
    response: OpenAI.Responses.Response,
  ): OpenAI.Responses.Response {
    return this.#normalizedResponses.get(response) ?? response;
  }

  protected override _getResponseUsage(
    response: OpenAI.Responses.Response,
  ): Usage {
    return (
      this.#responseUsages.get(response) ?? super._getResponseUsage(response)
    );
  }

  protected override _getStreamedResponseUsage(
    response: OpenAI.Responses.Response,
  ): protocol.UsageData {
    return (
      this.#responseUsages.get(response) ??
      super._getStreamedResponseUsage(response)
    );
  }

  protected override _shouldEmitOutputTextDelta(
    event: Record<string, any>,
    outputItem: Record<string, any> | undefined,
  ): boolean {
    const agentName = event.agent?.agent_name;
    return (
      Boolean(outputItem && isRootFinalMessage(outputItem)) &&
      (typeof agentName === 'undefined' || agentName === ROOT_AGENT_NAME)
    );
  }

  protected override _shouldEmitRawModelEvent(
    event: Record<string, any>,
  ): boolean {
    return !this.#syntheticBoundaryEvents.has(event);
  }

  protected override async _fetchResponse(
    request: ModelRequest,
    stream: true,
  ): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>>;
  protected override async _fetchResponse(
    request: ModelRequest,
    stream: false,
  ): Promise<OpenAI.Responses.Response>;
  protected override async _fetchResponse(
    request: ModelRequest,
    stream: boolean,
  ): Promise<
    | AsyncIterable<OpenAI.Responses.ResponseStreamEvent>
    | OpenAI.Responses.Response
  > {
    const events = this.#runWebSocketTurn(request);
    if (stream) {
      return events as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>;
    }

    let response: OpenAI.Responses.Response | undefined;
    for await (const event of events) {
      if (isHostedTerminalResponseEventType(event.type)) {
        response = event.response as OpenAI.Responses.Response;
      }
    }
    if (!response) {
      throw new Error(
        'Hosted Multi-agent WebSocket turn ended without a response boundary.',
      );
    }
    return response;
  }

  async *#runWebSocketTurn(
    request: ModelRequest,
  ): AsyncIterable<Record<string, any>> {
    if (this.#requestInProgress) {
      throw new UserError(
        'OpenAIHostedMultiAgentModel does not support concurrent requests on one model instance.',
      );
    }
    this.#requestInProgress = true;
    const hadActiveResponse = Boolean(this.#activeResponse);
    let sentWebSocketFrame = false;
    let sentWebSocketFrameType: string | undefined;
    let receivedServerMessage = false;
    let requestMayHaveReachedServer = false;
    let sentFrameWasReturnedUnsent = false;
    let reachedResponseBoundary = false;
    let threwError = false;
    const requestTimeoutDeadline =
      this.#createWebSocketRequestTimeoutDeadline();
    const sendWebSocketFrame = (
      webSocket: ResponsesWebSocketLike,
      frame: Record<string, any>,
      signal: AbortSignal | undefined,
    ): void => {
      if (signal?.aborted) {
        throw new OpenAI.APIUserAbortError();
      }
      sentWebSocketFrame = true;
      sentWebSocketFrameType = frame.type;
      if (webSocket.socket.readyState === WEBSOCKET_OPEN_READY_STATE) {
        requestMayHaveReachedServer = true;
      }
      webSocket.send(frame as any);
    };

    try {
      const builtRequest = this._buildResponsesCreateRequest(request, true);
      const requestData = builtRequest.requestData;
      const webSocket = await this.#ensureWebSocket(
        {
          extraHeaders: builtRequest.transportExtraHeaders,
          extraQuery: builtRequest.transportExtraQuery,
        },
        Boolean(this.#activeResponse),
        builtRequest.signal,
        requestTimeoutDeadline,
      );
      let pendingInjections = 0;
      const injectingCallIds = new Set<string>();

      if (this.#activeResponse) {
        const activeResponse = this.#activeResponse;
        if (activeResponse.pendingContinuationFrame) {
          sendWebSocketFrame(
            webSocket,
            activeResponse.pendingContinuationFrame,
            builtRequest.signal,
          );
        } else {
          const outputs = getFunctionCallOutputs(
            requestData,
            activeResponse.pendingCallIds,
          );
          const outputCallIds = new Set(
            outputs.map((output) => output.call_id),
          );
          const missingCallIds = Array.from(
            activeResponse.pendingCallIds,
          ).filter((callId) => !outputCallIds.has(callId));
          if (missingCallIds.length > 0) {
            throw new UserError(
              `The hosted response is waiting for local function outputs for: ${missingCallIds.join(', ')}. Resume it with the same model instance and RunState.`,
            );
          }

          if (activeResponse.terminalEvent) {
            const continuationFrame = this.#prepareTerminalContinuation(
              activeResponse,
              requestData,
              outputs,
            );
            sendWebSocketFrame(
              webSocket,
              continuationFrame,
              builtRequest.signal,
            );
          } else {
            if (outputs.length === 0 || !activeResponse.responseId) {
              throw new UserError(
                'The hosted response is waiting for local function outputs. Resume it with the same model instance and RunState.',
              );
            }
            pendingInjections = 1;
            for (const output of outputs) {
              injectingCallIds.add(output.call_id);
            }
            sendWebSocketFrame(
              webSocket,
              {
                type: 'response.inject',
                response_id: activeResponse.responseId,
                input: outputs,
              },
              builtRequest.signal,
            );
          }
        }
      } else {
        this.#activeResponse = {
          responseCreateInput: Array.isArray(requestData.input)
            ? [...requestData.input]
            : [],
          responseCreatePreviousResponseId:
            typeof requestData.previous_response_id === 'string'
              ? requestData.previous_response_id
              : undefined,
          responseStored: requestData.store !== false,
          pendingCallIds: new Set(),
          emittedCallIds: new Set(),
          queuedFunctionCalls: [],
          fallbackInput: [],
          requestUsages: [],
        };
        sendWebSocketFrame(
          webSocket,
          toResponseCreateFrame(requestData),
          builtRequest.signal,
        );
      }

      while (true) {
        const message = await this.#nextWebSocketMessage(
          builtRequest.signal,
          requestTimeoutDeadline,
        );
        if (!message) {
          throw new Error(
            'Hosted Multi-agent WebSocket closed before a response boundary.',
          );
        }
        if (message.type === 'open' || message.type === 'reconnected') {
          requestMayHaveReachedServer = true;
        }
        if (message.type === 'error') {
          throw message.error;
        }
        if (message.type === 'close') {
          const currentFrameWasReturnedUnsent =
            sentWebSocketFrame &&
            typeof sentWebSocketFrameType === 'string' &&
            Array.isArray(message.unsent) &&
            message.unsent.some((item: Record<string, any>) => {
              const unsentFrame =
                item?.type === 'message' ? item.message : item;
              return unsentFrame?.type === sentWebSocketFrameType;
            });
          if (currentFrameWasReturnedUnsent) {
            requestMayHaveReachedServer = false;
            sentFrameWasReturnedUnsent = true;
          }
          throw new Error(
            `Hosted Multi-agent WebSocket closed (${String(message.code)}): ${String(message.reason ?? '')}`,
          );
        }
        if (message.type !== 'message') {
          continue;
        }
        receivedServerMessage = true;
        requestMayHaveReachedServer = true;

        const event = message.message as Record<string, any>;
        const eventType = event.type;
        const activeResponse: ActiveHostedResponse | undefined =
          this.#activeResponse;
        if (!activeResponse) {
          throw new Error('Hosted Multi-agent response state was lost.');
        }

        if (eventType === 'response.created') {
          activeResponse.responseId = event.response?.id;
          activeResponse.responseTemplate = event.response;
          activeResponse.pendingContinuationFrame = undefined;
        } else if (eventType === 'response.output_item.done') {
          const item = event.item as Record<string, any> | undefined;
          if (item) {
            if (
              item.type === 'function_call' &&
              typeof item.call_id === 'string'
            ) {
              activeResponse.pendingCallIds.add(item.call_id);
              if (
                !activeResponse.emittedCallIds.has(item.call_id) &&
                !activeResponse.queuedFunctionCalls.some(
                  (queued) => queued.call_id === item.call_id,
                )
              ) {
                activeResponse.queuedFunctionCalls.push(item);
              }
            }
          }
        } else if (eventType === 'response.inject.created') {
          pendingInjections = Math.max(0, pendingInjections - 1);
          for (const callId of injectingCallIds) {
            activeResponse.pendingCallIds.delete(callId);
          }
        } else if (eventType === 'response.inject.failed') {
          pendingInjections = Math.max(0, pendingInjections - 1);
          if (event.error?.code !== 'response_already_completed') {
            throw new Error(
              `Hosted Multi-agent response injection failed: ${JSON.stringify(event.error)}`,
            );
          }
          if (Array.isArray(event.input)) {
            activeResponse.fallbackInput.push(...event.input);
          }
          for (const callId of injectingCallIds) {
            activeResponse.pendingCallIds.delete(callId);
          }
        } else if (isHostedTerminalResponseEventType(eventType)) {
          activeResponse.terminalEvent = event;
        } else if (eventType === 'error') {
          throw new Error(
            `Hosted Multi-agent WebSocket response failed: ${JSON.stringify(event)}`,
          );
        }

        if (!isHostedTerminalResponseEventType(eventType)) {
          yield event;
        }

        if (
          activeResponse.queuedFunctionCalls.length > 0 &&
          pendingInjections === 0
        ) {
          const functionCalls = activeResponse.queuedFunctionCalls.splice(0);
          const partialResponse = this.#buildBoundaryResponse(functionCalls);
          const boundaryEvent = {
            type: 'response.completed',
            response: partialResponse,
          };
          this.#syntheticBoundaryEvents.add(boundaryEvent);
          reachedResponseBoundary = true;
          yield boundaryEvent;
          return;
        }

        if (activeResponse.terminalEvent && pendingInjections === 0) {
          if (activeResponse.fallbackInput.length > 0) {
            const continuationFrame = this.#prepareTerminalContinuation(
              activeResponse,
              requestData,
              [],
            );
            sendWebSocketFrame(
              webSocket,
              continuationFrame,
              builtRequest.signal,
            );
            injectingCallIds.clear();
            continue;
          }

          const terminalEvent = activeResponse.terminalEvent;
          const response = terminalEvent.response as OpenAI.Responses.Response;
          const normalizedResponse = {
            ...response,
            output: (Array.isArray(response.output)
              ? response.output
              : []
            ).filter(
              (item: Record<string, any>) =>
                item.type !== 'function_call' ||
                !activeResponse.emittedCallIds.has(item.call_id),
            ),
          } as OpenAI.Responses.Response;
          this.#normalizedResponses.set(response, normalizedResponse);
          this.#responseUsages.set(
            response,
            mergeResponseUsages([
              ...activeResponse.requestUsages,
              response.usage as OpenAI.Responses.ResponseUsage | undefined,
            ]),
          );
          this.#activeResponse = undefined;
          reachedResponseBoundary = true;
          yield terminalEvent;
          return;
        }
      }
    } catch (error) {
      threwError = true;
      if (requestMayHaveReachedServer && error instanceof Error) {
        (
          error as Error & {
            unsafeToReplay?: boolean;
          }
        ).unsafeToReplay = true;
      }
      if (hadActiveResponse && sentFrameWasReturnedUnsent) {
        const transportOverridesKey = this.#webSocketTransportOverridesKey;
        this.#dropWebSocketConnection();
        this.#webSocketTransportOverridesKey = transportOverridesKey;
      } else if (
        !hadActiveResponse ||
        sentWebSocketFrame ||
        receivedServerMessage
      ) {
        await this.close();
      }
      throw error;
    } finally {
      try {
        if (!threwError && !reachedResponseBoundary) {
          await this.close();
        }
      } finally {
        this.#requestInProgress = false;
      }
    }
  }

  #buildBoundaryResponse(
    functionCalls: Array<Record<string, any>>,
  ): OpenAI.Responses.Response {
    const activeResponse = this.#activeResponse;
    if (!activeResponse?.responseTemplate || !activeResponse.responseId) {
      throw new Error(
        'Hosted Multi-agent function call arrived before response.created.',
      );
    }

    for (const functionCall of functionCalls) {
      activeResponse.emittedCallIds.add(functionCall.call_id);
    }

    const boundaryResponse = {
      ...activeResponse.responseTemplate,
      id: activeResponse.responseId,
      status: 'completed',
      output: functionCalls,
      usage: undefined,
    } as unknown as OpenAI.Responses.Response;
    this.#responseUsages.set(boundaryResponse, new Usage());
    return boundaryResponse;
  }

  #prepareTerminalContinuation(
    activeResponse: ActiveHostedResponse,
    requestData: Record<string, any>,
    functionOutputs: Array<Record<string, any>>,
  ): Record<string, any> {
    const terminalResponse = activeResponse.terminalEvent?.response as
      Record<string, any> | undefined;
    if (!terminalResponse?.id) {
      throw new Error(
        'Hosted Multi-agent could not continue after a terminal response.',
      );
    }

    const continuationInput = [
      ...activeResponse.fallbackInput,
      ...functionOutputs,
    ];
    if (continuationInput.length === 0) {
      throw new Error(
        'Hosted Multi-agent terminal response continuation requires function outputs.',
      );
    }

    activeResponse.requestUsages.push(
      terminalResponse.usage as OpenAI.Responses.ResponseUsage | undefined,
    );
    const terminalResponseStored =
      typeof terminalResponse.store === 'boolean'
        ? terminalResponse.store
        : activeResponse.responseStored;
    const fallbackFrame = toResponseCreateFrame(requestData);
    if (fallbackFrame.conversation != null) {
      fallbackFrame.input = continuationInput;
      delete fallbackFrame.previous_response_id;
    } else if (terminalResponseStored) {
      fallbackFrame.input = continuationInput;
      fallbackFrame.previous_response_id = terminalResponse.id;
    } else {
      fallbackFrame.input = [
        ...activeResponse.responseCreateInput,
        ...(Array.isArray(terminalResponse.output)
          ? terminalResponse.output
          : []),
        ...continuationInput,
      ];
      if (activeResponse.responseCreatePreviousResponseId) {
        fallbackFrame.previous_response_id =
          activeResponse.responseCreatePreviousResponseId;
      } else {
        delete fallbackFrame.previous_response_id;
      }
    }

    activeResponse.responseCreateInput = Array.isArray(fallbackFrame.input)
      ? [...fallbackFrame.input]
      : [];
    activeResponse.responseCreatePreviousResponseId =
      typeof fallbackFrame.previous_response_id === 'string'
        ? fallbackFrame.previous_response_id
        : undefined;
    activeResponse.responseStored = fallbackFrame.store !== false;
    activeResponse.responseId = undefined;
    activeResponse.responseTemplate = undefined;
    activeResponse.pendingCallIds.clear();
    activeResponse.queuedFunctionCalls = [];
    activeResponse.terminalEvent = undefined;
    activeResponse.fallbackInput = [];
    activeResponse.pendingContinuationFrame = fallbackFrame;
    return fallbackFrame;
  }

  async #ensureWebSocket(
    transportOptions: HostedWebSocketTransportOptions,
    activeResponse: boolean,
    signal: AbortSignal | undefined,
    requestTimeoutDeadline: WebSocketRequestTimeoutDeadline | undefined,
  ): Promise<ResponsesWebSocketLike> {
    if (signal?.aborted) {
      throw new OpenAI.APIUserAbortError();
    }
    const transportOverridesKey = getTransportOverridesKey(
      this._client,
      transportOptions,
    );
    if (activeResponse) {
      if (transportOverridesKey !== this.#webSocketTransportOverridesKey) {
        throw new UserError(
          'An active hosted response must be resumed with the same WebSocket transport headers and query.',
        );
      }
      if (this.#webSocket) {
        if (isReusableWebSocket(this.#webSocket)) {
          return this.#webSocket;
        }
        this.#dropWebSocketConnection();
        this.#webSocketTransportOverridesKey = transportOverridesKey;
      }
    }

    const creationOptions = await this.#prepareWebSocketCreationOptions(
      transportOptions,
      signal,
      requestTimeoutDeadline,
    );
    const connectionURL = creationOptions.client.buildURL(
      '/responses',
      {},
      undefined,
    );
    const connectionKey = JSON.stringify([
      connectionURL,
      sortedEntries(creationOptions.headers),
    ]);

    if (
      !activeResponse &&
      this.#webSocket &&
      !isReusableWebSocket(this.#webSocket)
    ) {
      await this.close();
    }

    if (this.#webSocket && this.#webSocketConnectionKey !== connectionKey) {
      await this.close();
    }

    if (!this.#webSocket) {
      this.#webSocket = this._createResponsesWebSocket(creationOptions);
      this.#webSocketIterator = this.#webSocket[Symbol.asyncIterator]();
      this.#webSocketConnectionKey = connectionKey;
    }
    this.#webSocketTransportOverridesKey = transportOverridesKey;
    return this.#webSocket;
  }

  async #prepareWebSocketCreationOptions(
    transportOptions: HostedWebSocketTransportOptions,
    signal: AbortSignal | undefined,
    requestTimeoutDeadline: WebSocketRequestTimeoutDeadline | undefined,
  ): Promise<HostedWebSocketCreationOptions> {
    const client = this._client as OpenAIClientInternals;
    if (typeof client._callApiKey === 'function') {
      await this.#awaitWebSocketRequestTimedOperation(
        client._callApiKey(),
        signal,
        requestTimeoutDeadline,
        (configuredTimeoutMs) =>
          `Hosted Multi-agent WebSocket auth header preparation timed out after ${configuredTimeoutMs}ms.`,
      );
    }
    const websocketClient = createWebSocketClient(
      client,
      transportOptions.extraQuery,
    );
    const websocketURL = new URL(
      websocketClient.buildURL('/responses', {}, undefined),
    );
    const authHeaderQuery = searchParamsToAuthHeaderQuery(
      websocketURL.searchParams,
    );
    const authHeaders =
      typeof client.authHeaders === 'function'
        ? await this.#awaitWebSocketRequestTimedOperation(
            client.authHeaders({
              method: 'get',
              path: websocketURL.pathname,
              ...(authHeaderQuery ? { query: authHeaderQuery } : {}),
            }),
            signal,
            requestTimeoutDeadline,
            (configuredTimeoutMs) =>
              `Hosted Multi-agent WebSocket auth header preparation timed out after ${configuredTimeoutMs}ms.`,
          )
        : undefined;

    const headerAccumulator = createHeaderAccumulator();
    applyHeadersToAccumulator(headerAccumulator, authHeaders);
    if (
      typeof client.authHeaders !== 'function' &&
      typeof client.apiKey === 'string' &&
      client.apiKey.length > 0 &&
      client.apiKey !== 'Missing Key'
    ) {
      applyHeadersToAccumulator(headerAccumulator, {
        Authorization: `Bearer ${client.apiKey}`,
      });
    }
    if (client.organization) {
      applyHeadersToAccumulator(headerAccumulator, {
        'OpenAI-Organization': client.organization,
      });
    }
    if (client.project) {
      applyHeadersToAccumulator(headerAccumulator, {
        'OpenAI-Project': client.project,
      });
    }
    applyHeadersToAccumulator(
      headerAccumulator,
      client._options?.defaultHeaders,
    );
    applyHeadersToAccumulator(headerAccumulator, HEADERS);
    applyHeadersToAccumulator(
      headerAccumulator,
      transportOptions.extraHeaders,
      { allowBlockedOverride: true },
    );
    applyHeadersToAccumulator(
      headerAccumulator,
      { 'OpenAI-Beta': MULTI_AGENT_BETA },
      { allowBlockedOverride: true },
    );

    return {
      client: websocketClient,
      headers: headerAccumulatorToRecord(headerAccumulator),
    };
  }

  async #nextWebSocketMessage(
    signal: AbortSignal | undefined,
    requestTimeoutDeadline: WebSocketRequestTimeoutDeadline | undefined,
  ): Promise<Record<string, any> | undefined> {
    if (signal?.aborted) {
      throw new OpenAI.APIUserAbortError();
    }
    const iterator = this.#webSocketIterator;
    if (!iterator) {
      throw new Error('Hosted Multi-agent WebSocket iterator is unavailable.');
    }
    const frameReadTimeout = this.#resolveWebSocketRequestTimeout(
      requestTimeoutDeadline,
      (configuredTimeoutMs) =>
        `Hosted Multi-agent WebSocket frame read timed out after ${configuredTimeoutMs}ms.`,
    );
    const result = await withAbortSignal(
      withTimeout(
        iterator.next(),
        frameReadTimeout.timeoutMs,
        frameReadTimeout.errorMessage,
      ),
      signal,
    );
    return result.done ? undefined : result.value;
  }

  #getWebSocketFrameReadTimeoutMs(): number | undefined {
    const client = this._client as OpenAIClientInternals;
    const timeoutCandidate =
      typeof client.timeout === 'number'
        ? client.timeout
        : client._options?.timeout;

    if (typeof timeoutCandidate === 'number') {
      return timeoutCandidate;
    }

    return OpenAI.DEFAULT_TIMEOUT;
  }

  #createWebSocketRequestTimeoutDeadline():
    WebSocketRequestTimeoutDeadline | undefined {
    const timeoutMs = this.#getWebSocketFrameReadTimeoutMs();
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0
    ) {
      return undefined;
    }

    return {
      configuredTimeoutMs: timeoutMs,
      deadlineAtMs: Date.now() + timeoutMs,
    };
  }

  #resolveWebSocketRequestTimeout(
    requestTimeoutDeadline: WebSocketRequestTimeoutDeadline | undefined,
    errorMessageForConfiguredTimeout: (configuredTimeoutMs: number) => string,
  ): { timeoutMs: number | undefined; errorMessage: string } {
    const configuredTimeoutMs =
      requestTimeoutDeadline?.configuredTimeoutMs ??
      this.#getWebSocketFrameReadTimeoutMs();
    const safeConfiguredTimeoutMs =
      typeof configuredTimeoutMs === 'number'
        ? configuredTimeoutMs
        : OpenAI.DEFAULT_TIMEOUT;
    const errorMessage = errorMessageForConfiguredTimeout(
      safeConfiguredTimeoutMs,
    );
    if (!requestTimeoutDeadline) {
      return { timeoutMs: configuredTimeoutMs, errorMessage };
    }

    const remainingTimeoutMs = Math.ceil(
      requestTimeoutDeadline.deadlineAtMs - Date.now(),
    );
    if (remainingTimeoutMs <= 0) {
      throw new Error(errorMessage);
    }

    return { timeoutMs: remainingTimeoutMs, errorMessage };
  }

  async #awaitWebSocketRequestTimedOperation<T>(
    promise: Promise<T>,
    signal: AbortSignal | undefined,
    requestTimeoutDeadline: WebSocketRequestTimeoutDeadline | undefined,
    errorMessageForConfiguredTimeout: (configuredTimeoutMs: number) => string,
  ): Promise<T> {
    const timeout = this.#resolveWebSocketRequestTimeout(
      requestTimeoutDeadline,
      errorMessageForConfiguredTimeout,
    );
    return await withAbortSignal(
      withTimeout(promise, timeout.timeoutMs, timeout.errorMessage),
      signal,
    );
  }
}
