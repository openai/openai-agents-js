import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  MaxTurnsExceededError,
  RunContext,
  RunState,
  ToolCallError,
  ToolGuardrailFunctionOutputFactory,
  ToolInputGuardrailTripwireTriggered,
  ToolOutputGuardrailTripwireTriggered,
  Usage,
  defineToolInputGuardrail,
  defineToolOutputGuardrail,
  run,
  runToolInputGuardrails,
  runToolOutputGuardrails,
  tool,
} from '../src';
import { attachRunStateToError } from '../src/runner/errorHandlers';
import * as protocol from '../src/types/protocol';
import { ScriptedModel, modelResponse } from '../src/testing';

type GuardrailKind = 'input' | 'output';

class QueuedToolCallModel extends ScriptedModel {
  constructor(turns: number) {
    super(
      Array.from({ length: turns }, (_, index) =>
        modelResponse({
          output: [functionToolCall(index + 1)],
          usage: new Usage(),
          responseId: `response-${index + 1}`,
        }),
      ),
    );
  }
}

function functionToolCall(turn: number): protocol.FunctionCallItem {
  return {
    type: 'function_call',
    id: `function-${turn}`,
    callId: `call-${turn}`,
    name: 'guarded_tool',
    status: 'completed',
    arguments: JSON.stringify({ turn }),
  };
}

async function captureRunError(
  agent: Agent,
  streaming: boolean,
  maxTurns = 10,
): Promise<unknown> {
  try {
    if (streaming) {
      const result = await run(agent, 'go', { stream: true, maxTurns });
      await result.completed;
    } else {
      await run(agent, 'go', { maxTurns });
    }
  } catch (error) {
    return error;
  }
  throw new Error('Expected the run to fail');
}

function createGuardedAgent({
  kind,
  turns,
  tripOnSecondCall = false,
}: {
  kind: GuardrailKind;
  turns: number;
  tripOnSecondCall?: boolean;
}): Agent {
  let guardrailCalls = 0;
  const guardedTool = tool({
    name: 'guarded_tool',
    description: 'Returns the requested turn.',
    parameters: z.object({ turn: z.number() }),
    inputGuardrails:
      kind === 'input'
        ? [
            defineToolInputGuardrail({
              name: 'input_guardrail',
              run: async () => {
                guardrailCalls += 1;
                const outputInfo = `input-${guardrailCalls}`;
                return tripOnSecondCall && guardrailCalls === 2
                  ? ToolGuardrailFunctionOutputFactory.throwException(
                      outputInfo,
                    )
                  : ToolGuardrailFunctionOutputFactory.allow(outputInfo);
              },
            }),
          ]
        : undefined,
    outputGuardrails:
      kind === 'output'
        ? [
            defineToolOutputGuardrail({
              name: 'output_guardrail',
              run: async () => {
                guardrailCalls += 1;
                const outputInfo = `output-${guardrailCalls}`;
                return tripOnSecondCall && guardrailCalls === 2
                  ? ToolGuardrailFunctionOutputFactory.throwException(
                      outputInfo,
                    )
                  : ToolGuardrailFunctionOutputFactory.allow(outputInfo);
              },
            }),
          ]
        : undefined,
    execute: async ({ turn }) => `turn-${turn}`,
  });

  return new Agent({
    name: `${kind}-guardrail-agent`,
    model: new QueuedToolCallModel(turns),
    tools: [guardedTool],
    toolUseBehavior: 'run_llm_again',
  });
}

describe.each([
  { label: 'non-streaming', streaming: false },
  { label: 'streaming', streaming: true },
])('Runner tool guardrail error state ($label)', ({ streaming }) => {
  it.each<GuardrailKind>(['input', 'output'])(
    'preserves cumulative %s guardrail results when max turns is exceeded',
    async (kind) => {
      const error = await captureRunError(
        createGuardedAgent({ kind, turns: 2 }),
        streaming,
        2,
      );

      expect(error).toBeInstanceOf(MaxTurnsExceededError);
      const state = (error as MaxTurnsExceededError).state;
      expect(state).toBeDefined();
      const results =
        kind === 'input'
          ? state?._toolInputGuardrailResults
          : state?._toolOutputGuardrailResults;
      expect(results?.map((result) => result.output.outputInfo)).toEqual([
        `${kind}-1`,
        `${kind}-2`,
      ]);
    },
  );

  it.each<GuardrailKind>(['input', 'output'])(
    'attaches cumulative state to a later %s guardrail tripwire',
    async (kind) => {
      const error = await captureRunError(
        createGuardedAgent({ kind, turns: 2, tripOnSecondCall: true }),
        streaming,
      );

      expect(error).toBeInstanceOf(ToolCallError);
      const toolCallError = error as ToolCallError;
      const tripwire = toolCallError.error;
      const expectedTripwire =
        kind === 'input'
          ? ToolInputGuardrailTripwireTriggered
          : ToolOutputGuardrailTripwireTriggered;
      expect(tripwire).toBeInstanceOf(expectedTripwire);
      expect(toolCallError.state).toBeDefined();

      if (
        tripwire instanceof ToolInputGuardrailTripwireTriggered ||
        tripwire instanceof ToolOutputGuardrailTripwireTriggered
      ) {
        expect(tripwire.result.output.outputInfo).toBe(`${kind}-2`);
        expect(tripwire.state).toBe(toolCallError.state);
        const results =
          kind === 'input'
            ? tripwire.state?._toolInputGuardrailResults
            : tripwire.state?._toolOutputGuardrailResults;
        expect(results?.map((result) => result.output.outputInfo)).toEqual([
          `${kind}-1`,
          `${kind}-2`,
        ]);
        expect(results?.[1]).toBe(tripwire.result);
      }
    },
  );

  it('does not attach state to a non-AgentsError tool failure', async () => {
    const plainError = new Error('plain tool failure');
    const failingTool = tool({
      name: 'guarded_tool',
      description: 'Fails without an SDK error.',
      parameters: z.object({ turn: z.number() }),
      errorFunction: null,
      execute: async () => {
        throw plainError;
      },
    });
    const agent = new Agent({
      name: 'plain-error-agent',
      model: new QueuedToolCallModel(1),
      tools: [failingTool],
    });

    const error = await captureRunError(agent, streaming);

    expect(error).toBeInstanceOf(ToolCallError);
    expect((error as ToolCallError).error).toBe(plainError);
    expect('state' in plainError).toBe(false);
  });
});

describe('standalone tool guardrail errors', () => {
  it.each<GuardrailKind>(['input', 'output'])(
    'remains state-less for standalone %s utilities and preserves identity when Runner attaches state',
    async (kind) => {
      const agent = new Agent({ name: 'standalone-guardrail-agent' });
      const context = new RunContext();
      const outputInfo = `standalone-${kind}`;
      let caught: unknown;

      try {
        if (kind === 'input') {
          await runToolInputGuardrails({
            guardrails: [
              defineToolInputGuardrail({
                name: 'standalone_input_guardrail',
                run: async () =>
                  ToolGuardrailFunctionOutputFactory.throwException(outputInfo),
              }),
            ],
            context,
            agent,
            toolCall: functionToolCall(1),
          });
        } else {
          await runToolOutputGuardrails({
            guardrails: [
              defineToolOutputGuardrail({
                name: 'standalone_output_guardrail',
                run: async () =>
                  ToolGuardrailFunctionOutputFactory.throwException(outputInfo),
              }),
            ],
            context,
            agent,
            toolCall: functionToolCall(1),
            toolOutput: 'raw output',
          });
        }
      } catch (error) {
        caught = error;
      }

      const expectedTripwire =
        kind === 'input'
          ? ToolInputGuardrailTripwireTriggered
          : ToolOutputGuardrailTripwireTriggered;
      expect(caught).toBeInstanceOf(expectedTripwire);
      if (
        caught instanceof ToolInputGuardrailTripwireTriggered ||
        caught instanceof ToolOutputGuardrailTripwireTriggered
      ) {
        expect(caught.state).toBeUndefined();
        expect(caught.result.output.outputInfo).toBe(outputInfo);

        const state = new RunState(context, 'go', agent, 10);
        const wrapper = new ToolCallError('wrapped tripwire', caught, state);
        attachRunStateToError(wrapper, state);

        expect(wrapper.error).toBe(caught);
        expect(caught.state).toBe(state);
        expect(caught.result.output.outputInfo).toBe(outputInfo);
      }
    },
  );
});
