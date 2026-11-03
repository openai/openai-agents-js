import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Usage,
  setTracingDisabled,
  tool,
  type ModelResponse,
  type RunContext,
} from '@openai/agents-core';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponse,
} from '@openai/agents-core/testing';
import { SDKRunner, type MigrationRunResult } from '../../src/migration';

setTracingDisabled(true);

// Native suite selection is owned by OPENAI_AGENTS_NATIVE_TESTS in vitest.config.ts.
// SDKRunner owns and joins native resources; these fixtures make no external calls.
const modes = ['response', 'stream'] as const;
const input = [
  {
    role: 'user' as const,
    content: [{ type: 'input_text' as const, text: 'Record one effect.' }],
  },
];

function roundTripModel() {
  const responses: ModelResponse[] = [
    {
      responseId: 'actual-tool-response',
      requestId: 'actual-tool-request',
      output: [functionCall('record_effect', '{}', { callId: 'effect-call' })],
      usage: new Usage({ inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
    },
    {
      responseId: 'actual-final-response',
      requestId: 'actual-final-request',
      output: [assistantMessage('Done.', { id: 'actual-final-message' })],
      usage: new Usage({ inputTokens: 3, outputTokens: 1, totalTokens: 4 }),
    },
  ];
  return {
    model: new ScriptedModel(responses.map(modelResponse)),
    responses,
  };
}

function expectRoundTrip(
  model: ScriptedModel,
  responses: readonly ModelResponse[],
  result: MigrationRunResult,
  mode: (typeof modes)[number],
  output: string,
) {
  expect(result.finalOutput).toBe('Done.');
  expect(result.modelResponses).toEqual(responses);
  expect(model.calls).toHaveLength(2);
  expect(model.calls.map((call) => call.streamed)).toEqual([
    mode === 'stream',
    mode === 'stream',
  ]);
  expect(model.calls[0].request.input).toContainEqual(
    expect.objectContaining({
      role: 'user',
      content: [{ type: 'input_text', text: 'Record one effect.' }],
    }),
  );
  expect(model.calls[1].request.input).toContainEqual(
    expect.objectContaining({
      type: 'function_call_result',
      name: 'record_effect',
      callId: 'effect-call',
      status: 'completed',
      output,
    }),
  );
  model.assertComplete();
}

describe('migration instruction controls (implementation pending)', () => {
  it.each(
    modes.flatMap((modelInvocation) =>
      (['sync', 'async'] as const).map((instructionsKind) => ({
        modelInvocation,
        instructionsKind,
      })),
    ),
  )(
    'resolves $instructionsKind instructions with original identities before each $modelInvocation request',
    async ({ modelInvocation, instructionsKind }) => {
      const { model, responses } = roundTripModel();
      const context = { tenant: 'first' };
      const received: Array<{
        agent: Agent<typeof context>;
        context: RunContext<typeof context>;
        text: string;
      }> = [];
      let effects = 0;
      let toolContext: RunContext<typeof context> | undefined;
      const record = tool({
        name: 'record_effect',
        description: 'Record one effect and update trusted context.',
        parameters: z.object({}),
        execute: (_args, current?: RunContext<typeof context>) => {
          expect(current).toBeDefined();
          if (!current) throw new Error('Expected the trusted RunContext');
          toolContext = current;
          expect(current.context).toBe(context);
          effects++;
          current.context.tenant = 'second';
          return 'recorded:second';
        },
      });
      const agent = new Agent<typeof context>({
        name: 'Dynamic instructions',
        model,
        modelSettings: {},
        tools: [record],
        instructions: (actualContext, actualAgent) => {
          const text = `Tenant ${actualContext.context.tenant}`;
          received.push({ agent: actualAgent, context: actualContext, text });
          return instructionsKind === 'async' ? Promise.resolve(text) : text;
        },
      });

      const result = await SDKRunner.run(agent, input, {
        context,
        modelInvocation,
      });

      expect(effects).toBe(1);
      expect(received.map((entry) => entry.text)).toEqual([
        'Tenant first',
        'Tenant second',
      ]);
      for (const entry of received) {
        expect(entry.agent).toBe(agent);
        expect(entry.context).toBe(toolContext);
        expect(entry.context.context).toBe(context);
      }
      expect(
        model.calls.map((call) => call.request.systemInstructions),
      ).toEqual(['Tenant first', 'Tenant second']);
      expectRoundTrip(
        model,
        responses,
        result,
        modelInvocation,
        'recorded:second',
      );
    },
  );

  const resetCases = [
    { resetToolChoice: true, choice: 'required', next: undefined },
    { resetToolChoice: false, choice: 'required', next: 'required' },
    // The selected custom Model may emit a call with none; it is not revocation.
    { resetToolChoice: true, choice: 'none', next: 'none' },
    { resetToolChoice: false, choice: 'record_effect', next: 'record_effect' },
  ] as const;

  it.each(
    modes.flatMap((modelInvocation) =>
      resetCases.map((settings) => ({ modelInvocation, ...settings })),
    ),
  )(
    'preserves $choice then applies reset=$resetToolChoice after an admitted tool in $modelInvocation mode',
    async ({ modelInvocation, resetToolChoice, choice, next }) => {
      const { model, responses } = roundTripModel();
      let effects = 0;
      const record = tool({
        name: 'record_effect',
        description: 'Record one application effect.',
        parameters: z.object({}),
        execute: () => {
          effects++;
          return 'recorded';
        },
      });
      const agent = new Agent({
        name: 'Tool choice retention',
        instructions: 'Record one effect, then answer.',
        model,
        modelSettings: { toolChoice: choice },
        resetToolChoice,
        tools: [record],
      });

      const result = await SDKRunner.run(agent, input, {
        context: undefined,
        modelInvocation,
      });

      expect(effects).toBe(1);
      expect(
        model.calls.map((call) => call.request.modelSettings.toolChoice),
      ).toEqual([choice, next]);
      expectRoundTrip(model, responses, result, modelInvocation, 'recorded');
    },
  );
});

it('joins a native instruction callback after caller abort without entering the Model', async () => {
  const { model } = roundTripModel();
  const context = { tenant: 'original' };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const controller = new AbortController();
  const reason = new Error('Caller cancelled while instructions were pending');
  const guard = vi.fn(async () => ({
    tripwireTriggered: false,
    outputInfo: 'checked',
  }));
  const end = vi.fn();
  let received: RunContext<typeof context> | undefined;
  const agent = new Agent<typeof context>({
    name: 'Native instruction cancellation',
    model,
    modelSettings: {},
    instructions: async (runContext, originalAgent) => {
      expect(originalAgent).toBe(agent);
      expect(runContext.context).toBe(context);
      received = runContext;
      entered.resolve();
      await release.promise;
      return 'Late instructions';
    },
    outputGuardrails: [{ name: 'no output after abort', execute: guard }],
  });
  agent.on('agent_end', end);
  let settled = false;
  const running = SDKRunner.run(agent, 'Answer once.', {
    context,
    signal: controller.signal,
    modelInvocation: 'stream',
  });
  const outcome = running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const timer = setTimeout(() => {
    controller.abort(new Error('Instruction gate deadline'));
    release.resolve();
  }, 20_000);
  try {
    await Promise.race([
      entered.promise,
      outcome.then(() => {
        throw new Error('Run ended before instruction entry');
      }),
    ]);
    expect(received?.context).toBe(context);
    controller.abort(reason);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(model.calls).toHaveLength(0);
    expect(guard).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    release.resolve();
    await expect(running).rejects.toBe(reason);
    expect(model.calls).toHaveLength(0);
    expect(guard).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  } finally {
    clearTimeout(timer);
    controller.abort(reason);
    release.resolve();
    await outcome;
  }
}, 30_000);
