import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  parseSessionState,
  type SessionState,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('keeps equal prompted schemas on prepared transfer requests and restore', async () => {
  const legacy = process.env.OLD_PROMPTED_PREPARED_STATE;
  const server = new ModelServer([
    ...(legacy
      ? []
      : [
          [
            call(
              'transfer_to_destination',
              {},
              { callId: 'prompted-transfer' },
            ),
          ],
          [message('{"prompted_answer_marker":"first"}')],
        ]),
    [message('{"prompted_answer_marker":"restored"}')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-guidance',
    supportsWebsockets: false,
  });
  const outputType = {
    mode: 'prompted' as const,
    schema: z.object({ prompted_answer_marker: z.string() }),
    maxRetries: 0,
  };
  const destination = new Agent({
    name: 'destination',
    instructions: 'Answer with the required shape.',
    provider,
    model: 'gpt-5.5',
    outputType,
  });
  const source = new Agent({
    instructions: 'Use the declared destination.',
    provider,
    model: 'gpt-5.5',
    outputType,
    handoffs: [destination],
    prepareHandoffInput: (value) => ({
      ...value,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Retained summary.' }],
        },
      ],
      previous: [],
      generated: [],
    }),
  });
  const assertGuidance = (request: JsonObject) => {
    const inputs = request.input as JsonObject[];
    const guidance = inputs
      .filter((item) => item.type === 'message' && item.role === 'developer')
      .flatMap((item) => (item.content ?? []) as JsonObject[])
      .filter(
        (part) =>
          typeof part.text === 'string' &&
          part.text.includes('prompted_answer_marker'),
      );
    expect(guidance).toHaveLength(1);
    expect(guidance[0].text as string).toContain('JSON');
    expect(JSON.stringify(request.input)).not.toContain('source-private');
    expect((request.text as JsonObject | undefined)?.format).not.toMatchObject({
      type: 'json_schema',
    });
  };
  let state: SessionState;
  if (legacy) {
    const encoded = await readFile(legacy, 'utf8');
    state = parseSessionState(encoded, {
      expectedSha256: createHash('sha256').update(encoded).digest('hex'),
    });
  } else {
    await using session = await source.session();
    expect(
      (await (await session.submit('source-private')).wait()).finalOutput,
    ).toEqual({ prompted_answer_marker: 'first' });
    state = await session.saveState();
    if (process.env.PROMPTED_PREPARED_SNAPSHOT)
      await writeFile(
        process.env.PROMPTED_PREPARED_SNAPSHOT,
        JSON.stringify(state),
      );
    assertGuidance(server.requests[1]);
    expect(JSON.stringify((await session.historySnapshot()).items)).toContain(
      'source-private',
    );
  }
  await using restored = await source.session({ state });
  expect(
    (await (await restored.submit('Continue.')).wait()).finalOutput,
  ).toEqual({ prompted_answer_marker: 'restored' });
  assertGuidance(server.requests.at(-1)!);
  server.assertExhausted();
});
