import type { AgentOutputType } from '@openai/agents-core';
import {
  type Agent,
  type ModelResponse,
  type RunContext,
  type RunToolApprovalItem,
  RunItemStreamEvent,
  RunAgentUpdatedStreamEvent,
  RunMessageOutputItem,
  RunToolCallItem,
  RunToolCallOutputItem,
  RunHandoffCallItem,
  RunHandoffOutputItem,
} from '@openai/agents-core';
import { ReadableStream } from 'node:stream/web';
import type { AgentInputItem } from '@openai/agents-core/types';
import type { JsonValue } from '../runtime/binding';
import type { UserInput } from '../runtime/input';
import type { ToolResponse } from '../runtime/tools';
import { sdkInput } from './input';
import type { MigrationRunResult } from './index';

type FunctionCall = Extract<AgentInputItem, { type: 'function_call' }>;

/** Tool observations are appended only after output validation and a true native ACK. */
export type MigrationObservation =
  | { readonly type: 'model'; readonly response: ModelResponse }
  | {
      readonly type: 'tool';
      readonly call: FunctionCall;
      readonly value: JsonValue;
      readonly response: ToolResponse;
    };

export type MigrationItem =
  | RunMessageOutputItem
  | RunToolCallItem
  | RunToolCallOutputItem
  | RunHandoffCallItem
  | RunHandoffOutputItem;

export type MigrationSemanticEvent =
  RunItemStreamEvent | RunAgentUpdatedStreamEvent;

/** Project actual observations; never infer a message from the final output. */
export function migrationItems(
  agent: Agent<any, any>,
  observations: readonly MigrationObservation[],
): MigrationItem[] {
  const items: MigrationItem[] = [];
  const calls = new Map<string, FunctionCall>();
  const finished = new Set<string>();
  for (const observation of observations) {
    if (observation.type === 'model') {
      for (const output of observation.response.output) {
        if (
          (output.type === undefined || output.type === 'message') &&
          'role' in output &&
          output.role === 'assistant' &&
          output.status === 'completed' &&
          output.content.every((part) => part.type === 'output_text')
        )
          items.push(new RunMessageOutputItem(structuredClone(output), agent));
        else if (
          output.type === 'function_call' &&
          (output.status === undefined || output.status === 'completed')
        ) {
          if (calls.has(output.callId))
            throw new TypeError(
              'Migration result has duplicate function calls',
            );
          calls.set(output.callId, output);
          items.push(new RunToolCallItem(structuredClone(output), agent));
        } else
          throw new TypeError(
            'Migration result supports text and function items only',
          );
      }
      continue;
    }
    const call = calls.get(observation.call.callId);
    if (
      !call ||
      call.name !== observation.call.name ||
      (call.namespace ?? 'functions') !==
        (observation.call.namespace ?? 'functions') ||
      finished.has(call.callId)
    )
      throw new TypeError(
        'Migration result requires one observed call per tool reply',
      );
    const output = observation.response.contentItems
      .map((part) => {
        if (part.type !== 'inputText')
          throw new TypeError(
            'Migration result supports text tool replies only',
          );
        return part.text;
      })
      .join('\n');
    finished.add(call.callId);
    items.push(
      new RunToolCallOutputItem(
        {
          type: 'function_call_result',
          callId: call.callId,
          name: call.name,
          ...(call.namespace === undefined
            ? {}
            : { namespace: call.namespace }),
          status: 'completed',
          output,
        },
        agent,
        structuredClone(observation.value),
      ),
    );
  }
  if (finished.size !== calls.size)
    throw new TypeError('Migration result has an unpaired function call');
  return items;
}

/** Export captured effective input followed by actual current-run items. */
export function migrationHistory(
  captured: UserInput,
  items: readonly MigrationItem[],
  input: string | readonly AgentInputItem[] = sdkInput(captured),
): AgentInputItem[] {
  return structuredClone([
    ...(typeof input === 'string'
      ? [{ type: 'message' as const, role: 'user' as const, content: input }]
      : input),
    ...items.map((item) => item.rawItem),
  ]);
}

/** Buffered semantic events only; expose them after the finalizer accepts the run. */
export async function* migrationEvents(
  items: readonly MigrationItem[],
  transition?: { agent: Agent<any, any>; afterItemCount: number },
): AsyncGenerator<MigrationSemanticEvent> {
  for (let index = 0; index <= items.length; index++) {
    if (transition?.afterItemCount === index)
      yield new RunAgentUpdatedStreamEvent(transition.agent);
    if (index === items.length) break;
    const item = items[index]!;
    const name =
      item.type === 'message_output_item'
        ? 'message_output_created'
        : item.type === 'handoff_call_item'
          ? 'handoff_requested'
          : item.type === 'handoff_output_item'
            ? 'handoff_occurred'
            : item.type === 'tool_call_item'
              ? 'tool_called'
              : 'tool_output';
    yield new RunItemStreamEvent(name, item);
  }
}

/**
 * Completed consumer view, constructed only after guards and owned cleanup pass.
 * This is not a classic RunResult/RunState or a live StreamedRunResult.
 */
export function migrationResult<
  Context,
  Output extends AgentOutputType,
  Base extends Pick<
    MigrationRunResult<Context, Output>,
    'finalOutput' | 'modelResponses' | 'native'
  >,
>(
  base: Base,
  agent: Agent<Context, Output>,
  runContext: RunContext<Context>,
  captured: UserInput,
  observations: readonly MigrationObservation[],
  projection?: {
    input: string | AgentInputItem[];
    items: MigrationItem[];
    transition?: { agent: Agent<any, any>; afterItemCount: number };
  },
) {
  const items = projection?.items ?? migrationItems(agent, observations);
  const responses = [...base.modelResponses];
  const input = structuredClone(projection?.input ?? sdkInput(captured));
  return Object.freeze({
    ...base,
    input: structuredClone(input),
    newItems: items,
    // Actual raw Model data; intermediate content is not certified as final output.
    rawResponses: responses,
    get lastResponseId(): string | undefined {
      return responses.at(-1)?.responseId;
    },
    lastAgent: agent,
    runContext,
    // Current migration admission requires approval-free tools and has no paused result.
    interruptions: [] as RunToolApprovalItem[],
    get history(): AgentInputItem[] {
      return migrationHistory(captured, items, input);
    },
    get output() {
      return structuredClone(items.map((item) => item.rawItem));
    },
    /** Captured effective input and actual new items, without checkpoint state. */
    toInputList(): AgentInputItem[] {
      return migrationHistory(captured, items, input);
    },
    /** The run has already passed finalization and cleanup before this view exists. */
    completed: Promise.resolve(),
    replayEvents(): ReadableStream<MigrationSemanticEvent> {
      return ReadableStream.from(
        migrationEvents(items, projection?.transition),
      );
    },
  });
}
