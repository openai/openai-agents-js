import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InteractionRequired,
  NativeProvider,
  manualTool,
  tool,
  withPendingInput,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { captureToolNotFoundBehavior } from '../../src/runtime/session';
import { ModelServer, call, message } from './fixtures/model-server';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
const catalog = JSON.parse(
  readFileSync(
    new URL('./fixtures/history-counter-models.json', import.meta.url),
    'utf8',
  ),
) as {
  models: {
    slug: string;
    supported_in_api?: boolean;
    use_responses_lite?: boolean;
  }[];
};
const model = catalog.models.find(
  (entry) => entry.supported_in_api && !entry.use_responses_lite,
)!.slug;
afterEach(() => ModelServer.closeAll());
async function provider(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-unknown-operation',
    supportsWebsockets: false,
  });
}

it('captures only the two explicit unknown-call choices', () => {
  expect(captureToolNotFoundBehavior(undefined)).toBeUndefined();
  expect(captureToolNotFoundBehavior('raise_error')).toBe(true);
  expect(captureToolNotFoundBehavior('return_error_to_model')).toBe(false);
  for (const value of [null, true, false, '', 'strict', {}])
    expect(() => captureToolNotFoundBehavior(value as never)).toThrow(
      TypeError,
    );
});

nativeIt.each([undefined, 'return_error_to_model'] as const)(
  'keeps unknown function recovery and later roots (%s)',
  async (choice) => {
    const server = new ModelServer([
      [call('missing_function', {}, { callId: 'missing' })],
      [message('recovered')],
      [message('later valid')],
    ]);
    await using selected = await provider(server);
    await using session = await new Agent({
      model,
      instructions: 'Reply briefly.',
      provider: selected,
    }).session();
    expect(
      (
        await (
          await session.submit('begin', { toolNotFoundBehavior: choice })
        ).wait()
      ).finalOutput,
    ).toBe('recovered');
    const input = server.requests[1]!.input as JsonObject[];
    expect(
      input.some(
        (item) =>
          item.type === 'function_call_output' &&
          item.call_id === 'missing' &&
          JSON.stringify(item.output).includes('unsupported call'),
      ),
    ).toBe(true);
    expect((await (await session.submit('later')).wait()).finalOutput).toBe(
      'later valid',
    );
    expect(server.requests).toHaveLength(3);
  },
);

nativeIt.each([undefined, 'return_error_to_model'] as const)(
  'keeps strict failure local before default recovery and known execution (%s)',
  async (choice) => {
    let executions = 0;
    const known = tool({
      name: 'known_function',
      description: 'Read a known value.',
      parameters: z.object({ value: z.string() }),
      execute: ({ value }) => {
        executions += 1;
        return `known:${value}`;
      },
    });
    const server = new ModelServer([
      [call('missing_function', {}, { callId: 'strict-missing' })],
      [call('missing_function', {}, { callId: 'default-missing' })],
      [message('default recovered')],
      [call('known_function', { value: 'accepted' }, { callId: 'known' })],
      [message('known completed')],
      [message('later valid')],
    ]);
    await using selected = await provider(server);
    await using session = await new Agent({
      model,
      instructions: 'Reply briefly.',
      provider: selected,
      tools: [known],
    }).session();
    await expect(
      (
        await session.submit('strict', { toolNotFoundBehavior: 'raise_error' })
      ).wait(),
    ).rejects.toThrow('unsupported call');
    expect(server.requests).toHaveLength(1);
    expect(executions).toBe(0);
    expect(
      (
        await (
          await session.submit('default', { toolNotFoundBehavior: choice })
        ).wait()
      ).finalOutput,
    ).toBe('default recovered');
    expect(
      (server.requests[2]!.input as JsonObject[]).some(
        (item) =>
          item.type === 'function_call_output' &&
          item.call_id === 'default-missing' &&
          JSON.stringify(item.output).includes('unsupported call'),
      ),
    ).toBe(true);
    expect(
      (
        await (
          await session.submit('known', { toolNotFoundBehavior: 'raise_error' })
        ).wait()
      ).finalOutput,
    ).toBe('known completed');
    expect(executions).toBe(1);
    expect(
      (server.requests[4]!.input as JsonObject[]).some(
        (item) =>
          item.type === 'function_call_output' &&
          item.call_id === 'known' &&
          JSON.stringify(item.output).includes('known:accepted'),
      ),
    ).toBe(true);
    expect((await (await session.submit('later')).wait()).finalOutput).toBe(
      'later valid',
    );
    expect(server.requests).toHaveLength(6);
    expect(executions).toBe(1);
  },
);

nativeIt(
  'keeps unknown custom payload recovery separate from strict function calls',
  async () => {
    const custom: JsonObject = {
      type: 'custom_tool_call',
      call_id: 'custom-missing',
      name: 'missing_custom',
      input: 'data',
    };
    const server = new ModelServer([[custom], [message('custom recovered')]]);
    await using selected = await provider(server);
    await using session = await new Agent({
      model,
      instructions: 'Reply briefly.',
      provider: selected,
    }).session();
    expect(
      (
        await (
          await session.submit('custom', {
            toolNotFoundBehavior: 'raise_error',
          })
        ).wait()
      ).finalOutput,
    ).toBe('custom recovered');
    expect(server.requests).toHaveLength(2);
  },
);

nativeIt.each([false, true])(
  'retains strictness through JSON manual restore and staged input (%s)',
  async (staged) => {
    const lookup = manualTool({
      name: 'lookup',
      description: 'Read a record.',
      parameters: z.object({}),
      result: z.string(),
    });
    const server = new ModelServer([
      [call('lookup', {}, { callId: 'pending' })],
      [call('missing_function', {}, { callId: 'missing' })],
      [message('later valid')],
    ]);
    await using selected = await provider(server);
    const agent = new Agent({
      model,
      instructions: 'Use lookup.',
      provider: selected,
      tools: [lookup],
    });
    await using original = await agent.session();
    const turn = await original.submit('begin', {
      toolNotFoundBehavior: 'raise_error',
    });
    const pending = turn.wait().catch((error: unknown) => error);
    await turn.wait({ until: 'manual_tool' });
    const state = JSON.parse(JSON.stringify(await original.suspend()));
    expect(await pending).toBeInstanceOf(InteractionRequired);
    await original.close();
    await using restored = await agent.session({
      state: staged ? withPendingInput(state, 'staged strict input') : state,
    });
    const completion = restored.restoredTurn!.wait();
    const rejection = expect(completion).rejects.toThrow('unsupported call');
    for await (const event of restored.events()) {
      if (event.type !== 'action_requested') continue;
      await restored.respond(event.reply('accepted'));
      break;
    }
    await rejection;
    expect(server.requests).toHaveLength(2);
    if (staged)
      expect(JSON.stringify(server.requests[1]!.input)).toContain(
        'staged strict input',
      );
    try {
      expect((await (await restored.submit('later')).wait()).finalOutput).toBe(
        'later valid',
      );
    } catch (error) {
      throw new Error(`Later root after staged=${staged} failed`, {
        cause: error,
      });
    }
    expect(server.requests).toHaveLength(3);
  },
);
