import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { _ContextChange, NativeThread } from '../../native/index.js';
import {
  Agent,
  NativeProvider,
  localStorage,
  manualTool,
  parseSessionState,
  readSessionInstructions,
  tool,
} from '../../src';
import { binding } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-supplied-compaction',
    supportsWebsockets: false,
  });
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

type AuditCheckpoint = {
  source_session_id: string;
  history: { type?: unknown }[];
  root_goal?: unknown;
  managed_tool_specs?: unknown;
};

function expectPreservedAudit(before: AuditCheckpoint, after: AuditCheckpoint) {
  // Export records current settings and updates metadata timestamps itself.
  // The original records, compaction receipts and managed bindings stay intact.
  expect(after.source_session_id).toBe(before.source_session_id);
  expect(after.history.slice(0, before.history.length)).toEqual(before.history);
  expect(after.history.filter((record) => record.type === 'compacted')).toEqual(
    before.history.filter((record) => record.type === 'compacted'),
  );
  expect(after.managed_tool_specs).toEqual(before.managed_tool_specs);
  expect(after.root_goal).toEqual(before.root_goal);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

describe('supplied native compaction', () => {
  it.each([false, true])(
    'carries accepted instruction file receipts through supplied compaction with replacement=%s',
    async (replace) => {
      const cwd = await mkdtemp(join(tmpdir(), 'agents-compact-instructions-'));
      try {
        const path = join(await realpath(cwd), 'instructions.md');
        const openingFile = 'Instructions read when the session opened.';
        await writeFile(path, openingFile);
        const server = new ModelServer([[message('Continued answer')]]);
        await using provider = await providerFor(server);
        const agent = new Agent({
          instructions: 'Opening instructions.',
          model: 'gpt-5',
          provider,
        });
        await using session = await agent.session({ instructionFiles: [path] });
        await rm(path);
        const replacement = 'Replacement instructions.';
        if (replace) await session.update({ instructions: replacement });

        await session.compact({ summary: 'Supplied summary.' });
        expect(server.requests).toHaveLength(0);
        const turn = await session.submit('Continue');
        expect((await turn.wait()).finalOutput).toBe('Continued answer');
        const [recorded] = await collect(session.turns());
        const expected = replace
          ? replacement
          : `Opening instructions.

${openingFile}`;
        expect(JSON.stringify(server.requests[0]?.input)).toContain(
          JSON.stringify(expected).slice(1, -1),
        );
        expect(recorded?.receipt).toMatchObject({
          developerInstructionsSha256: createHash('sha256')
            .update(expected)
            .digest('hex'),
          instructionFiles: replace
            ? []
            : [
                {
                  path,
                  source: 'application_file',
                  sha256: createHash('sha256')
                    .update(openingFile)
                    .digest('hex'),
                },
              ],
        });
        server.assertExhausted();
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );

  it('keeps selected originals in order with canonical audit and receipts through JSON restore', async () => {
    const originalInput = 'Remember original audit text';
    const summary = '  Supplied context: the project code is amber.\n';
    const checkRequest = (input: unknown) => {
      const text = JSON.stringify(input);
      // Canonical developer envelopes retain superseded instruction revisions.
      // The latest application instructions must follow the original revision.
      const expected = [
        'Stale agent instructions',
        originalInput,
        '"type":"function_call"',
        'lookup receipt 1',
        summary.trim(),
      ];
      let position = -1;
      for (const original of expected) {
        const next = text.indexOf(original, position + 1);
        expect(next, original).toBeGreaterThan(position);
        position = next;
      }
      expect(text.lastIndexOf('Current instructions')).toBeGreaterThan(
        text.indexOf('Stale agent instructions'),
      );
      expect(text.split(originalInput)).toHaveLength(2);
      expect(text.split('"call_id":"lookup-before"')).toHaveLength(3);
      expect(text).not.toContain('Original answer');
      expect(text).not.toContain('changed the exposed copy');
    };
    const server = new ModelServer(
      [
        [call('lookup', {}, { callId: 'lookup-before' })],
        [message('Original answer')],
        (request) => {
          checkRequest(request.input);
          return [call('lookup', {}, { callId: 'lookup-after' })];
        },
        [message('Continued answer')],
        (request) => {
          checkRequest(request.input);
          return [call('lookup', {}, { callId: 'lookup-restored' })];
        },
        [message('Restored answer')],
      ],
      { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    );
    const provider = await providerFor(server);
    let calls = 0;
    const lookup = tool({
      name: 'lookup',
      parameters: z.object({}),
      execute: () => `lookup receipt ${++calls}`,
    });
    const agent = new Agent({
      instructions: 'Stale agent instructions',
      model: 'gpt-5',
      provider,
      tools: [lookup],
    });
    const session = await agent.session();
    try {
      const turn = await session.submit(originalInput, {
        budget: { maxRequests: 2, maxTokens: 10 },
      });
      const result = await turn.wait();
      expect(result.usage?.totalTokenUsage.totalTokens).toBe(10);
      await session.update({ instructions: 'Current instructions' });
      await session.update({ modelSettings: { reasoningEffort: 'low' } });
      const id = session.id;
      const items = await collect(session.items());
      const turns = await collect(session.turns());
      const before = await session.saveState();
      const snapshot = await session.modelContext();
      const user = snapshot.items.findIndex((item) =>
        JSON.stringify(item).includes(originalInput),
      );
      const toolCall = snapshot.items.findIndex(
        (item) =>
          item.type === 'function_call' && item.call_id === 'lookup-before',
      );
      const toolOutput = snapshot.items.findIndex(
        (item) =>
          item.type === 'function_call_output' &&
          item.call_id === 'lookup-before',
      );
      expect(user).toBeGreaterThanOrEqual(0);
      expect(toolCall).toBeGreaterThan(user);
      expect(toolOutput).toBeGreaterThan(toolCall);
      const candidate = vi.spyOn(
        (await binding())._ContextChange.prototype,
        'createCandidateEngine',
      );
      await expect(
        session.compact({ summary, snapshot, retain: [toolCall] }),
      ).rejects.toThrow(/retain both original tool call and result/i);
      expect(candidate).not.toHaveBeenCalled();
      snapshot.items[user].content = [
        { type: 'input_text', text: 'changed the exposed copy' },
      ];
      await session.compact({
        summary,
        snapshot,
        retain: [toolOutput, user, toolCall, user],
      });
      expect(server.requests).toHaveLength(2);
      expect(calls).toBe(1);
      expect(session.id).toBe(id);
      expect(await turn.wait()).toBe(result);
      expect(await session.wait()).toBe(result);
      expect(result.finalOutput).toBe('Original answer');
      expect(await collect(session.items())).toEqual(items);
      expect(await collect(session.turns())).toEqual(turns);
      const saved = parseSessionState(
        JSON.stringify(await session.saveState()),
      );
      expect(saved.source_session_id).toBe(id);
      expect(saved.history.slice(0, before.history.length)).toEqual(
        before.history,
      );
      expect(saved.history).toContainEqual(
        expect.objectContaining({
          type: 'compacted',
          payload: expect.objectContaining({ message: summary }),
        }),
      );
      expect(await readSessionInstructions(saved)).toBe('Current instructions');
      const replacementSnapshot = await session.modelContext();
      expect(
        (await (await session.submit('Continue')).wait()).finalOutput,
      ).toBe('Continued answer');
      expect(server.requests[2].reasoning).toMatchObject({ effort: 'low' });
      await expect(agent.session({ state: saved })).rejects.toThrow(
        'latest accepted instructions',
      );
      const destination = new Agent({
        instructions: 'Current instructions',
        provider,
        tools: [lookup],
      });
      const restored = await destination.session({ state: saved });
      try {
        expect(restored.id).toBe(id);
        await expect(
          restored.compact({
            summary,
            snapshot: replacementSnapshot,
            retain: [],
          }),
        ).rejects.toThrow(/snapshot must come from this session/i);
        expect(
          (await (await restored.submit('Resume saved summary')).wait())
            .finalOutput,
        ).toBe('Restored answer');
        expect(server.requests[4].reasoning).toMatchObject({ effort: 'low' });
      } finally {
        await restored.close();
      }
      expect(calls).toBe(3);
      server.assertExhausted();
    } finally {
      await session.close();
      await provider.close();
    }
  });

  it('rejects invalid, foreign and stale selections and accepts an empty selection', async () => {
    const approval = manualTool({
      name: 'decision',
      description: 'Request a decision.',
      parameters: z.object({}),
      result: z.string(),
    });
    const server = new ModelServer([
      [call('decision', {}, { callId: 'pending-decision' })],
      [message('Decision recorded')],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Answer.',
      provider,
      tools: [approval],
    });
    await using session = await agent.session();
    await using other = await agent.session();
    const snapshot = await session.modelContext();
    const summary = 'Application summary';
    const candidate = vi.spyOn(
      (await binding())._ContextChange.prototype,
      'createCandidateEngine',
    );
    await expect(session.compact({ summary, snapshot })).rejects.toThrow(
      /snapshot and retain together/i,
    );
    await expect(session.compact({ summary, retain: [] })).rejects.toThrow(
      /snapshot and retain together/i,
    );
    for (const foreign of [{ ...snapshot }, await other.modelContext()]) {
      await expect(
        session.compact({ summary, snapshot: foreign, retain: [] }),
      ).rejects.toThrow(/snapshot must come from this session/i);
    }
    for (const index of [-1, 0.5, snapshot.items.length]) {
      await expect(
        session.compact({ summary, snapshot, retain: [index] }),
      ).rejects.toBeInstanceOf(RangeError);
    }

    const turn = await session.submit('Original decision request');
    const pending = await turn.wait({ until: 'request' });
    if (!('requests' in pending)) throw new Error('Expected a manual request');
    const request = approval.match(pending.requests[0]);
    if (!request) throw new Error('Expected the decision request');
    await expect(session.modelContext()).rejects.toThrow(/settled/i);
    await expect(
      session.compact({ summary, snapshot, retain: [] }),
    ).rejects.toThrow(/settled/i);
    expect(server.requests).toHaveLength(1);
    await session.respond(request.reply('approved'));
    expect((await turn.wait()).finalOutput).toBe('Decision recorded');

    const before = await session.saveState();
    await expect(
      session.compact({ summary, snapshot, retain: [] }),
    ).rejects.toThrow(/snapshot is stale/i);
    expect(candidate).not.toHaveBeenCalled();
    expectPreservedAudit(before, await session.saveState());
    const current = await session.modelContext();
    await session.compact({ summary, snapshot: current, retain: [] });
    await expect(
      session.compact({ summary, snapshot: current, retain: [] }),
    ).rejects.toThrow(/snapshot is stale/i);
    expect(candidate).toHaveBeenCalledTimes(1);
    const context = JSON.stringify((await session.modelContext()).items);
    expect(context).toContain(summary);
    expect(context).not.toContain('Original decision request');
    server.assertExhausted();
  });

  it('excludes submits and updates during capture and joins capture before close', async () => {
    const addon = await binding();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = addon.NativeThread.prototype._read_model_context;
    vi.spyOn(
      addon.NativeThread.prototype,
      '_read_model_context',
    ).mockImplementationOnce(async function (this: NativeThread) {
      const payload = await read.call(this);
      entered.resolve();
      await release.promise;
      return payload;
    });
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session();
    const capture = session.modelContext().catch((error: unknown) => error);
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      await expect(session.submit('Must not sample')).rejects.toThrow();
      await expect(
        session.update({ instructions: 'Must not update' }),
      ).rejects.toThrow();
      let closed = false;
      closing = session.close().then(() => {
        closed = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      release.resolve();
      expect(await capture).toMatchObject({
        message: 'Session closed during model context capture',
      });
      await closing;
      expect(server.requests).toHaveLength(0);
    } finally {
      release.resolve();
      await capture;
      await closing;
    }
  });

  it('supports repeated supplied summaries followed by unchanged model compaction', async () => {
    const server = new ModelServer([
      [message('Original')],
      (request) => {
        expect(JSON.stringify(request)).toContain('second supplied summary');
        return [message('Model summary')];
      },
      [message('After model compaction')],
    ]);
    const provider = await providerFor(server);
    const session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session();
    try {
      const result = await (await session.submit('Start')).wait();
      const before = await session.saveState();
      await session.compact({ summary: 'first supplied summary' });
      await session.compact({ summary: 'second supplied summary' });
      expect(server.requests).toHaveLength(1);
      const repeated = await session.saveState();
      expect(repeated.history.slice(0, before.history.length)).toEqual(
        before.history,
      );
      expect(
        repeated.history.filter((record) => record.type === 'compacted'),
      ).toHaveLength(2);
      await session.compact();
      expect(server.requests).toHaveLength(2);
      expect(await session.wait()).toBe(result);
      expect((await (await session.submit('Next')).wait()).finalOutput).toBe(
        'After model compaction',
      );
      server.assertExhausted();
    } finally {
      await session.close();
      await provider.close();
    }
  });

  it('rejects empty summaries and pre-aborted signals before native admission', async () => {
    const addon = await binding();
    const admission = vi.spyOn(
      addon.NativeThread.prototype,
      '_begin_context_change',
    );
    const server = new ModelServer([[message('Still usable')]]);
    const provider = await providerFor(server);
    const session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session();
    try {
      const before = await session.saveState();
      for (const summary of ['', ' \n\t ']) {
        await expect(session.compact({ summary })).rejects.toThrow();
      }
      const controller = new AbortController();
      controller.abort();
      await expect(
        session.compact({ summary: 'unused', signal: controller.signal }),
      ).rejects.toThrow();
      expect(admission).not.toHaveBeenCalled();
      const after = await session.saveState();
      expectPreservedAudit(before, after);
      expect(await readSessionInstructions(after)).toBe('Answer.');
      expect(await collect(session.items())).toEqual([]);
      expect(await collect(session.turns())).toEqual([]);
      expect(server.requests).toHaveLength(0);
      expect(
        (await (await session.submit('Continue')).wait()).finalOutput,
      ).toBe('Still usable');
      server.assertExhausted();
    } finally {
      await session.close();
      await provider.close();
    }
  });

  it('refuses a local profile without candidate creation and leaves it usable', async () => {
    const home = await mkdtemp(join(tmpdir(), 'supplied-compaction-profile-'));
    const addon = await binding();
    const candidate = vi.spyOn(
      addon._ContextChange.prototype,
      'createCandidateEngine',
    );
    const server = new ModelServer([[message('Local session still usable')]]);
    const provider = await providerFor(server);
    const session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session({ storage: localStorage(join(home, 'profile')) });
    try {
      await expect(session.compact({ summary: 'unsupported' })).rejects.toThrow(
        /local|storage/i,
      );
      expect(candidate).not.toHaveBeenCalled();
      expect(
        (await (await session.submit('Continue')).wait()).finalOutput,
      ).toBe('Local session still usable');
      server.assertExhausted();
    } finally {
      await session.close();
      await provider.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('refuses a restored goal before candidate effects and preserves the goal', async () => {
    const server = new ModelServer([[message('Goal owner still usable')]]);
    const provider = await providerFor(server);
    const agent = new Agent({ instructions: 'Answer.', provider });
    const original = await agent.session();
    const state = await original.saveState();
    await original.close();
    state.root_goal = {
      thread_id: state.source_session_id,
      objective: 'Retain this goal',
      status: 'paused',
      token_budget: 100,
      tokens_used: 17,
      time_used_seconds: 3,
    };
    const addon = await binding();
    const candidate = vi.spyOn(
      addon._ContextChange.prototype,
      'createCandidateEngine',
    );
    const session = await agent.session({ state });
    try {
      const before = await session.saveState();
      await expect(session.compact({ summary: 'unsupported' })).rejects.toThrow(
        /goal/i,
      );
      expect(candidate).not.toHaveBeenCalled();
      expect((await session.saveState()).root_goal).toEqual(before.root_goal);
      expect(before.root_goal).toMatchObject(state.root_goal!);
      expect(server.requests).toHaveLength(0);
      expect(
        (await (await session.submit('Continue')).wait()).finalOutput,
      ).toBe('Goal owner still usable');
      server.assertExhausted();
    } finally {
      await session.close();
      await provider.close();
    }
  });

  it('refuses native admission when the goal backend is enabled without a current goal', async () => {
    const home = await mkdtemp(
      join(tmpdir(), 'supplied-compaction-goal-backend-'),
    );
    const addon = await binding();
    const candidate = vi.spyOn(
      addon._ContextChange.prototype,
      'createCandidateEngine',
    );
    const server = new ModelServer([]);
    const config = {
      ...(await server.config()),
      model: 'gpt-5',
      approval_policy: 'never',
      sandbox_mode: 'danger-full-access',
      web_search: 'disabled',
      'analytics.enabled': false,
      'features.shell_snapshot': false,
    };
    const runtime = {
      codex_home: home,
      cwd: home,
      native_goal_store: home,
      strict_config: true,
      loader: {
        managed_config_path: join(home, 'managed.toml'),
        system_config_path: join(home, 'system.toml'),
        system_requirements_path: join(home, 'requirements.toml'),
        ignore_user_config: true,
        ignore_project_config: true,
      },
    };
    const engine = await addon.create_engine(
      JSON.stringify(config),
      JSON.stringify(runtime),
      'synthetic-goal-backend',
    );
    try {
      const thread = await engine.start_replaceable_thread('{}', '[]');
      try {
        const before = JSON.parse(await thread._export_checkpoint(null, false));
        expect(before.root_goal ?? null).toBeNull();
        await expect(thread._begin_context_change()).rejects.toThrow(/goal/i);
        expect(candidate).not.toHaveBeenCalled();
        const after = JSON.parse(await thread._export_checkpoint(null, false));
        expectPreservedAudit(before, after);
        expect(server.requests).toHaveLength(0);
      } finally {
        await thread.close();
      }
    } finally {
      await engine.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('holds mutation ownership until an aborted prepare has settled and rollback completes', async () => {
    const addon = await binding();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const prepare = addon._ContextChange.prototype.prepare;
    vi.spyOn(addon._ContextChange.prototype, 'prepare').mockImplementationOnce(
      async function (this: _ContextChange, summary, indices) {
        const checkpoint = await prepare.call(this, summary, indices);
        entered.resolve();
        await release.promise;
        return checkpoint;
      },
    );
    const server = new ModelServer([[message('Successor survived')]]);
    const provider = await providerFor(server);
    const session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session();
    const controller = new AbortController();
    const before = await session.saveState();
    const snapshot = await session.modelContext();
    const compacting = session.compact({
      summary: 'aborted summary',
      signal: controller.signal,
      snapshot,
      retain: [],
    });
    const outcome = compacting.catch((error: unknown) => error);
    try {
      await entered.promise;
      controller.abort();
      let settled = false;
      void outcome.then(() => {
        settled = true;
      });
      await expect(session.submit('Must not queue')).rejects.toThrow();
      await expect(
        session.update({ instructions: 'Must not publish' }),
      ).rejects.toThrow();
      await expect(session.saveState()).rejects.toThrow();
      await expect(
        session.compact({ summary: 'Must not replace owner' }),
      ).rejects.toThrow();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      release.resolve();
      expect(await outcome).toBeInstanceOf(Error);
      const after = await session.saveState();
      expectPreservedAudit(before, after);
      expect(await session.modelContext()).toEqual(snapshot);
      expect(await readSessionInstructions(after)).toBe('Answer.');
      expect(await collect(session.items())).toEqual([]);
      expect(await collect(session.turns())).toEqual([]);
      expect(server.requests).toHaveLength(0);
      expect(
        (await (await session.submit('Successor')).wait()).finalOutput,
      ).toBe('Successor survived');
      server.assertExhausted();
    } finally {
      release.resolve();
      await outcome;
      await session.close();
      await provider.close();
    }
  });

  it('refuses an active turn immediately rather than compacting the later idle state', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = new ModelServer([
      async () => {
        entered.resolve();
        await release.promise;
        return [message('Active turn completed')];
      },
    ]);
    const addon = await binding();
    const admission = vi.spyOn(
      addon.NativeThread.prototype,
      '_begin_context_change',
    );
    const provider = await providerFor(server);
    const session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session();
    let result: Promise<unknown> | undefined;
    try {
      const turn = await session.submit('Hold provider request');
      result = turn.wait();
      await entered.promise;
      await expect(
        session.compact({ summary: 'Must not queue' }),
      ).rejects.toThrow();
      expect(admission).not.toHaveBeenCalled();
      release.resolve();
      expect(await result).toMatchObject({
        finalOutput: 'Active turn completed',
      });
      const saved = await session.saveState();
      expect(
        saved.history.filter((record) => record.type === 'compacted'),
      ).toEqual([]);
      server.assertExhausted();
    } finally {
      release.resolve();
      await result;
      await session.close();
      await provider.close();
    }
  });

  it('finishes publication after an abort during source retirement and leaves the successor usable', async () => {
    const addon = await binding();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const retire = addon._ContextChange.prototype.retire;
    vi.spyOn(addon._ContextChange.prototype, 'retire').mockImplementationOnce(
      async function (this: _ContextChange) {
        const diagnostic = await retire.call(this);
        entered.resolve();
        await release.promise;
        return diagnostic;
      },
    );
    const controller = new AbortController();
    const server = new ModelServer([
      (request) => {
        expect(JSON.stringify(request.input)).toContain(
          'committed supplied summary',
        );
        return [message('Successor was not cancelled')];
      },
    ]);
    const provider = await providerFor(server);
    const session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session();
    const outcome = session
      .compact({
        summary: 'committed supplied summary',
        signal: controller.signal,
      })
      .catch((error: unknown) => error);
    try {
      await entered.promise;
      controller.abort();
      release.resolve();
      // The operation may report cancellation only after publishing its replacement.
      await outcome;
      expect(server.requests).toHaveLength(0);
      expect(
        (await (await session.submit('Next turn')).wait()).finalOutput,
      ).toBe('Successor was not cancelled');
      server.assertExhausted();
    } finally {
      release.resolve();
      await outcome;
      await session.close();
      await provider.close();
    }
  });

  it('joins a mutation in close while retirement owns source teardown', async () => {
    const addon = await binding();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const retire = addon._ContextChange.prototype.retire;
    vi.spyOn(addon._ContextChange.prototype, 'retire').mockImplementationOnce(
      async function (this: _ContextChange) {
        entered.resolve();
        await release.promise;
        return retire.call(this);
      },
    );
    const server = new ModelServer([]);
    const provider = await providerFor(server);
    const session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session();
    const compacting = session
      .compact({ summary: 'replacement' })
      .catch((error: unknown) => error);
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      let closed = false;
      closing = session.close().then(() => {
        closed = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      await expect(provider.close()).rejects.toThrow(/open|opening/i);
      release.resolve();
      await compacting;
      await closing;
      await expect(session.submit('Closed')).rejects.toThrow();
      expect(server.requests).toHaveLength(0);
    } finally {
      release.resolve();
      await compacting;
      await closing;
      await session.close();
      await provider.close();
    }
  });

  it('restores source usability only after candidate validation rollback has physically completed', async () => {
    const addon = await binding();
    const failure = new Error('candidate validation failed');
    vi.spyOn(
      addon._ContextChange.prototype,
      'validateCandidate',
    ).mockRejectedValueOnce(failure);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleanup = addon._ContextChange.prototype.cleanupCandidate;
    const cleanupSpy = vi
      .spyOn(addon._ContextChange.prototype, 'cleanupCandidate')
      .mockImplementationOnce(async function (this: _ContextChange) {
        entered.resolve();
        await release.promise;
        return cleanup.call(this);
      });
    const server = new ModelServer([[message('Original source continued')]]);
    const provider = await providerFor(server);
    const session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session();
    const id = session.id;
    const before = await session.saveState();
    const outcome = session
      .compact({ summary: 'not published' })
      .catch((error: unknown) => error);
    try {
      await entered.promise;
      await expect(session.submit('Too early')).rejects.toThrow();
      await expect(session.saveState()).rejects.toThrow();
      release.resolve();
      expect(await outcome).toBe(failure);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(session.id).toBe(id);
      const after = await session.saveState();
      expectPreservedAudit(before, after);
      expect(await readSessionInstructions(after)).toBe('Answer.');
      expect(await collect(session.items())).toEqual([]);
      expect(await collect(session.turns())).toEqual([]);
      expect(
        (await (await session.submit('Continue')).wait()).finalOutput,
      ).toBe('Original source continued');
      server.assertExhausted();
    } finally {
      release.resolve();
      await outcome;
      await session.close();
      await provider.close();
    }
  });

  it('cleans a candidate engine after restore fails and preserves the source', async () => {
    const addon = await binding();
    const server = new ModelServer([[message('Source remained usable')]]);
    const provider = await providerFor(server);
    const session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session();
    const before = await session.saveState();
    const failure = new Error('candidate restore failed');
    vi.spyOn(
      addon.Engine.prototype,
      'restore_checkpoint',
    ).mockRejectedValueOnce(failure);
    const cleanup = vi.spyOn(
      addon._ContextChange.prototype,
      'cleanupCandidate',
    );
    try {
      await expect(session.compact({ summary: 'not installed' })).rejects.toBe(
        failure,
      );
      expect(cleanup).toHaveBeenCalledTimes(1);
      const after = await session.saveState();
      expectPreservedAudit(before, after);
      expect(await readSessionInstructions(after)).toBe('Answer.');
      expect(await collect(session.items())).toEqual([]);
      expect(await collect(session.turns())).toEqual([]);
      expect(server.requests).toHaveLength(0);
      expect(
        (await (await session.submit('Continue')).wait()).finalOutput,
      ).toBe('Source remained usable');
      server.assertExhausted();
    } finally {
      await session.close();
      await provider.close();
    }
  });

  it('permanently retires after uncertain candidate cleanup and retains cleanup for retryable close', async () => {
    const addon = await binding();
    const setupFailure = new Error('candidate validation failed');
    const cleanupFailure = new Error('candidate cleanup not confirmed');
    vi.spyOn(
      addon._ContextChange.prototype,
      'validateCandidate',
    ).mockRejectedValueOnce(setupFailure);
    // Only the first attempt is interrupted. Subsequent calls execute real cleanup.
    const cleanup = vi
      .spyOn(addon._ContextChange.prototype, 'cleanupCandidate')
      .mockRejectedValueOnce(cleanupFailure);
    const server = new ModelServer([]);
    const provider = await providerFor(server);
    const session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session();
    try {
      const failure = await session
        .compact({ summary: 'not published' })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).cause).toBe(setupFailure);
      expect((failure as AggregateError).errors).toContain(setupFailure);
      expect((failure as AggregateError).errors).toContain(cleanupFailure);
      await expect(session.submit('Retired')).rejects.toThrow();
      await expect(session.saveState()).rejects.toThrow();
      await expect(
        session.compact({ summary: 'No second candidate' }),
      ).rejects.toThrow();
      await expect(provider.close()).rejects.toThrow(/open|opening/i);
      await session.close();
      expect(cleanup).toHaveBeenCalledTimes(2);
      await session.close();
      expect(cleanup).toHaveBeenCalledTimes(2);
      expect(server.requests).toHaveLength(0);
    } finally {
      await session.close();
      await provider.close();
    }
  });
});
