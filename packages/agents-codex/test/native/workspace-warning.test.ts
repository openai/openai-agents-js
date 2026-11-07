import { nativeEventBatch } from '../fixtures/native-event-batches';
import { afterEach, expect, expectTypeOf, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Agent,
  Environment,
  NativeProvider,
  type Observation,
} from '../../src';
import { Session } from '../../src/runtime/session';
import { captureTools } from '../../src/runtime/tools';
import type { Engine, NativeThread } from '../../src/runtime/binding';
import { ObservationBuffer } from '../../src/runtime/observation';
import { ModelServer, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

async function bounded<T>(
  pending: Promise<T>,
  milliseconds = 2_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Witness timed out')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// A reader/admission double, never evidence of native diagnostic production.
function reader() {
  const pending: string[] = [];
  let changed = Promise.withResolvers<void>();
  let closed = false;
  let reads = 0;
  const barriers = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  const accepted = Promise.withResolvers<string>();
  const native = {
    id: 'session',
    _next_session_events: vi.fn(async () => {
      ++reads;
      barriers.get(reads)?.resolve();
      while (!pending.length) {
        if (closed) throw new Error('Reader closed');
        await changed.promise;
      }
      return nativeEventBatch([pending.shift()!]);
    }),
    _submit: vi.fn(() => accepted.promise),
    _finish_child_event_reader: vi.fn(),
    _stop_sampling_for_close: vi.fn(),
    _close_report: vi.fn(async () => {
      closed = true;
      changed.resolve();
      return null;
    }),
  };
  const session = new Session(
    { _close_report: async () => null } as unknown as Engine,
    native as unknown as NativeThread,
    captureTools([]),
    {},
    {},
  );
  function emit(msg: Record<string, unknown>, tags = {}) {
    pending.push(JSON.stringify({ id: '', msg, ...tags }));
    changed.resolve();
    changed = Promise.withResolvers<void>();
  }
  return {
    session,
    native,
    accepted,
    emit,
    async consumed(count: number) {
      if (reads > count) return;
      const barrier = Promise.withResolvers<void>();
      barriers.set(count + 1, barrier);
      await bounded(barrier.promise);
    },
  };
}

it('retains opening warnings for independent readers without Turn ownership', async () => {
  const f = reader();
  f.emit({ type: 'warning', message: 'missing description' });
  await f.session._start();
  const first = f.session.events();
  const second = f.session.events();
  try {
    await f.consumed(1);
    const a = (await bounded(first.next())).value;
    expect(a).toEqual({
      type: 'warning',
      message: 'missing description',
      sessionId: 'session',
      sequence: 1,
    });
    expect((await bounded(second.next())).value).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(a).not.toHaveProperty('turnId');
    expect(a).not.toHaveProperty('submissionId');
    expect(f.native._submit).not.toHaveBeenCalled();
    await first.return?.();
    f.emit({ type: 'warning', message: 'still observing' });
    expect((await bounded(second.next())).value).toMatchObject({
      type: 'warning',
      message: 'still observing',
      sequence: 2,
    });
  } finally {
    await first.return?.();
    await second.return?.();
    await f.session.close();
  }
});

it('keeps repeated root notifications and excludes complete or partial child tags', async () => {
  const f = reader();
  const tags = [
    { subagent_id: 'child', subagent_incarnation: 'incarnation' },
    { subagent_id: 'child' },
    { subagent_id: 'child', subagent_instance_id: '1' },
    { subagent_incarnation: 'incarnation', subagent_instance_id: '1' },
    {
      subagent_id: 'child',
      subagent_incarnation: 'incarnation',
      subagent_instance_id: '1',
    },
    { subagent_incarnation: 'incarnation' },
    { subagent_instance_id: '1' },
    { subagent_id: '' },
    { subagent_incarnation: '' },
  ];
  for (const tag of tags)
    f.emit({ type: 'warning', message: 'child warning' }, tag);
  f.emit({ type: 'warning', message: 'repeated' });
  f.emit({ type: 'warning', message: 'repeated' });
  await f.session._start();
  const cursor = f.session.events();
  try {
    await f.consumed(tags.length + 2);
    expect((await bounded(cursor.next())).value).toMatchObject({
      type: 'warning',
      message: 'repeated',
      sequence: 1,
    });
    expect((await bounded(cursor.next())).value).toMatchObject({
      type: 'warning',
      message: 'repeated',
      sequence: 2,
    });
  } finally {
    await cursor.return?.();
    await f.session.close();
  }
});

it('publishes once while submission acknowledgment is held', async () => {
  const f = reader();
  await f.session._start();
  const cursor = f.session.events();
  const submitted = f.session.submit('go');
  try {
    await vi.waitFor(() => expect(f.native._submit).toHaveBeenCalledOnce(), {
      timeout: 1_000,
    });
    f.emit({ type: 'warning', message: 'during admission' });
    expect((await bounded(cursor.next())).value).toMatchObject({
      type: 'warning',
      sequence: 1,
    });
    f.accepted.resolve(JSON.stringify({ status: 'started', turn_id: 'turn' }));
    const turn = await bounded(submitted);
    f.emit(
      { type: 'task_complete', last_agent_message: 'done' },
      { id: 'turn' },
    );
    expect((await bounded(turn.wait())).finalOutput).toBe('done');
    await f.session.close();
    const events = await Array.fromAsync(f.session.events());
    expect(events.filter((event) => event.type === 'warning')).toHaveLength(1);
    expect(
      events.find((event) => event.type === 'turn_started')?.sequence,
    ).toBe(2);
  } finally {
    f.accepted.resolve(JSON.stringify({ status: 'started', turn_id: 'turn' }));
    await cursor.return?.();
    await f.session.close();
    await bounded(submitted.catch(() => {}));
  }
});

it('joins close, wakes an idle observer and drops notifications after close starts', async () => {
  const f = reader();
  await f.session._start();
  const cursor = f.session.events();
  try {
    const waiting = cursor.next();
    const closing = f.session.close();
    f.emit({ type: 'warning', message: 'too late' });
    await bounded(closing);
    expect((await bounded(waiting)).value).toMatchObject({
      type: 'session_ended',
    });
    expect((await bounded(cursor.next())).done).toBe(true);
  } finally {
    await cursor.return?.();
    await f.session.close();
  }
});

it('uses existing count, character and oversized-record gap boundaries', async () => {
  const buffer = new ObservationBuffer('session');
  for (let i = 0; i < 257; ++i)
    buffer.append({ type: 'warning', message: String(i) });
  const cursor = buffer.events();
  expect((await cursor.next()).value).toMatchObject({
    type: 'gap',
    firstSequence: 1,
  });
  expect((await cursor.next()).value).toMatchObject({
    type: 'warning',
    message: '1',
    sequence: 2,
  });
  await cursor.return?.();
  buffer.append({ type: 'warning', message: 'x'.repeat(65_537) });
  buffer.finish('closed');
  const after = buffer.events({ after: 257 });
  expect((await after.next()).value).toMatchObject({
    type: 'gap',
    firstSequence: 258,
  });
  expect((await after.next()).value).toMatchObject({ type: 'session_ended' });
  await after.return?.();

  const characters = new ObservationBuffer('session');
  characters.append({ type: 'warning', message: 'a'.repeat(40_000) });
  characters.append({ type: 'warning', message: 'b'.repeat(40_000) });
  characters.finish('closed');
  const suffix = await Array.fromAsync(characters.events());
  expect(suffix.map((event) => event.type)).toEqual([
    'gap',
    'warning',
    'session_ended',
  ]);
  expect(suffix[1]).toMatchObject({ sequence: 2, message: 'b'.repeat(40_000) });
});

it('keeps warning identity local instead of linking it as a repair submission', async () => {
  const parent = new ObservationBuffer('parent');
  const correction = new ObservationBuffer('correction');
  correction.linkRepairParent(parent, 'original');
  correction.append({ type: 'warning', message: 'local diagnostic' });
  correction.finish('closed');
  parent.finish('closed');
  expect(
    (await Array.fromAsync(parent.events())).map((event) => event.type),
  ).toEqual(['session_ended']);
  expect((await Array.fromAsync(correction.events()))[0]).toEqual({
    type: 'warning',
    message: 'local diagnostic',
    sessionId: 'correction',
    sequence: 1,
  });
  type Warning = Extract<Observation, { type: 'warning' }>;
  expectTypeOf<keyof Warning>().toEqualTypeOf<
    'type' | 'message' | 'sessionId' | 'sequence'
  >();
  expectTypeOf<Pick<Warning, 'message'>>().toEqualTypeOf<
    Readonly<{ message: string }>
  >();
});

it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'observes a real selected skill warning during the first Turn and discovers its valid sibling',
  async () => {
    const executor = await startPublicExecutor();
    try {
      const root = join(executor.cwd, 'selected');
      const valid = join(root, 'skills', 'valid-sibling');
      const broken = join(root, 'skills', 'missing-description-skill');
      await Promise.all([
        mkdir(valid, { recursive: true }),
        mkdir(broken, { recursive: true }),
      ]);
      await writeFile(
        join(valid, 'SKILL.md'),
        '---\nname: valid-sibling\ndescription: SELECTED_SIBLING_AMBER\n---\nUse only configured tools.\n',
      );
      await writeFile(
        join(broken, 'SKILL.md'),
        '---\nname: missing-description-skill\n---\nEXCLUDED_MALFORMED_BODY\n',
      );
      const server = new ModelServer([[message('done')]]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-workspace-warning',
        supportsWebsockets: false,
      });
      await using session = await new Agent({
        instructions: 'Inspect selected skill metadata.',
        provider,
        model: 'gpt-5',
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: [],
          capabilityDirectories: [root],
        }),
      });
      const cursor = session.events();
      const diagnostic = (async () => {
        for await (const event of cursor) {
          if (
            event.type === 'warning' &&
            event.message.includes('missing-description-skill')
          )
            return event;
        }
        return undefined;
      })();
      try {
        // Discovery belongs to the first submitted Turn, not Session opening.
        expect(server.requests).toHaveLength(0);
        const turn = await session.submit('Catalog');
        const turnEvents = Array.fromAsync(turn.events());
        const warning = await bounded(diagnostic, 5_000);
        expect(warning).toMatchObject({
          type: 'warning',
          sessionId: session.id,
        });
        expect(warning).not.toHaveProperty('turnId');
        expect(warning).not.toHaveProperty('submissionId');
        expect((await bounded(turn.wait(), 15_000)).finalOutput).toBe('done');
        expect(
          (await bounded(turnEvents, 5_000)).map((event) => event.type),
        ).not.toContain('warning');
        const request = JSON.stringify(server.requests[0]);
        expect(request).toContain('SELECTED_SIBLING_AMBER');
        expect(request).not.toContain('EXCLUDED_MALFORMED_BODY');
        expect(
          executor.requests.filter(
            (request) => request.method === 'process/start',
          ),
        ).toHaveLength(0);
        server.assertExhausted();
      } finally {
        await cursor.return?.();
        await diagnostic;
      }
    } finally {
      await executor.close();
    }
  },
  30_000,
);
