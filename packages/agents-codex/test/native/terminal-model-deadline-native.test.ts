import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  Agent,
  NativeError,
  NativeProvider,
  fileSessionStore,
  tool,
  type SessionState,
  type SessionStore,
} from '../../src';
import { binding, type NativeThread } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
const MS = 1_000;
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
function terminalRows(state: SessionState) {
  return state.history.flatMap((row) => {
    const payload = row.payload;
    return row.type === 'event_msg' &&
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      payload.tool_completion
      ? [payload.tool_completion]
      : [];
  });
}
function storedTerminalRows(snapshot: string | null) {
  expect(snapshot).not.toBeNull();
  const document = JSON.parse(snapshot!);
  expect(document.version).toBe(1);
  return document.mutations.flatMap(
    (mutation: { operation: string; items?: Array<Record<string, any>> }) =>
      mutation.operation === 'append'
        ? (mutation.items ?? []).flatMap((row) =>
            row.type === 'event_msg' && row.payload?.tool_completion
              ? [row.payload.tool_completion]
              : [],
          )
        : [],
  );
}
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-terminal-deadline',
    supportsWebsockets: false,
  });
}
it('retains durable terminal success after the original model deadline and restore', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terminal-deadline-'));
  directories.push(directory);
  const model = new ModelServer([
    [call('finish', {}, { callId: 'terminal-first' })],
  ]);
  const effects: string[] = [];
  await using provider = await providerFor(model);
  const agent = new Agent({
    model: 'gpt-5.1-codex',
    instructions: 'Finish.',
    provider,
    tools: [
      tool({
        name: 'finish',
        parameters: z.object({}),
        finishTurn: true,
        execute: () => {
          effects.push('once');
          return 'terminal success';
        },
      }),
    ],
    modelSettings: { invocationTimeoutMs: MS },
  });
  const durable = fileSessionStore(directory);
  let committed: string | null = null;
  let flushed: string | null = null;
  let reopened: string | null = null;
  const storage: SessionStore = {
    ...durable,
    async commit(...args) {
      await durable.commit(...args);
      committed = args[4];
    },
    async flush(...args) {
      await durable.flush?.(...args);
      flushed = await durable.read(...args);
    },
    async read(...args) {
      const snapshot = await durable.read(...args);
      if (snapshot !== null) reopened = snapshot;
      return snapshot;
    },
  };
  let identity: string;
  let before: unknown[];
  {
    await using session = await agent.session({ storage });
    const turn = await session.submit('one');
    const result = await turn.wait();
    expect(result.finalOutput).toBe('terminal success');
    expect(result.toolCall).toBeDefined();
    identity = session.id;
    before = storedTerminalRows(flushed);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ final_output: 'terminal success' });
    // Actual public success and a canonical persisted value establish acceptance.
    await delay(MS + 300);
    expect(storedTerminalRows(committed)).toEqual(before);
    expect(storedTerminalRows(flushed)).toEqual(before);
    expect((await turn.wait()).finalOutput).toBe('terminal success');
  }
  reopened = null;
  await using restored = await agent.session({ storage, resume: identity! });
  expect(restored.id).toBe(identity!);
  expect(storedTerminalRows(reopened)).toEqual(before!);
  expect(effects).toEqual(['once']);
  expect(model.requests).toHaveLength(1);
});
it('never revives expiry with a late valid finishTurn value', async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const terminalRelease = Promise.withResolvers<void>();
  const effects: string[] = [];
  const capabilities = new Map<string, NativeThread>();
  const addon = await binding();
  const check = addon.NativeThread.prototype._check_python_tool;
  vi.spyOn(
    addon.NativeThread.prototype,
    '_check_python_tool',
  ).mockImplementation(function (this: NativeThread, raw) {
    capabilities.set(raw, this);
    return check.call(this, raw);
  });
  const model = new ModelServer(
    [
      [
        call('finish', {}, { callId: 'expiry-first' }),
        message('hold-terminal'),
      ],
    ],
    undefined,
    async (item) => {
      if (item.type === 'message') await terminalRelease.promise;
    },
  );
  await using provider = await providerFor(model);
  await using session = await new Agent({
    model: 'gpt-5.1-codex',
    instructions: 'Finish.',
    provider,
    tools: [
      tool({
        name: 'finish',
        parameters: z.object({}),
        finishTurn: true,
        execute: async () => {
          effects.push('once');
          entered.resolve();
          await release.promise;
          return 'must not complete';
        },
      }),
    ],
    modelSettings: { invocationTimeoutMs: MS },
  }).session();
  const turn = await session.submit('one');
  let settled = false;
  const observed = (async () => {
    const events = [];
    for await (const event of turn.events()) events.push(event);
    return events;
  })();
  const result = turn
    .wait()
    .then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    )
    .finally(() => {
      settled = true;
    });
  try {
    await entered.promise;
    expect(capabilities.size).toBeGreaterThan(0);
    await vi.waitFor(
      () => {
        for (const [raw, thread] of capabilities)
          expect(check.call(thread, raw)).toBe(false);
      },
      { timeout: 10_000 },
    );
    expect(settled).toBe(false);
  } finally {
    release.resolve();
    terminalRelease.resolve();
  }
  const outcome = await result;
  expect(outcome.error).toBeInstanceOf(NativeError);
  expect(outcome.error).toMatchObject({
    code: 'model_invocation_deadline_exceeded',
  });
  expect(
    (await observed).some(
      (event) => event.type === 'turn_finished' && event.status === 'completed',
    ),
  ).toBe(false);
  expect(terminalRows(await session.saveState())).toEqual([]);
  expect(effects).toEqual(['once']);
  expect(model.requests).toHaveLength(1);
});
