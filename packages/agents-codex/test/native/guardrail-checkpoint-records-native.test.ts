import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InteractionRequired,
  NativeProvider,
  manualTool,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  'retains named guard diagnostics across manual restore and isolates independent runs (profiles=%s legacy=%s)',
  async (profiled, legacy) => {
    const server = new ModelServer([
      [call('lookup', {}, { callId: 'checkpoint-approval' })],
      [message('resumed')],
      [message('independent')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-guard-checkpoint',
    });
    let inputCalls = 0;
    const agent = new Agent({
      instructions: 'Use lookup.',
      model: 'gpt-5',
      provider,
      handoffs: profiled
        ? [new Agent({ name: 'Unused', instructions: 'Unused.', provider })]
        : [],
      tools: [
        manualTool({
          name: 'lookup',
          description: 'Ask.',
          parameters: z.object({}),
          result: z.string(),
        }),
      ],
      inputGuardrails: [
        {
          name: 'before-approval',
          runInParallel: false,
          callback() {
            inputCalls++;
            return {
              tripwireTriggered: false,
              outputInfo: { phase: 'initial', ordinal: inputCalls },
            };
          },
        },
      ],
      outputGuardrails: [
        {
          name: 'after-approval',
          callback() {
            return {
              tripwireTriggered: false,
              outputInfo: { phase: 'completed' },
            };
          },
        },
      ],
    });
    await using original = await agent.session();
    const first = await original.submit('begin');
    const interrupted = first.wait().catch((error: unknown) => error);
    for await (const event of original.events())
      if (event.type === 'action_requested') break;
    const prior = first.guardrailResults;
    expect(prior.map((record) => record.name)).toEqual(['before-approval']);
    const checkpoint = await original.suspend();
    expect(await interrupted).toBeInstanceOf(InteractionRequired);
    await original.close();
    const unavailable = JSON.parse(JSON.stringify(checkpoint));
    unavailable.manual_context.guardrail_results[0].agent_profile =
      'missing-guard-source';
    await expect(agent.session({ state: unavailable })).rejects.toThrow(
      'Guardrail checkpoint source Agent is unavailable',
    );
    expect(server.requests).toHaveLength(1);
    const saved = JSON.parse(JSON.stringify(checkpoint));
    if (legacy) delete saved.manual_context.guardrail_results;
    await using restored = await agent.session({ state: saved });
    for await (const event of restored.events()) {
      if (event.type !== 'action_requested') continue;
      await restored.respond(event.reply('accepted'));
      break;
    }
    const completed = await restored.restoredTurn!.wait();
    expect(completed.finalOutput).toBe('resumed');
    expect.soft(inputCalls).toBe(1);
    expect
      .soft(completed.guardrailResults?.map((record) => record.name))
      .toEqual(
        legacy ? ['after-approval'] : ['before-approval', 'after-approval'],
      );
    if (!legacy)
      expect
        .soft(
          completed.guardrailResults?.find((record) => record.kind === 'input'),
        )
        .toMatchObject({
          name: 'before-approval',
          result: prior[0].result,
          sessionId: prior[0].sessionId,
          turnId: prior[0].turnId,
        });
    expect.soft(completed.guardrailResults?.[0].agent).toBe(agent);
    const resumedSnapshot = completed.guardrailResults;
    await using independent = await agent.session();
    const unrelated = await (await independent.submit('unrelated')).wait();
    expect(unrelated.finalOutput).toBe('independent');
    expect.soft(inputCalls).toBe(2);
    expect
      .soft(unrelated.guardrailResults?.map((record) => record.name))
      .toEqual(['before-approval', 'after-approval']);
    expect
      .soft(
        unrelated.guardrailResults?.find((record) => record.kind === 'input')
          ?.result.outputInfo,
      )
      .toEqual({ phase: 'initial', ordinal: 2 });
    expect
      .soft(
        unrelated.guardrailResults?.every(
          (record) => record.sessionId === independent.id,
        ),
      )
      .toBe(true);
    expect(completed.guardrailResults).toBe(resumedSnapshot);
    server.assertExhausted();
  },
  30_000,
);

it.each([
  new Date('2026-01-01T00:00:00Z'),
  new Error('local-only'),
  { nested: undefined },
])(
  'preserves live host diagnostics while omitting unsupported checkpoint payloads (%s)',
  async (info) => {
    const server = new ModelServer([
      [call('lookup', {}, { callId: 'local-diagnostics' })],
      [message('resumed')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-guard-checkpoint',
    });
    const agent = new Agent({
      instructions: 'Use lookup.',
      model: 'gpt-5',
      provider,
      tools: [
        manualTool({
          name: 'lookup',
          description: 'Ask.',
          parameters: z.object({}),
          result: z.string(),
        }),
      ],
      inputGuardrails: [
        {
          name: 'local-only',
          runInParallel: false,
          callback: () => ({ tripwireTriggered: false, outputInfo: info }),
        },
      ],
    });
    await using original = await agent.session();
    const first = await original.submit('begin');
    const interrupted = first.wait().catch((error: unknown) => error);
    for await (const event of original.events())
      if (event.type === 'action_requested') break;
    expect(first.guardrailResults[0].result.outputInfo).toBe(info);
    const saved = await original.suspend();
    expect(await interrupted).toBeInstanceOf(InteractionRequired);
    expect(first.guardrailResults[0].result.outputInfo).toBe(info);
    const json = JSON.parse(JSON.stringify(saved));
    expect(json.manual_context.guardrail_results[0].result).toEqual({
      tripwireTriggered: false,
    });
    await original.close();
    await using restored = await agent.session({ state: json });
    for await (const event of restored.events()) {
      if (event.type !== 'action_requested') continue;
      await restored.respond(event.reply('accepted'));
      break;
    }
    const completed = await restored.restoredTurn!.wait();
    expect(completed.finalOutput).toBe('resumed');
    expect(completed.guardrailResults).toHaveLength(1);
    expect(completed.guardrailResults![0].result.outputInfo).toBeUndefined();
  },
  25_000,
);
