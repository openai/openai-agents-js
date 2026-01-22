import type {
  RunStreamEvent,
  StreamedRunResult,
  RunMessageOutputItem,
  RunToolCallItem,
  RunToolCallOutputItem,
  RunReasoningItem,
  RunToolApprovalItem,
} from '@openai/agents';
import type { UIMessageChunk } from 'ai';
import { createUIMessageStreamResponse } from 'ai';

export type AiSdkUiMessageStreamSource =
  | StreamedRunResult<any, any>
  | ReadableStream<RunStreamEvent>
  | AsyncIterable<RunStreamEvent>
  | { toStream: () => ReadableStream<RunStreamEvent> };

export type AiSdkUiMessageStreamHeaders =
  | Headers
  | Record<string, string>
  | Array<[string, string]>;

export type AiSdkUiMessageStreamResponseOptions = {
  headers?: AiSdkUiMessageStreamHeaders;
  status?: number;
  statusText?: string;
};

type ToolInputPayload = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};

type ToolOutputPayload = {
  toolCallId: string;
  output: unknown;
};

function resolveToolName(raw: any): string {
  return typeof raw.name === 'string' ? raw.name : String(raw.type ?? 'tool');
}

function resolveToolCallId(raw: any, toolName: string): string {
  return raw.callId || raw.id || `${toolName}-${createId('call')}`;
}

function resolveEventSource(
  source: AiSdkUiMessageStreamSource,
): AsyncIterable<RunStreamEvent> {
  if (typeof (source as { toStream?: unknown }).toStream === 'function') {
    return (
      source as { toStream: () => ReadableStream<RunStreamEvent> }
    ).toStream();
  }
  return source as AsyncIterable<RunStreamEvent>;
}

let idCounter = 0;
function createId(prefix: string) {
  const randomUUID =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : undefined;
  if (randomUUID) {
    return `${prefix}-${randomUUID}`;
  }
  idCounter += 1;
  return `${prefix}-${Date.now()}-${idCounter}`;
}

function parseJsonArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function extractToolInput(item: RunToolCallItem): ToolInputPayload | null {
  const raw = item.rawItem as any;
  const toolName = resolveToolName(raw);
  const toolCallId = resolveToolCallId(raw, toolName);

  if (raw.type === 'function_call' && typeof raw.arguments === 'string') {
    return {
      toolCallId,
      toolName,
      input: parseJsonArgs(raw.arguments),
    };
  }

  if (raw.type === 'hosted_tool_call') {
    const input =
      typeof raw.arguments === 'string' ? parseJsonArgs(raw.arguments) : {};
    return { toolCallId, toolName, input };
  }

  if (raw.type === 'computer_call') {
    return { toolCallId, toolName, input: raw.action };
  }

  if (raw.type === 'shell_call') {
    return { toolCallId, toolName, input: raw.action };
  }

  if (raw.type === 'apply_patch_call') {
    return { toolCallId, toolName, input: raw.operation };
  }

  return null;
}

function extractHostedToolOutput(
  item: RunToolCallItem,
  toolCallId?: string,
): ToolOutputPayload | null {
  const raw = item.rawItem as any;
  if (raw.type !== 'hosted_tool_call') {
    return null;
  }
  if (raw.status !== 'completed' || typeof raw.output === 'undefined') {
    return null;
  }
  const toolName = resolveToolName(raw);
  const resolvedToolCallId = toolCallId ?? resolveToolCallId(raw, toolName);
  return { toolCallId: resolvedToolCallId, output: raw.output };
}

function extractToolOutput(
  item: RunToolCallOutputItem,
): ToolOutputPayload | null {
  const raw = item.rawItem as any;
  const toolCallId: string = raw.callId || raw.id;
  if (!toolCallId) {
    return null;
  }
  const output = typeof item.output !== 'undefined' ? item.output : raw.output;
  return { toolCallId, output };
}

function extractReasoningText(item: RunReasoningItem): string {
  return item.rawItem.content
    .map((entry) => (entry.type === 'input_text' ? entry.text : ''))
    .join('');
}

async function* buildUiMessageStream(
  events: AsyncIterable<RunStreamEvent>,
): AsyncIterable<UIMessageChunk> {
  let messageId: string | null = null;
  let stepOpen = false;
  let pendingStepClose = false;
  let responseHasText = false;
  let stepHasTextOutput = false;
  let textOpen = false;
  let currentTextId = '';
  const startedToolCalls = new Set<string>();
  const emittedToolOutputs = new Set<string>();

  const ensureMessageStart = function* (): Generator<
    UIMessageChunk,
    void,
    void
  > {
    if (!messageId) {
      messageId = createId('message');
      yield { type: 'start', messageId };
    }
  };

  const ensureStepStart = function* (): Generator<UIMessageChunk, void, void> {
    if (!stepOpen) {
      stepOpen = true;
      pendingStepClose = false;
      stepHasTextOutput = false;
      yield { type: 'start-step' };
    }
  };

  const finishStep = function* (): Generator<UIMessageChunk, void, void> {
    if (stepOpen) {
      stepOpen = false;
      pendingStepClose = false;
      yield { type: 'finish-step' };
    }
  };

  for await (const event of events) {
    if (event.type === 'raw_model_stream_event') {
      const data = event.data;
      if (data.type === 'response_started') {
        yield* ensureMessageStart();
        responseHasText = false;
        yield* ensureStepStart();
      }

      if (data.type === 'output_text_delta') {
        yield* ensureMessageStart();
        yield* ensureStepStart();
        responseHasText = true;
        stepHasTextOutput = true;
        if (!textOpen) {
          currentTextId = createId('text');
          textOpen = true;
          yield { type: 'text-start', id: currentTextId };
        }
        yield {
          type: 'text-delta',
          id: currentTextId,
          delta: data.delta,
        };
      }

      if (data.type === 'response_done') {
        if (textOpen) {
          textOpen = false;
          yield { type: 'text-end', id: currentTextId };
        }
        if (stepOpen) {
          if (stepHasTextOutput) {
            yield* finishStep();
          } else {
            pendingStepClose = true;
          }
        }
      }
    }

    if (event.type === 'run_item_stream_event') {
      if (event.name === 'message_output_created') {
        yield* ensureMessageStart();
        if (!responseHasText) {
          if (!stepOpen) {
            yield* ensureStepStart();
          }
          const item = event.item as RunMessageOutputItem;
          const content = item.content;
          if (content) {
            const textId = createId('text');
            yield { type: 'text-start', id: textId };
            yield { type: 'text-delta', id: textId, delta: content };
            yield { type: 'text-end', id: textId };
            stepHasTextOutput = true;
            responseHasText = true;
          }
        }
        if (pendingStepClose) {
          yield* finishStep();
        }
      }

      if (event.name === 'tool_called') {
        yield* ensureMessageStart();
        const payload = extractToolInput(event.item as RunToolCallItem);
        if (payload) {
          if (!startedToolCalls.has(payload.toolCallId)) {
            startedToolCalls.add(payload.toolCallId);
            yield {
              type: 'tool-input-start',
              toolCallId: payload.toolCallId,
              toolName: payload.toolName,
              dynamic: true,
            };
          }
          yield {
            type: 'tool-input-available',
            toolCallId: payload.toolCallId,
            toolName: payload.toolName,
            input: payload.input,
            dynamic: true,
          };
        }
        const hostedOutput = extractHostedToolOutput(
          event.item as RunToolCallItem,
          payload?.toolCallId,
        );
        if (hostedOutput && !emittedToolOutputs.has(hostedOutput.toolCallId)) {
          emittedToolOutputs.add(hostedOutput.toolCallId);
          yield {
            type: 'tool-output-available',
            toolCallId: hostedOutput.toolCallId,
            output: hostedOutput.output,
            dynamic: true,
          };
        }
      }

      if (event.name === 'tool_output') {
        yield* ensureMessageStart();
        const payload = extractToolOutput(event.item as RunToolCallOutputItem);
        if (payload && !emittedToolOutputs.has(payload.toolCallId)) {
          emittedToolOutputs.add(payload.toolCallId);
          yield {
            type: 'tool-output-available',
            toolCallId: payload.toolCallId,
            output: payload.output,
            dynamic: true,
          };
        }
      }

      if (event.name === 'tool_approval_requested') {
        yield* ensureMessageStart();
        const item = event.item as RunToolApprovalItem;
        const raw = item.rawItem as any;
        const toolCallId: string =
          raw.callId ||
          raw.id ||
          `${item.toolName ?? 'tool'}-${createId('call')}`;
        const approvalId: string = raw.id || toolCallId;
        yield {
          type: 'tool-approval-request',
          toolCallId,
          approvalId,
        };
      }

      if (event.name === 'reasoning_item_created') {
        yield* ensureMessageStart();
        const reasoningId = createId('reasoning');
        const reasoningText = extractReasoningText(
          event.item as RunReasoningItem,
        );
        if (reasoningText) {
          yield { type: 'reasoning-start', id: reasoningId };
          yield {
            type: 'reasoning-delta',
            id: reasoningId,
            delta: reasoningText,
          };
          yield { type: 'reasoning-end', id: reasoningId };
        }
      }
    }
  }

  if (textOpen) {
    yield { type: 'text-end', id: currentTextId };
  }
  if (stepOpen) {
    yield* finishStep();
  }

  yield { type: 'finish', finishReason: 'stop' };
}

/**
 * Creates a UI message stream Response compatible with the AI SDK data stream protocol.
 */
export function createAiSdkUiMessageStreamResponse(
  source: AiSdkUiMessageStreamSource,
  options: AiSdkUiMessageStreamResponseOptions = {},
): Response {
  const events = resolveEventSource(source);
  const iterator = buildUiMessageStream(events)[Symbol.asyncIterator]();
  const stream = new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel() {
      if (iterator.return) {
        await iterator.return();
      }
    },
  });

  return createUIMessageStreamResponse({
    stream,
    status: options.status,
    statusText: options.statusText,
    headers: options.headers,
  });
}
