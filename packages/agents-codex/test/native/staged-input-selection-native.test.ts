import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  manualTool,
  pendingInput,
  withPendingInput,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it.each(['omitted', 'equal-occurrences'] as const)(
  'has been retaining the omitted original in %s input through another checkpoint',
  async (kind) => {
    const marker = 'STAGED_OCCURRENCE';
    const server = new ModelServer([
      [call('decision', {}, { callId: 'first' })],
      [call('decision', {}, { callId: 'second' })],
      [message('done')],
    ]);
    const cfg = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (cfg['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'fixture',
      supportsWebsockets: false,
    });
    let filtered = false;
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Ask for a decision.',
      tools: [
        manualTool({
          name: 'decision',
          description: 'Request a decision.',
          parameters: z.object({}),
          result: z.string(),
        }),
      ],
      transformContext: ({ items }) => {
        const marked = items.filter((item) =>
          JSON.stringify(item).includes(marker),
        );
        if (filtered || marked.length === 0) return items;
        filtered = true;
        return items.filter(
          (item) =>
            !marked.includes(item) ||
            (kind === 'equal-occurrences' && item === marked.at(-1)),
        );
      },
    });
    await using initial = await agent.session();
    const turn = await initial.submit('original');
    const initialEnd = turn.wait().catch((error) => error);
    await turn.wait({ until: 'manual_tool' });
    const saved = await initial.suspend();
    await initialEnd;
    const item = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: marker }],
    };
    const staged = withPendingInput(
      saved,
      kind === 'omitted' ? [item] : [item, item],
    );
    const immutable = JSON.stringify(staged);
    await using resumed = await agent.session({
      state: staged,
      pendingInputAdmission: 'selected-before-send',
    });
    const resumedEnd = resumed.restoredTurn!.wait().catch((error) => error);
    const first = (await resumed.pendingInteractions())[0];
    if (first?.type !== 'action_requested')
      throw new Error('Missing first grant');
    await resumed.respond(first.reply('first output'));
    await resumed.restoredTurn!.wait({ until: 'manual_tool' });
    const second = await resumed.suspend();
    await resumedEnd;
    expect(JSON.stringify(staged)).toBe(immutable);
    const count = (items: readonly unknown[]) =>
      items.filter((value) => JSON.stringify(value).includes(marker)).length;
    expect(count(server.requests[1].input as unknown[])).toBe(
      kind === 'omitted' ? 0 : 1,
    );
    expect(pendingInput(second)).toEqual([item]);
    expect(count(second.history)).toBe(kind === 'omitted' ? 0 : 1);
    await using last = await agent.session({
      state: second,
      pendingInputAdmission: 'selected-before-send',
    });
    const next = (await last.pendingInteractions())[0];
    if (next?.type !== 'action_requested')
      throw new Error('Missing second grant');
    await last.respond(next.reply('second output'));
    expect((await last.restoredTurn!.wait()).finalOutput).toBe('done');
    expect(count(server.requests[2].input as unknown[])).toBe(
      kind === 'omitted' ? 1 : 2,
    );
    server.assertExhausted();
  },
  20_000,
);

it('has been refusing reconstructed pending identity before another provider request', async () => {
  const server = new ModelServer([[call('decision', {}, { callId: 'first' })]]);
  const cfg = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (cfg['model_providers.fixture'] as { base_url: string }).base_url,
    apiKey: 'fixture',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Ask for a decision.',
    tools: [
      manualTool({
        name: 'decision',
        description: 'Request a decision.',
        parameters: z.object({}),
        result: z.string(),
      }),
    ],
    transformContext: ({ items }) =>
      items.some((item) => JSON.stringify(item).includes('UNACCEPTED_SOURCE'))
        ? items.map((item) => ({ ...item }))
        : items,
  });
  await using initial = await agent.session();
  const first = await initial.submit('original');
  const firstEnd = first.wait().catch((error) => error);
  await first.wait({ until: 'manual_tool' });
  const saved = withPendingInput(await initial.suspend(), 'UNACCEPTED_SOURCE');
  await firstEnd;
  await using restored = await agent.session({
    state: saved,
    pendingInputAdmission: 'selected-before-send',
  });
  const ended = restored.restoredTurn!.wait();
  const rejected = expect(ended).rejects.toThrow(/original user objects/);
  const request = (await restored.pendingInteractions())[0];
  if (request?.type !== 'action_requested')
    throw new Error('Missing first grant');
  await restored.respond(request.reply('accepted output'));
  await rejected;
  expect(server.requests).toHaveLength(1);
  const retry = await restored.saveState();
  expect(pendingInput(retry)).toEqual(pendingInput(saved));
  server.assertExhausted();
}, 20_000);
