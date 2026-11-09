import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  NativeError,
  LocalRecoveryRequired,
  NativeAgents,
  nativeGoals,
  checklist,
  manualTool,
  webSearch,
  fileSessionStore,
  reconcileSessionStore,
  tool,
  ToolOutput,
  type SessionStore,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
import { readRecoveryIntent } from '../../../../examples/codex/custom-storage-recovery';

const directories: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) =>
        child.once('exit', () => resolve()),
      );
      child.kill('SIGKILL');
      await exited;
    }),
  );
  await ModelServer.closeAll();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'custom-storage-native-'));
  directories.push(path);
  return path;
}
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-custom-storage',
    supportsWebsockets: false,
  });
}
async function history(session: Awaited<ReturnType<Agent['session']>>) {
  const items = [];
  for await (const item of session.items()) items.push(item);
  return items;
}
async function worker(server: ModelServer, config: Record<string, unknown>) {
  const provider = await providerFor(server);
  const child = fork(
    fileURLToPath(
      new URL('./fixtures/custom-storage-worker.ts', import.meta.url),
    ),
    [JSON.stringify({ ...config, url: provider.baseUrl })],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  children.push(child);
  await provider.close();
  const messages: Record<string, any>[] = [];
  let stderr = '';
  child.stderr?.on('data', (data) => {
    stderr += String(data);
  });
  child.on('message', (value) => messages.push(value as Record<string, any>));
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  const wait = async (type: string): Promise<Record<string, any>> => {
    const found = messages.find((value) => value.type === type);
    if (found) return found;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        child.off('message', receive);
        child.off('exit', fail);
      };
      const receive = (value: any) => {
        if (value.type === type) {
          cleanup();
          resolve(value);
        }
      };
      const fail = () => {
        cleanup();
        reject(
          new Error(
            `Worker exited before ${type}: ${stderr} ${JSON.stringify(messages)}`,
          ),
        );
      };
      child.on('message', receive);
      child.once('exit', fail);
      if (child.exitCode !== null || child.signalCode !== null) fail();
    });
  };
  return { child, wait, exited };
}

// Exercise the public native runner with a real durable adapter. Faults cross
// the application-owned storage boundary, never fabricated native events.
describe('public native custom storage durability', () => {
  it.each(['goals', 'children', 'checklist', 'manual'] as const)(
    'rejects unsupported %s before acquiring storage or dispatching work',
    async (kind) => {
      const durable = fileSessionStore(await directory());
      const server = new ModelServer([]);
      const provider = await providerFor(server);
      let acquisitions = 0;
      let effects = 0;
      const storage: SessionStore = {
        ...durable,
        acquire: async (...args) => {
          acquisitions++;
          return durable.acquire(...args);
        },
      };
      const agent = new Agent({
        instructions: 'Do work.',
        model: 'gpt-5.1-codex',
        provider,
        tools: [
          webSearch(),
          kind === 'goals'
            ? nativeGoals()
            : kind === 'children'
              ? new NativeAgents()
              : kind === 'manual'
                ? manualTool({
                    name: 'pending',
                    description: 'Read.',
                    parameters: z.object({}),
                    result: z.string(),
                  })
                : checklist(),
          tool({
            name: 'record',
            description: 'Record.',
            parameters: z.object({}),
            execute: () => {
              effects++;
              return 'recorded';
            },
          }),
        ],
      });
      await expect(agent.session({ storage })).rejects.toThrow(
        /Custom canonical storage does not support/,
      );
      expect(acquisitions).toBe(0);
      expect(effects).toBe(0);
      await provider.close();
      server.assertExhausted();
    },
  );

  it('rejects local reconciliation receipts for custom storage before acquiring or dispatching work', async () => {
    const durable = fileSessionStore(await directory());
    const server = new ModelServer([]);
    const provider = await providerFor(server);
    let acquisitions = 0;
    let reads = 0;
    let effects = 0;
    const storage: SessionStore = {
      ...durable,
      acquire: async (...args) => {
        acquisitions++;
        return durable.acquire(...args);
      },
      read: async (...args) => {
        reads++;
        return durable.read(...args);
      },
    };
    const threadId = '00000000-0000-4000-8000-000000000001';
    const agent = new Agent({
      instructions: 'Do work.',
      model: 'gpt-5',
      provider,
      tools: [
        tool({
          name: 'record',
          description: 'Record.',
          parameters: z.object({}),
          execute: () => {
            effects++;
            return 'recorded';
          },
        }),
      ],
    });
    const failure = await agent
      .session({
        storage,
        resume: threadId,
        // @ts-expect-error Verify runtime rejection for untyped custom-store callers.
        reconciledCalls: [
          {
            threadId,
            turnId: '00000000-0000-4000-8000-000000000002',
            callId: 'verified-call',
            outcome: 'applied',
            result: 'external effect verified',
          },
        ],
      })
      .catch((error) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure.message).toMatch(
      /reconciledCalls requires local storage and resume/,
    );
    expect(acquisitions).toBe(0);
    expect(reads).toBe(0);
    expect(effects).toBe(0);
    await provider.close();
    server.assertExhausted();
  });

  it('cold resumes completed history in another process without repeating an effect', async () => {
    const path = await directory();
    const server = new ModelServer([
      [call('record', {}, { callId: 'durable-effect' })],
      [message('recorded once')],
    ]);
    const sourceKey = 'synthetic-source-credential';
    const currentKey = 'synthetic-current-credential';
    const destination = new ModelServer([
      (request) => {
        expect(JSON.stringify(request.input)).toContain('recorded once');
        return [call('record', {}, { callId: 'current-call' })];
      },
      [message('current callback complete')],
    ]);
    const first = await worker(server, {
      label: 'source',
      apiKey: sourceKey,
      directory: path,
      effects: join(path, 'effects'),
      mode: 'run',
    });
    const opened = await first.wait('opened');
    const result = await first.wait('result');
    await first.wait('done');
    await first.exited;
    const second = await worker(destination, {
      label: 'current',
      apiKey: currentKey,
      directory: path,
      effects: join(path, 'effects'),
      mode: 'run',
      resume: opened.id,
    });
    expect((await second.wait('opened')).history).toEqual(result.history);
    expect((await second.wait('result')).output).toBe(
      'current callback complete',
    );
    await second.wait('done');
    await second.exited;
    expect(await readFile(join(path, 'effects'), 'utf8')).toBe(
      'source\ncurrent\n',
    );
    expect(JSON.stringify(result.history)).toContain('recorded once');
    expect(result.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call',
          callId: 'durable-effect',
        }),
        expect.objectContaining({
          type: 'function_call_output',
          callId: 'durable-effect',
        }),
      ]),
    );
    expect(
      server.requestHeaders.map((headers) => headers.authorization),
    ).toEqual([`Bearer ${sourceKey}`, `Bearer ${sourceKey}`]);
    expect(
      destination.requestHeaders.map((headers) => headers.authorization),
    ).toEqual([`Bearer ${currentKey}`, `Bearer ${currentKey}`]);
    destination.assertExhausted();
    server.assertExhausted();
  }, 45000);

  it('fences competing process writers and permits a new owner after joined close', async () => {
    const path = await directory();
    const server = new ModelServer([]);
    const owner = await worker(server, { directory: path, mode: 'hold-open' });
    const opened = await owner.wait('opened');
    const competitor = await worker(server, {
      directory: path,
      mode: 'hold-open',
      resume: opened.id,
    });
    expect((await competitor.wait('failure')).message).toMatch(
      /owner|writer|locked|lease|fenc|canonical storage operation failed/i,
    );
    await competitor.exited;
    owner.child.send('close');
    await owner.wait('done');
    await owner.exited;
    const successor = await worker(server, {
      directory: path,
      mode: 'hold-open',
      resume: opened.id,
    });
    expect((await successor.wait('opened')).id).toBe(opened.id);
    successor.child.send('close');
    await successor.wait('done');
    await successor.exited;
    server.assertExhausted();
  }, 45000);

  it('inspects a durable native intent before application code journals its identity', async () => {
    const path = await directory();
    const effects = join(path, 'effects');
    const server = new ModelServer([
      [call('record', {}, { callId: 'intent-before-callback' })],
    ]);
    const first = await worker(server, {
      directory: path,
      effects,
      mode: 'hold-intent',
    });
    const opened = await first.wait('opened');
    await first.wait('durable-intent');
    first.child.kill('SIGKILL');
    await first.exited;
    await expect(readFile(effects)).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(join(path, `${opened.id}.lock`), { recursive: true });
    const provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Use record when requested.',
      model: 'gpt-5',
      provider,
    });
    let required!: LocalRecoveryRequired;
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await agent
        .session({ storage: fileSessionStore(path), resume: opened.id })
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(LocalRecoveryRequired);
      required = error as LocalRecoveryRequired;
      expect(required.calls).toEqual([
        expect.objectContaining({
          threadId: opened.id,
          turnId: expect.any(String),
          callId: 'intent-before-callback',
          name: 'record',
          arguments: '{}',
        }),
      ]);
      expect(required.items).toContainEqual(
        expect.objectContaining({
          type: 'function_call',
          callId: 'intent-before-callback',
        }),
      );
    }
    const blockedProvider = await providerFor(server);
    const blockedAgent = new Agent({
      instructions: 'Use record when requested.',
      model: 'gpt-5',
      provider: blockedProvider,
    });
    const durable = fileSessionStore(path);
    let releaseBlocked = true;
    try {
      const blocked = await blockedAgent
        .session({
          storage: {
            ...durable,
            async release(...args) {
              if (releaseBlocked)
                throw new Error('fixture release unavailable');
              await durable.release(...args);
            },
          },
          resume: opened.id,
        })
        .catch((error: unknown) => error);
      expect(blocked).toBeInstanceOf(AggregateError);
      const original = (blocked as AggregateError).cause;
      expect(original).toBeInstanceOf(LocalRecoveryRequired);
      expect((original as LocalRecoveryRequired).calls).toEqual(required.calls);
      await expect(durable.acquire(opened.id)).rejects.toMatchObject({
        code: 'EEXIST',
      });
    } finally {
      releaseBlocked = false;
      // Cleanup may report its retained release diagnostic after the physical
      // unlock. A repeat through the same public owner must finish successfully.
      await blockedProvider.close().catch(() => {});
      await blockedProvider.close();
    }
    await reconcileSessionStore(fileSessionStore(path), {
      sessionId: required.calls[0].threadId,
      turnId: required.calls[0].turnId,
      callId: required.calls[0].callId,
      result: 'Application verified that no effect was dispatched.',
    });
    const resumed = await agent.session({
      storage: fileSessionStore(path),
      resume: opened.id,
    });
    expect(
      (await history(resumed)).filter(
        (item) => item.type === 'function_call_output',
      ),
    ).toEqual([expect.objectContaining({ callId: 'intent-before-callback' })]);
    await resumed.close();
    await provider.close();
    await expect(readFile(effects)).rejects.toMatchObject({ code: 'ENOENT' });
    server.assertExhausted();
  }, 45000);

  it('recovers from the application intent journal after SIGKILL without replaying the effect', async () => {
    const path = await directory();
    const effects = join(path, 'effects');
    const intentPath = join(path, 'order-intent.json');
    const server = new ModelServer([
      [call('record', {}, { callId: 'ambiguous-effect' })],
    ]);
    const first = await worker(server, {
      directory: path,
      effects,
      intentPath,
      mode: 'hold-effect',
    });
    const opened = await first.wait('opened');
    const submitted = await first.wait('submitted');
    await first.wait('effect');
    await expect(
      reconcileSessionStore(fileSessionStore(path), {
        sessionId: opened.id,
        turnId: submitted.turnId,
        callId: 'ambiguous-effect',
        result: 'must not overwrite a live owner',
      }),
    ).rejects.toThrow(
      /owner|writer|locked|lease|fenc|canonical storage operation failed/i,
    );
    first.child.kill('SIGKILL');
    await first.exited;
    // The replacement process needs only application-owned files. It does not
    // parse the native snapshot or reuse the departed worker's in-memory IDs.
    const { businessKey, ...identities } = await readRecoveryIntent(intentPath);
    expect(businessKey).toBe('synthetic-order');
    expect(await readFile(effects, 'utf8')).toBe('effect\n');
    // The application must establish process death before removing a stale
    // reference-adapter lock. The adapter never steals a live owner's lease.
    await rm(join(path, `${identities.sessionId}.lock`), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      const resumed = await worker(server, {
        directory: path,
        effects,
        mode: 'hold-open',
        resume: identities.sessionId,
      });
      expect((await resumed.wait('failure')).message).toMatch(
        /unknown|unresolved|reconcil/i,
      );
      await resumed.exited;
    }
    expect(await readFile(effects, 'utf8')).toBe('effect\n');
    const reconciliation = {
      ...identities,
      result: 'external effect verified',
    };
    await reconcileSessionStore(fileSessionStore(path), reconciliation);
    await expect(
      reconcileSessionStore(fileSessionStore(path), reconciliation),
    ).rejects.toThrow(/pending|unresolved|already|intent/i);
    const currentServer = new ModelServer([
      (request) => {
        expect(JSON.stringify(request.input)).toContain(
          'external effect verified',
        );
        return [call('record', {}, { callId: 'current-effect' })];
      },
      [message('continued after reconciliation')],
    ]);
    const currentProvider = await providerFor(currentServer);
    const recovered = await new Agent({
      instructions: 'Use record when requested.',
      model: 'gpt-5',
      provider: currentProvider,
      tools: [
        tool({
          name: 'record',
          description: 'Record.',
          parameters: z.object({}),
          execute: async () => {
            await appendFile(effects, 'current binding\n');
            return 'current';
          },
        }),
      ],
    }).session({
      storage: fileSessionStore(path),
      resume: identities.sessionId,
    });
    expect(recovered.id).toBe(identities.sessionId);
    expect(
      (
        await (
          await recovered.submit('Continue after verified reconciliation.')
        ).wait()
      ).finalOutput,
    ).toBe('continued after reconciliation');
    const recoveredHistory = await history(recovered);
    expect(
      recoveredHistory.filter(
        (item) =>
          item.type === 'function_call_output' &&
          item.callId === 'ambiguous-effect',
      ),
    ).toHaveLength(1);
    await recovered.close();
    await currentProvider.close();
    expect(await readFile(effects, 'utf8')).toBe('effect\ncurrent binding\n');
    currentServer.assertExhausted();
    server.assertExhausted();
  }, 45000);

  it.each([
    'transient release',
    'lost release acknowledgment',
    'persistent release',
    'receipt failure',
    'receipt and release failure',
  ] as const)(
    'keeps reconciliation and cleanup outcomes separate after %s',
    async (fault) => {
      const path = await directory();
      const effects = join(path, 'effects');
      const server = new ModelServer([
        [call('record', {}, { callId: 'reconciled-effect' })],
      ]);
      const original = await worker(server, {
        directory: path,
        effects,
        mode: 'hold-effect',
      });
      const opened = await original.wait('opened');
      const submitted = await original.wait('submitted');
      await original.wait('effect');
      original.child.kill('SIGKILL');
      await original.exited;
      await rm(join(path, `${opened.id}.lock`), { recursive: true });
      const durable = fileSessionStore(path);
      let releases = 0;
      let releaseBlocked = true;
      let receiptWrites = 0;
      const storage: SessionStore = {
        ...durable,
        commit: async (...args) => {
          receiptWrites++;
          if (
            fault === 'receipt failure' ||
            fault === 'receipt and release failure'
          )
            throw new Error('fixture reconciliation receipt unavailable');
          await durable.commit(...args);
        },
        release: async (...args) => {
          releases++;
          if (
            (releases === 1 && fault !== 'receipt failure') ||
            (releaseBlocked &&
              (fault === 'persistent release' ||
                fault === 'receipt and release failure'))
          ) {
            if (fault === 'lost release acknowledgment')
              await durable.release(...args);
            throw new Error('fixture reconciliation release unavailable');
          }
          await durable.release(...args);
        },
      };
      const reconciliation = {
        sessionId: opened.id,
        turnId: submitted.turnId,
        callId: 'reconciled-effect',
        result: 'externally verified completion',
      };
      const outcome = reconcileSessionStore(storage, reconciliation);
      if (
        fault === 'persistent release' ||
        fault === 'receipt and release failure'
      ) {
        const error = await outcome.catch((error: unknown) => error);
        expect(error).toBeInstanceOf(NativeError);
        if (!(error instanceof NativeError) || !error.cleanup)
          throw new Error('Expected a retained storage cleanup owner');
        if (fault === 'receipt and release failure')
          expect(error.message).toMatch(
            /reconciliation failed:.*canonical storage operation failed.*writer cleanup failed:.*canonical storage operation failed/s,
          );
        else
          expect(error.message).toMatch(
            /canonical storage operation failed.*release retry failed/s,
          );
        expect(error.message).not.toContain('fixture');
        const writes = receiptWrites;
        await expect(error.cleanup.close()).rejects.toThrow(
          /canonical storage operation failed/,
        );
        await expect(durable.acquire(opened.id)).rejects.toMatchObject({
          code: 'EEXIST',
        });
        releaseBlocked = false;
        await Promise.all([error.cleanup.close(), error.cleanup.close()]);
        await error.cleanup.close();
        expect(receiptWrites).toBe(writes);
        if (fault === 'receipt and release failure')
          await reconcileSessionStore(durable, reconciliation);
      } else if (fault === 'receipt failure') {
        await expect(outcome).rejects.toThrow(
          /canonical storage operation failed/,
        );
        await reconcileSessionStore(durable, reconciliation);
      } else {
        await expect(outcome).resolves.toBeUndefined();
      }
      expect(releases).toBe(
        fault === 'receipt failure'
          ? 1
          : fault === 'persistent release' ||
              fault === 'receipt and release failure'
            ? 4
            : 2,
      );
      await expect(
        reconcileSessionStore(durable, reconciliation),
      ).rejects.toThrow(/unresolved|already|intent/i);
      const reopened = await worker(server, {
        directory: path,
        effects,
        mode: 'hold-open',
        resume: opened.id,
      });
      const restored = await reopened.wait('opened');
      expect(
        restored.history.filter(
          (item: any) =>
            item.type === 'function_call_output' &&
            item.callId === 'reconciled-effect',
        ),
      ).toHaveLength(1);
      reopened.child.send('close');
      await reopened.wait('done');
      await reopened.exited;
      expect(await readFile(effects, 'utf8')).toBe('effect\n');
      server.assertExhausted();
    },
    45000,
  );

  it.each(['failed text', 'image', 'mixed media'] as const)(
    'restores the ordinary model-visible %s outcome after reconciliation',
    async (kind) => {
      const imageUrl =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
      const audioUrl =
        'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';
      const result =
        kind === 'failed text'
          ? new ToolOutput(
              [{ type: 'inputText', text: 'verified external failure' }],
              false,
            )
          : kind === 'image'
            ? ToolOutput.image(imageUrl)
            : new ToolOutput([
                { type: 'inputText', text: 'verified caption' },
                { type: 'inputImage', imageUrl },
                { type: 'inputAudio', audioUrl },
              ]);
      const ordinary = new ModelServer([
        [call('record', {}, { callId: 'parity-effect' })],
        [message('ordinary result accepted')],
      ]);
      const ordinaryProvider = await providerFor(ordinary);
      const normal = await new Agent({
        instructions: 'Use record.',
        model: 'gpt-5',
        provider: ordinaryProvider,
        tools: [
          tool({
            name: 'record',
            description: 'Record.',
            parameters: z.object({}),
            execute: () => result,
          }),
        ],
      }).session({ storage: fileSessionStore(await directory()) });
      await (await normal.submit('Record.')).wait();
      const normalHistory = await history(normal);
      const normalOutput = (
        ordinary.requests[1].input as Array<Record<string, unknown>>
      ).find(
        (item) =>
          item.type === 'function_call_output' &&
          item.call_id === 'parity-effect',
      )?.output;
      expect(normalOutput).toBeDefined();
      await normal.close();
      await ordinaryProvider.close();
      ordinary.assertExhausted();

      const path = await directory();
      const effects = join(path, 'effects');
      const crashed = new ModelServer([
        [call('record', {}, { callId: 'parity-effect' })],
      ]);
      const original = await worker(crashed, {
        directory: path,
        effects,
        mode: 'hold-effect',
      });
      const opened = await original.wait('opened');
      const submitted = await original.wait('submitted');
      await original.wait('effect');
      original.child.kill('SIGKILL');
      await original.exited;
      await rm(join(path, `${opened.id}.lock`), { recursive: true });
      await reconcileSessionStore(fileSessionStore(path), {
        sessionId: opened.id,
        turnId: submitted.turnId,
        callId: 'parity-effect',
        result,
      });
      const resumed = new ModelServer([
        [message('reconciled result accepted')],
      ]);
      const resumedProvider = await providerFor(resumed);
      let replayedEffects = 0;
      const recovered = await new Agent({
        instructions: 'Use record when requested.',
        model: 'gpt-5',
        provider: resumedProvider,
        tools: [
          tool({
            name: 'record',
            description: 'Record.',
            parameters: z.object({}),
            execute: () => {
              replayedEffects++;
              return result;
            },
          }),
        ],
      }).session({ storage: fileSessionStore(path), resume: opened.id });
      const restored = await history(recovered);
      const originalReceipt = normalHistory.find(
        (item) =>
          item.type === 'function_call_output' &&
          item.callId === 'parity-effect',
      );
      const reconciledReceipt = restored.filter(
        (item) =>
          item.type === 'function_call_output' &&
          item.callId === 'parity-effect',
      );
      expect(reconciledReceipt).toHaveLength(1);
      const restoredReceipt = reconciledReceipt[0];
      if (
        originalReceipt?.type !== 'function_call_output' ||
        restoredReceipt?.type !== 'function_call_output'
      )
        throw new Error('Expected ordinary and reconciled tool receipts');
      expect(restoredReceipt.output).toEqual(originalReceipt.output);
      await (await recovered.submit('Use the verified result.')).wait();
      const restoredOutput = (
        resumed.requests[0].input as Array<Record<string, unknown>>
      ).find(
        (item) =>
          item.type === 'function_call_output' &&
          item.call_id === 'parity-effect',
      )?.output;
      expect(restoredOutput).toEqual(normalOutput);
      expect(replayedEffects).toBe(0);
      expect(await readFile(effects, 'utf8')).toBe('effect\n');
      await recovered.close();
      await resumedProvider.close();
      crashed.assertExhausted();
      resumed.assertExhausted();
    },
    45000,
  );

  it('does not treat canceled native cleanup as a committed callback result', async () => {
    const path = await directory();
    const effects = join(path, 'effects');
    const server = new ModelServer([
      [call('record', {}, { callId: 'canceled-effect' })],
    ]);
    const running = await worker(server, {
      directory: path,
      effects,
      mode: 'hold-abort',
    });
    const opened = await running.wait('opened');
    await running.wait('effect');
    running.child.send('close');
    expect((await running.wait('close-error')).message).toMatch(
      /cleanup|cancel|abort/i,
    );
    await running.exited;
    const reopened = await worker(server, {
      directory: path,
      effects,
      mode: 'hold-open',
      resume: opened.id,
    });
    expect((await reopened.wait('failure')).message).toMatch(
      /unknown|unresolved|reconcil/i,
    );
    await reopened.exited;
    expect(await readFile(effects, 'utf8')).toBe('effect\n');
    server.assertExhausted();
  }, 45000);

  it('fails opening before model dispatch when the store read is unavailable', async () => {
    const durable = fileSessionStore(await directory());
    const server = new ModelServer([]);
    const provider = await providerFor(server);
    let releases = 0;
    const storage: SessionStore = {
      acquire: (...args) => durable.acquire(...args),
      commit: (...args) => durable.commit(...args),
      read: async () => {
        throw new Error('fixture read unavailable');
      },
      release: async (...args) => {
        releases++;
        await durable.release(...args);
      },
    };
    await expect(
      new Agent({ instructions: 'Answer.', model: 'gpt-5', provider }).session({
        storage,
      }),
    ).rejects.toThrow(/canonical storage operation failed/);
    expect(releases).toBe(1);
    await provider.close();
    server.assertExhausted();
  });

  it.each(['commit', 'flush'] as const)(
    'does not dispatch the callback when its intent %s fails',
    async (failurePoint) => {
      const durable = fileSessionStore(await directory());
      let armed = false;
      let effects = 0;
      const storage: SessionStore = {
        acquire: (...args) => durable.acquire(...args),
        read: (...args) => durable.read(...args),
        release: (...args) => durable.release(...args),
        commit: async (...args) => {
          if (armed && failurePoint === 'commit')
            throw new Error('fixture intent durability unavailable');
          await durable.commit(...args);
        },
        flush: async () => {
          if (armed && failurePoint === 'flush')
            throw new Error('fixture intent durability unavailable');
        },
      };
      const server = new ModelServer(
        [[call('record', {}, { callId: 'blocked-effect' })]],
        [],
        () => {
          armed = true;
        },
      );
      const provider = await providerFor(server);
      const session = await new Agent({
        instructions: 'Record.',
        model: 'gpt-5',
        provider,
        tools: [
          webSearch(),
          tool({
            name: 'record',
            description: 'Record once.',
            parameters: z.object({}),
            execute: () => {
              effects++;
              return 'recorded';
            },
          }),
        ],
      }).session({ storage });
      await expect((await session.submit('Record.')).wait()).rejects.toThrow(
        /canonical storage operation failed/,
      );
      await expect(session.close()).rejects.toThrow(
        /canonical storage operation failed/,
      );
      await expect(session.close()).rejects.toThrow(
        /canonical storage operation failed/,
      );
      await provider.close();
      expect(effects).toBe(0);
      server.assertExhausted();
    },
  );

  it('reports a failed initial write before model or tool dispatch', async () => {
    const durable = fileSessionStore(await directory());
    const server = new ModelServer([]);
    const provider = await providerFor(server);
    const storage: SessionStore = {
      acquire: (...args) => durable.acquire(...args),
      read: (...args) => durable.read(...args),
      release: (...args) => durable.release(...args),
      commit: async () => {
        throw new Error('fixture initial commit unavailable');
      },
    };
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    });
    const failure = await agent.session({ storage }).catch((error) => error);
    expect(
      String(failure) +
        String(failure.cause) +
        JSON.stringify(failure.errors?.map(String)),
    ).toMatch(/canonical storage operation failed/);
    await provider.close();
    server.assertExhausted();
  });

  it.each(['before release', 'lost acknowledgment'] as const)(
    'reports %s and retries close without discarding committed history',
    async (failurePoint) => {
      const path = await directory();
      const durable = fileSessionStore(path);
      const server = new ModelServer([[message('durable answer')]]);
      const provider = await providerFor(server);
      let releases = 0;
      const storage: SessionStore = {
        acquire: (...args) => durable.acquire(...args),
        read: (...args) => durable.read(...args),
        commit: (...args) => durable.commit(...args),
        release: async (...args) => {
          if (++releases === 1) {
            if (failurePoint === 'lost acknowledgment')
              await durable.release(...args);
            throw new Error('fixture release unavailable');
          }
          await durable.release(...args);
        },
      };
      const session = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      }).session({ storage });
      await (await session.submit('Answer.')).wait();
      const id = session.id;
      const expected = await history(session);
      await expect(session.close()).rejects.toThrow(
        /canonical storage operation failed/,
      );
      await session.close();
      expect(releases).toBe(2);
      await provider.close();
      const current = await providerFor(server);
      const reopened = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider: current,
      }).session({ storage: fileSessionStore(path), resume: id });
      expect(await history(reopened)).toEqual(expected);
      await reopened.close();
      await current.close();
      server.assertExhausted();
    },
  );

  it.skipIf(process.platform !== 'linux').each(['intent', 'result'] as const)(
    'reports a real built-in local %s write failure and stops further dispatch',
    async (boundary) => {
      const path = await directory();
      const server = new ModelServer(
        [[call('record', {}, { callId: 'local-failed-effect' })]],
        [],
        () => {
          if (boundary === 'intent') {
            expect(child?.pid).toBeTypeOf('number');
            execFileSync(
              '/usr/bin/prlimit',
              ['--pid', String(child!.pid), '--fsize=0:unlimited'],
              { stdio: 'pipe' },
            );
          }
        },
      );
      const running = await worker(server, {
        directory: join(path, 'local'),
        effects: join(path, 'effects'),
        local: true,
        mode: `local-${boundary}-fail`,
      });
      const child = running.child;
      await running.wait('opened');
      expect((await running.wait('turn-error')).message).toMatch(
        /storage|persist|file|large|write/i,
      );
      expect((await running.wait('sticky-error')).message).toMatch(
        /storage|persist|file|large|write|failed/i,
      );
      expect((await running.wait('close-error')).message).toMatch(
        /storage|persist|file|large|write/i,
      );
      expect((await running.wait('repeated-close-error')).message).toMatch(
        /storage|persist|file|large|write/i,
      );
      await running.wait('failure');
      await running.exited;
      expect(running.child.exitCode).toBe(1);
      expect(running.child.signalCode).toBeNull();
      const effects = await readFile(join(path, 'effects'), 'utf8').catch(
        (error) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        },
      );
      expect(effects).toBe(boundary === 'result' ? 'effect\n' : '');
      server.assertExhausted();
    },
    45000,
  );

  it('stops before an effect when a committed intent loses both write acknowledgments', async () => {
    const durable = fileSessionStore(await directory());
    let armed = false;
    let attempts = 0;
    let effects = 0;
    let original: Parameters<SessionStore['commit']> | undefined;
    const storage: SessionStore = {
      acquire: (...args) => durable.acquire(...args),
      read: (...args) => durable.read(...args),
      release: (...args) => durable.release(...args),
      commit: async (...args) => {
        if (!armed) return durable.commit(...args);
        attempts++;
        if (attempts === 1) {
          original = args;
          await durable.commit(...args);
        } else {
          expect(args).toEqual(original);
        }
        throw new Error('fixture lost write and confirmation acknowledgments');
      },
    };
    const server = new ModelServer(
      [[call('record', {}, { callId: 'unconfirmed-effect' })]],
      [],
      () => {
        armed = true;
      },
    );
    const provider = await providerFor(server);
    const session = await new Agent({
      instructions: 'Record.',
      model: 'gpt-5',
      provider,
      tools: [
        tool({
          name: 'record',
          description: 'Record.',
          parameters: z.object({}),
          execute: () => {
            effects++;
            return 'recorded';
          },
        }),
      ],
    }).session({ storage });
    await expect((await session.submit('Record.')).wait()).rejects.toThrow(
      /canonical storage operation failed/,
    );
    await expect(session.close()).rejects.toThrow(
      /canonical storage operation failed/,
    );
    await provider.close();
    expect(attempts).toBe(2);
    expect(effects).toBe(0);
    server.assertExhausted();
  });

  it.each(['lost acknowledgment', 'commit rejection'] as const)(
    'handles %s at the tool completion boundary without duplicate effects',
    async (fault) => {
      const path = await directory();
      const durable = fileSessionStore(path);
      let armed = false;
      let injected = 0;
      let effects = 0;
      const storage: SessionStore = {
        acquire: (...args) => durable.acquire(...args),
        read: (...args) => durable.read(...args),
        release: (...args) => durable.release(...args),
        commit: async (...args) => {
          if (armed && injected++ === 0) {
            if (fault === 'lost acknowledgment') await durable.commit(...args);
            throw new Error(`fixture ${fault}`);
          }
          await durable.commit(...args);
        },
      };
      const server = new ModelServer([
        [call('record', {}, { callId: 'fault-effect' })],
        ...(fault === 'lost acknowledgment' ? [[message('finished')]] : []),
      ]);
      const provider = await providerFor(server);
      const agent = new Agent({
        instructions: 'Use record.',
        model: 'gpt-5',
        provider,
        tools: [
          tool({
            name: 'record',
            description: 'Record once.',
            parameters: z.object({}),
            execute: () => {
              effects++;
              armed = true;
              return 'recorded';
            },
          }),
        ],
      });
      const session = await agent.session({ storage });
      const id = session.id;
      if (fault === 'lost acknowledgment') {
        expect(
          (await (await session.submit('Record.')).wait()).finalOutput,
        ).toBe('finished');
        await session.close();
      } else {
        await expect((await session.submit('Record.')).wait()).rejects.toThrow(
          /canonical storage operation failed/,
        );
        await expect(session.close()).rejects.toThrow(
          /canonical storage operation failed/,
        );
      }
      await provider.close();
      expect(effects).toBe(1);
      expect(injected).toBeGreaterThan(0);
      const reopenedProvider = await providerFor(server);
      const opening = new Agent({
        instructions: 'Use record.',
        model: 'gpt-5',
        provider: reopenedProvider,
      }).session({ storage: fileSessionStore(path), resume: id });
      if (fault === 'commit rejection') {
        await expect(opening).rejects.toThrow(/unknown|unresolved|reconcil/i);
        await reopenedProvider.close();
        expect(effects).toBe(1);
        server.assertExhausted();
        return;
      }
      const reopened = await opening;
      const restored = await history(reopened);
      expect(restored).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'function_call',
            callId: 'fault-effect',
          }),
        ]),
      );
      if (fault === 'lost acknowledgment')
        expect(restored).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'function_call_output',
              callId: 'fault-effect',
            }),
          ]),
        );
      await reopened.close();
      await reopenedProvider.close();
      expect(effects).toBe(1);
      server.assertExhausted();
    },
    30000,
  );
});
