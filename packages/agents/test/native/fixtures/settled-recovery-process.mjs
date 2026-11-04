/* global AbortSignal, clearTimeout, console, fetch, process, setTimeout */
import assert from 'node:assert/strict';
import { appendFile, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Public ESM intentionally requires the root TS build. No tsx/source fallback.
const config = JSON.parse(process.argv[2]);
const deadline = setTimeout(() => {
  console.error('Settled recovery child exceeded 35 seconds');
  process.exit(124);
}, 35_000);
const path = (name) => join(config.directory, name);
const read = async (name) => JSON.parse(await readFile(path(name), 'utf8'));
async function durable(name, value) {
  const file = await open(path(name), 'wx', 0o444);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(config.directory, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function lookup(binding) {
  return fetch(`${config.effectUrl}/lookup`, {
    method: 'POST',
    body: JSON.stringify(binding),
    signal: AbortSignal.timeout(5_000),
  });
}
async function nextAction(events, manual) {
  for (;;) {
    const event = await events.next();
    if (event.done) throw new Error('Manual effect was not requested');
    const request = manual.match(event.value);
    if (request) return request;
  }
}
async function main() {
  if (config.mode === 'unknown') {
    const original = await read('original.json');
    const response = await lookup(original.binding);
    assert.equal(response.status, 503);
    // This application gate precedes even importing the SDK or constructing a provider.
    await durable('refused.json', {
      pid: process.pid,
      status: 'unknown',
      decision: 'refuse',
      sdkImported: false,
      dispatches: 0,
      reason: 'Authoritative lookup unavailable; automatic dispatch refused',
    });
    return;
  }

  let original;
  let decision;
  if (config.mode === 'recover') {
    original = await read('original.json');
    decision = await read('decision.json');
    assert.deepEqual(decision.binding, original.binding);
    assert.equal(decision.policy, 'reply-recorded-result');
    assert.equal(decision.selectedBy, 'parent-application');
    assert.deepEqual(decision.result, {
      orderId: 'order-42',
      status: 'fulfilled',
    });
  }
  const {
    Agent,
    NativeProvider,
    manualTool,
    tool,
    parseSessionState,
    InteractionRequired,
  } = await import('@openai/agents');
  const { z } = await import('zod');
  const effect = manualTool({
    name: 'external_effect',
    description: 'Ask the application to fulfill one order.',
    parameters: z.strictObject({ orderId: z.literal('order-42') }),
    result: z.strictObject({
      orderId: z.literal('order-42'),
      status: z.literal('fulfilled'),
    }),
  });
  const seed = tool({
    name: 'seed',
    description: 'Record that the original settled cell ran.',
    parameters: z.strictObject({}),
    execute: async () => {
      // A replay in the destination is observable even if the model later succeeds.
      await appendFile(path('seed-runs.txt'), `${process.pid}\n`);
      assert.equal(config.mode, 'prepare', 'Original cell must never rerun');
      return 'committed-seed-result';
    },
  });
  const provider = new NativeProvider({
    baseUrl: config.modelUrl,
    apiKey: 'synthetic-settled-process',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    instructions:
      'Keep stored JSON. Ask the application for the separate external effect. Never repeat effects.',
    model: 'gpt-5',
    provider,
    tools: [seed, effect],
    programmaticToolCalling: true,
  });
  let session;
  let events;
  try {
    session = await agent.session(
      original ? { state: parseSessionState(original.checkpoint) } : {},
    );
    if (config.mode === 'prepare') {
      const seedTurn = await session.submit(
        'Settle the seed cell and store its JSON.',
      );
      assert.equal((await seedTurn.wait()).finalOutput, 'seeded');
      events = session.events()[Symbol.asyncIterator]();
      const turn = await session.submit(
        'Now request the separate external effect directly.',
      );
      const outcome = turn.wait().catch((error) => error);
      const request = await nextAction(events, effect);
      assert.equal(request.call?.route, 'direct');
      assert.equal(request.callId, 'external-call');
      const staleReply = JSON.parse(
        JSON.stringify(
          request.reply({ orderId: 'order-42', status: 'fulfilled' }),
        ),
      );
      const state = await session.suspend();
      assert((await outcome) instanceof InteractionRequired);
      assert.equal(state.kind, 'manual');
      assert.deepEqual(state.root_code_mode.stored_values.value, {
        n: 7,
        a: [null, true, '雪'],
      });
      assert.equal(
        state.root_code_mode.stored_values.seed,
        'committed-seed-result',
      );
      assert.equal(state.source_session_id, session.id);
      const binding = Object.freeze({
        sourceActor: session.id,
        turnId: request.turnId,
        callId: request.callId,
        tool: request.name,
        arguments: request.arguments,
      });
      assert.equal(binding.turnId, turn.turnId);
      assert.equal(state.manual_continuation.turn_id, binding.turnId);
      assert.deepEqual(
        state.manual_continuation.pending_manual.map((call) => call.call_id),
        [binding.callId],
      );
      // Exclusive immutable application record, fsynced before any dispatch.
      await durable('original.json', {
        pid: process.pid,
        binding,
        checkpoint: JSON.stringify(state),
        staleReply,
        seedTurnId: seedTurn.turnId,
        submissionId: request.submissionId,
        request: JSON.parse(JSON.stringify(request)),
      });
      await events.return?.();
      events = undefined;
      await session.close();
      session = undefined;
      await provider.close();
      await durable('closed.json', {
        pid: process.pid,
        sourceActor: binding.sourceActor,
        closed: true,
      });
      if (config.phase === 'before') process.exit(23);
      const response = await fetch(`${config.effectUrl}/effect`, {
        method: 'POST',
        body: JSON.stringify(binding),
        signal: AbortSignal.timeout(15_000),
      });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).binding, binding);
      // No application receipt is saved in this SDK host before interruption.
      process.exit(23);
    }

    assert.equal(config.mode, 'recover');
    assert.notEqual(session.id, original.binding.sourceActor);
    events = session.events()[Symbol.asyncIterator]();
    const fresh = await nextAction(events, effect);
    assert.equal(fresh.call?.route, 'direct');
    assert.equal(fresh.sessionId, session.id);
    assert.equal(fresh.call.sessionId, session.id);
    assert.equal(fresh.turnId, original.binding.turnId);
    assert.equal(fresh.callId, original.binding.callId);
    assert.deepEqual(fresh.arguments, original.binding.arguments);
    assert.notEqual(fresh.submissionId, original.submissionId);
    assert.equal(effect.match(original.request), undefined);
    await assert.rejects(session.respond(original.staleReply));
    await session.respond(fresh.reply(decision.result));
    assert.equal((await session.wait()).finalOutput, 'recovered');
    const state = await session.saveState();
    const turns = [];
    for await (const turn of session.turns()) turns.push(turn);
    await durable('recovered.json', {
      pid: process.pid,
      physicalSession: session.id,
      binding: original.binding,
      fresh: {
        sessionId: fresh.sessionId,
        turnId: fresh.turnId,
        callId: fresh.callId,
        submissionId: fresh.submissionId,
      },
      state,
      turns,
      finalOutput: 'recovered',
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
