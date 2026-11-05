import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Runner,
  tool,
  MaxTurnsExceededError,
} from '@openai/agents/classic';
import {
  assistantMessage,
  functionCall,
  modelResponse,
  ScriptedModel,
} from '@openai/agents/classic/testing';
import { askOrderAgent, createOrderAgent } from '../../examples/live/agent';

const runner = () => new Runner({ tracingDisabled: true });

describe('Live order specialist', () => {
  it('uses the real Agent and starts a fresh history for each self-contained request', async () => {
    const model = new ScriptedModel([
      modelResponse([
        functionCall(
          'lookup_order',
          { order_id: 'A0042' },
          { callId: 'lookup-first' },
        ),
      ]),
      modelResponse([assistantMessage('A0042 has shipped.')]),
      modelResponse([assistantMessage('Please provide the new order ID.')]),
    ]);
    const agent = createOrderAgent(model);
    const signal = new AbortController().signal;
    expect(
      await askOrderAgent(agent, 'Check order A0042.', signal, runner()),
    ).toBe('A0042 has shipped.');
    expect(
      await askOrderAgent(agent, 'Check a different order.', signal, runner()),
    ).toBe('Please provide the new order ID.');
    expect(model.calls[2]!.request.input).toHaveLength(1);
    expect(JSON.stringify(model.calls[2]!.request.input)).not.toContain(
      'A0042',
    );
    expect(JSON.stringify(model.calls[1]!.request.input)).toContain(
      'September 15',
    );
  });

  it('stops at the historical five-model-turn limit', async () => {
    const model = new ScriptedModel(
      Array.from({ length: 6 }, (_, index) =>
        modelResponse([
          functionCall(
            'lookup_order',
            { order_id: 'A0042' },
            { callId: `call-${index}` },
          ),
        ]),
      ),
    );
    await expect(
      askOrderAgent(
        createOrderAgent(model),
        'Check the order.',
        new AbortController().signal,
        runner(),
      ),
    ).rejects.toBeInstanceOf(MaxTurnsExceededError);
    expect(model.calls).toHaveLength(5);
  });

  it('does not settle cancellation before an already entered tool has settled', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let callbackSettled = false;
    const lookup = tool({
      name: 'lookup_order',
      description: 'Read the test order.',
      parameters: z.strictObject({ order_id: z.string() }),
      execute: async () => {
        entered.resolve();
        await release.promise;
        callbackSettled = true;
        return 'A0042 has shipped.';
      },
    });
    const model = new ScriptedModel([
      modelResponse([
        functionCall(
          'lookup_order',
          { order_id: 'A0042' },
          { callId: 'held-call' },
        ),
      ]),
    ]);
    const agent = new Agent({
      name: 'Held specialist',
      model,
      tools: [lookup],
    });
    const controller = new AbortController();
    let settled = false;
    const result = askOrderAgent(
      agent,
      'Check A0042.',
      controller.signal,
      runner(),
    ).then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await entered.promise;
    controller.abort(new Error('Browser disconnected.'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(callbackSettled).toBe(false);
    release.resolve();
    expect(await result).toBeInstanceOf(Error);
    expect(callbackSettled).toBe(true);
    expect(model.calls).toHaveLength(1);
  });

  it('returns an explicit approval refusal without executing the gated tool', async () => {
    const execute = vi.fn(async () => 'changed');
    const gated = tool({
      name: 'change_order',
      description: 'An approval-requiring test tool.',
      parameters: z.strictObject({}),
      needsApproval: true,
      execute,
    });
    const model = new ScriptedModel([
      modelResponse([
        functionCall('change_order', {}, { callId: 'gated-call' }),
      ]),
    ]);
    const agent = new Agent({
      name: 'Gated specialist',
      model,
      tools: [gated],
    });
    expect(
      await askOrderAgent(
        agent,
        'Change the order.',
        new AbortController().signal,
        runner(),
      ),
    ).toBe(
      'The specialist requires approval. This demo does not execute approved actions.',
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
