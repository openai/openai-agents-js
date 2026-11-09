import { setImmediate } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, type Session } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

async function discardedRoot(session: Session<{ value: string }>) {
  const capture = { callbackData: new Uint8Array(1024) };
  const turn = await session.submit('discard', {
    beforeStep: () => {
      expect(capture.callbackData.length).toBe(1024);
      return undefined;
    },
  });
  const result = await turn.wait();
  return [turn, result, result.finalOutput, capture].map(
    (value) => new WeakRef(value),
  );
}

it('releases discarded roots while retained handles keep their exact result after later work and close', async () => {
  // V8 exposes the collector only in a separate context; other tests keep their
  // ordinary global environment. No application or SDK object is patched.
  setFlagsFromString('--expose-gc');
  const collect = runInNewContext('gc') as () => void;
  setFlagsFromString('--no-expose-gc');
  const server = new ModelServer([
    [message('{"value":"discarded"}')],
    [message('{"value":"retained"}')],
    [message('{"value":"latest"}')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-result-retention',
    supportsWebsockets: false,
  });
  await using session = await new Agent({
    instructions: 'Return the requested JSON.',
    provider,
    outputType: z.object({ value: z.string() }),
  }).session();
  const discarded = await discardedRoot(session);
  const unrelated = new WeakRef({ unrelated: true });
  const retained = await session.submit('retain');
  const result = await retained.wait();
  const output = result.finalOutput;
  await (await session.submit('latest')).wait();
  for (let attempt = 0; attempt < 30; attempt++) {
    await setImmediate();
    collect();
    await setImmediate();
    if (discarded.every((reference) => reference.deref() === undefined)) break;
  }
  expect(unrelated.deref(), 'unrelated GC control').toBeUndefined();
  expect(discarded.map((reference) => reference.deref())).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  expect(await retained.wait()).toBe(result);
  expect(result.finalOutput).toBe(output);
  expect(output).toEqual({ value: 'retained' });
  await session.close();
  expect(await retained.wait()).toBe(result);
  expect(result.turn).toBe(retained);
  server.assertExhausted();
});
