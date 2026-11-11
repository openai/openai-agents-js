import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  isFunctionApprovalRequest,
  tool,
  type ToolCallContext,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

async function provider(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-input-recovery',
    supportsWebsockets: false,
  });
}

it('native malformed JSON recovery before callback entry', async () => {
  const malformed = {
    ...call('lookup', {}, { callId: 'bad-json' }),
    arguments: '{',
  };
  const server = new ModelServer([
    [malformed],
    [call('lookup', { key: 'valid' }, { callId: 'valid-json' })],
    [message('recovered')],
  ]);
  await using selected = await provider(server);
  let effects = 0;
  await using session = await new Agent({
    instructions: 'Use lookup.',
    model: 'gpt-5',
    provider: selected,
    tools: [
      tool({
        name: 'lookup',
        parameters: z.object({ key: z.string() }),
        execute({ key }) {
          expect(key).toBe('valid');
          effects++;
          return 'record';
        },
      }),
    ],
  }).session();
  expect((await (await session.submit('begin')).wait()).finalOutput).toBe(
    'recovered',
  );
  expect(effects).toBe(1);
  expect(JSON.stringify(server.requests[1].input)).toContain('bad-json');
  expect(JSON.stringify(server.requests[1].input)).toContain(
    'function_call_output',
  );
  server.assertExhausted();
});

it.each([false, true])(
  'original argument recovery before policy and body (approval: %s)',
  async (needsApproval) => {
    const server = new ModelServer([
      [call('lookup', { key: 7 }, { callId: 'bad-schema' })],
      ...(needsApproval
        ? [[message('recovered')]]
        : [
            [call('lookup', { key: 'valid' }, { callId: 'valid-schema' })],
            [message('recovered')],
          ]),
    ]);
    await using selected = await provider(server);
    const seen: unknown[] = [];
    let before = 0;
    let effects = 0;
    let after = 0;
    const options = {
      name: 'lookup',
      parameters: z.object({ key: z.string() }),
      needsApproval,
      inputErrorFunction(
        context: ToolCallContext<{ label: string }>,
        error: unknown,
        originalArguments: unknown,
      ) {
        expect(error).toBeInstanceOf(z.ZodError);
        expect(context.context.label).toBe('owning-run');
        expect(context.callId).toBe('bad-schema');
        expect(context).not.toHaveProperty('effectiveArguments');
        seen.push(originalArguments);
        expect(before).toBe(0);
        expect(effects).toBe(0);
        expect(after).toBe(0);
        return 'Bad lookup input';
      },
      before() {
        before++;
        return { action: 'allow' as const };
      },
      execute({ key }: { key: string }) {
        expect(key).toBe('valid');
        effects++;
        return 'record';
      },
      after(output: import('../../src').ToolOutput) {
        after++;
        return output;
      },
    };
    await using session = await new Agent<{ label: string }>({
      instructions: 'Use lookup.',
      model: 'gpt-5',
      provider: selected,
      tools: [tool(options)],
    }).session({ context: { label: 'owning-run' } });
    expect((await (await session.submit('begin')).wait()).finalOutput).toBe(
      'recovered',
    );
    expect(seen).toEqual([{ key: 7 }]);
    expect(effects).toBe(needsApproval ? 0 : 1);
    expect(before).toBe(effects);
    expect(after).toBe(effects);
    expect(JSON.stringify(server.requests[1].input)).toContain(
      'Bad lookup input',
    );
    server.assertExhausted();
  },
);

it('keeps valid transformed inputs behind the existing one-shot approval', async () => {
  const server = new ModelServer([
    [call('lookup', { key: '2026-11-11' }, { callId: 'valid-approval' })],
    [message('approved')],
  ]);
  await using selected = await provider(server);
  let effects = 0;
  let formatted = 0;
  const lookup = tool({
    name: 'lookup',
    parameters: z.object({
      key: z.string().transform((value) => new Date(value)),
    }),
    needsApproval: true,
    inputErrorFunction: () => {
      formatted++;
      return 'retry';
    },
    execute({ key }) {
      expect(key).toBeInstanceOf(Date);
      effects++;
      return key.toISOString();
    },
  });
  await using session = await new Agent({
    instructions: 'Use lookup.',
    model: 'gpt-5',
    provider: selected,
    tools: [lookup],
  }).session();
  const turn = await session.submit('begin');
  for await (const request of session.interactions()) {
    if (!isFunctionApprovalRequest(request)) continue;
    expect(effects).toBe(0);
    expect((request.arguments as { key: unknown }).key).toBeInstanceOf(Date);
    const reply = request.approve();
    await session.respond(reply);
    await expect(session.respond(reply)).rejects.toThrow();
    break;
  }
  expect((await turn.wait()).finalOutput).toBe('approved');
  expect(effects).toBe(1);
  expect(formatted).toBe(0);
  server.assertExhausted();
});
