/* global clearTimeout, console, process, setTimeout */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Agent,
  Environment,
  InteractionRequired,
  NativeProvider,
  manualTool,
  parseSessionState,
  toolRef,
} from '@openai/agents';
import { z } from 'zod';

// Public ESM requires the root SDK build and matching native product.
const config = JSON.parse(process.argv[2]);
const path = (name) => join(config.directory, name);
const read = async (name) => JSON.parse(await readFile(path(name), 'utf8'));
const write = (name, value) =>
  writeFile(path(name), JSON.stringify(value), { flag: 'wx' });
const deadline = setTimeout(() => {
  console.error('Static selection recovery child exceeded 35 seconds');
  process.exit(124);
}, 35_000);

async function main() {
  assert(['prepare', 'recover'].includes(config.mode));
  let transforms = 0;
  let nativeTransforms = 0;
  const lookup = manualTool({
    name: 'lookup',
    description: 'Return a checked record.',
    parameters: z.strictObject({ key: z.string() }),
    result: z
      .number()
      .positive()
      .transform((value) => {
        transforms++;
        return value * 10;
      }),
  });
  const environment = new Environment({
    ...config.executor,
    tools: ['exec_command', 'write_stdin', 'apply_patch'],
    transformResult(info, value) {
      nativeTransforms++;
      assert.equal(config.mode, 'prepare', 'Native effect must never replay');
      assert.equal(info.toolName, 'exec_command');
      assert.equal(info.outerCallId, 'seed-cell');
      assert(JSON.stringify(value).includes('raw-native'));
      return { output: 'checked-native-text' };
    },
  });
  const provider = new NativeProvider({
    baseUrl: config.modelUrl,
    apiKey: `synthetic-static-selection-${config.mode}`,
    supportsWebsockets: false,
  });
  const agent = new Agent({
    instructions:
      'Keep stored JSON, read both records, and return the typed answer.',
    model: 'gpt-5',
    provider,
    tools: [lookup],
    programmaticToolCalling: true,
    outputType: {
      mode: 'native',
      schema: z.strictObject({ answer: z.string() }),
    },
  });
  let session;
  let events;
  try {
    const original =
      config.mode === 'recover' ? await read('original.json') : undefined;
    session = await agent.session(
      original
        ? { environment, state: parseSessionState(original.checkpoint) }
        : { environment },
    );
    if (!original) {
      const seedTurn = await session.submit(
        'Store the seed and structured JSON.',
      );
      assert.deepEqual((await seedTurn.wait()).finalOutput, {
        answer: 'seeded',
      });
      const turn = await session.submit('Read both records directly.', {
        tools: [lookup, toolRef('exec'), toolRef('wait')],
      });
      events = session.events()[Symbol.asyncIterator]();
      const requests = [];
      while (requests.length < 2) {
        const event = await events.next();
        assert(!event.done, 'Missing original manual grants');
        const request = lookup.match(event.value);
        if (request) requests.push(request);
      }
      const a = requests.find((request) => request.callId === 'manual-A');
      const b = requests.find((request) => request.callId === 'manual-B');
      assert(a && b);
      assert.equal(a.call?.route, 'direct');
      assert.equal(b.call?.route, 'direct');
      const staleReply = JSON.parse(JSON.stringify(b.reply(2)));
      await session.respond(a.reply(1));
      assert.equal(transforms, 1);
      const outcome = turn.wait().catch((error) => error);
      const saved = await session.suspend();
      assert((await outcome) instanceof InteractionRequired);
      assert.equal(saved.format_version, 11);
      assert.deepEqual(
        saved.manual_continuation.pending_manual.map((call) => call.call_id),
        ['manual-B'],
      );
      assert.deepEqual(saved.root_code_mode.stored_values, {
        accepted: { output: 'checked-native-text' },
        structured: { n: 7, a: [null, true, '雪'] },
      });
      await write('original.json', {
        pid: process.pid,
        sessionId: session.id,
        turnId: turn.turnId,
        submissionId: b.submissionId,
        request: JSON.parse(JSON.stringify(b)),
        staleReply,
        transforms,
        nativeTransforms,
        checkpoint: JSON.stringify(saved),
      });
      return;
    }

    assert.notEqual(session.id, original.sessionId);
    events = session.events()[Symbol.asyncIterator]();
    let fresh;
    for (;;) {
      const event = await events.next();
      assert(!event.done, 'Missing restored manual grant');
      fresh = lookup.match(event.value);
      if (fresh) break;
    }
    assert.equal(fresh.call?.route, 'direct');
    assert.equal(fresh.callId, 'manual-B');
    assert.equal(fresh.turnId, original.turnId);
    assert.equal(fresh.sessionId, session.id);
    assert.notEqual(fresh.submissionId, original.submissionId);
    assert.deepEqual(fresh.arguments, { key: 'B' });
    assert.equal(lookup.match(original.request), undefined);
    await assert.rejects(session.respond(original.staleReply));
    assert.equal(transforms, 0);
    await session.respond(fresh.reply(2));
    const result = await session.wait();
    assert.deepEqual(result.finalOutput, { answer: 'done' });
    assert.equal(
      transforms,
      1,
      'Accepted sibling must not be transformed again',
    );
    assert.equal(nativeTransforms, 0, 'Native output policy must not replay');
    await write('recovered.json', {
      pid: process.pid,
      sessionId: session.id,
      fresh: {
        sessionId: fresh.sessionId,
        turnId: fresh.turnId,
        callId: fresh.callId,
        submissionId: fresh.submissionId,
      },
      transforms,
      nativeTransforms,
      finalOutput: result.finalOutput,
      state: await session.saveState(),
    });
  } finally {
    try {
      await events?.return?.();
    } finally {
      try {
        await session?.close();
      } finally {
        await provider.close();
      }
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
}
