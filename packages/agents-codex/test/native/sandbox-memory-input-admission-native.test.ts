import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Agent,
  Environment,
  NativeProvider,
  parseSessionState,
  TurnAborted,
  type Session,
} from '../../src';
import { binding, type NativeThread } from '../../src/runtime/binding';
import {
  Manifest,
  sandboxEnvironment,
  normalizeSandboxClientCreateArgs,
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents-core/sandbox/local';
import { ModelServer, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

it
  .skipIf(process.platform === 'win32')
  .each([
    'live',
    'restore',
    'fork',
    'failed-write',
    'missing-write',
    'held-write-stop',
    'tampered',
  ] as const)(
  'keeps unproven source input out of memory across %s',
  async (route) => {
    const missingProof = route === 'failed-write' || route === 'missing-write';
    const heldStop = route === 'held-write-stop';
    const writeEntered = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    const base = await mkdtemp(join(tmpdir(), 'memory-input-proof-'));
    const workspace = join(base, 'workspace');
    await mkdir(workspace);
    const peer = await startPublicExecutor();
    const guardEntered = Promise.withResolvers<void>();
    const frameSent = Promise.withResolvers<void>();
    const releaseGuard = Promise.withResolvers<void>();
    const originalFailure = new Error('original source refusal');
    const writeFailure = new Error('synthetic memory admission write failure');
    const rejectedInput = 'private unapproved source input';
    const rejectedAnswer = 'private unapproved derived answer';
    const acceptedInput = 'fresh approved project input';
    let rejected = false;
    const server = new ModelServer([
      [message(rejectedAnswer)],
      ...(heldStop ? [] : [[message('Fresh approved source answer.')]]),
      [
        message(
          JSON.stringify({
            rollout_summary: 'Approved source',
            rollout_slug: 'approved-source',
            raw_memory: 'Approved project input.',
          }),
        ),
      ],
      [
        message(
          JSON.stringify({
            summary: 'Approved project input.',
            memory: 'Approved project input.',
          }),
        ),
      ],
    ]);
    server.onRecord = (phase) => {
      if (phase === 'MODEL_COMPLETED_FRAME') frameSent.resolve();
    };
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-provider',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      provider,
      model: 'gpt-5',
      instructions: 'Use approved input.',
      ...(heldStop
        ? {}
        : missingProof
          ? {
              beforeComplete: () => {
                if (!rejected) {
                  rejected = true;
                  throw originalFailure;
                }
              },
            }
          : {
              inputGuardrails: [
                {
                  name: 'held-input-check',
                  runInParallel: true,
                  callback: async () => {
                    if (rejected) return { tripwireTriggered: false };
                    guardEntered.resolve();
                    await releaseGuard.promise;
                    rejected = true;
                    throw originalFailure;
                  },
                },
              ],
            }),
    });
    const source = () => {
      const client = new UnixLocalSandboxClient({
        resumeAuthority: {
          workspaceRootPath: workspace,
          workspaceRootOwned: false,
        },
      });
      client.create = async (args) =>
        client.resume({
          manifest: normalizeSandboxClientCreateArgs(args).manifest,
          workspaceRootPath: workspace,
          workspaceRootOwned: false,
          environment: {},
        });
      return sandboxEnvironment({
        client,
        manifest: new Manifest({ root: workspace }),
        memory: {
          phaseOne: new Agent({
            provider,
            model: 'gpt-5',
            instructions: 'Extract approved memory.',
          }),
          phaseTwo: new Agent({
            provider,
            model: 'gpt-5',
            instructions: 'Consolidate approved memory.',
          }),
        },
        connect: async (resource) =>
          Environment.lease(
            new Environment({
              url: peer.url,
              headers: peer.headers,
              cwd: resource.state.workspaceRootPath,
              tools: [],
            }),
            async () => {},
          ),
      });
    };
    let original: Session | undefined;
    let current: Session | undefined;
    let restoreSpy: (() => void) | undefined;
    try {
      if (missingProof || heldStop) {
        const native = await binding();
        const record =
          native.NativeThread.prototype._record_memory_input_admission;
        const spy = vi.spyOn(
          native.NativeThread.prototype,
          '_record_memory_input_admission',
        );
        if (heldStop) {
          spy.mockImplementationOnce(async function (
            this: NativeThread,
            turnId: string,
          ) {
            writeEntered.resolve();
            await releaseWrite.promise;
            return record.call(this, turnId);
          });
        } else if (route === 'failed-write')
          spy.mockRejectedValueOnce(writeFailure);
        else spy.mockResolvedValueOnce(undefined);
        restoreSpy = () => spy.mockRestore();
      }
      original = await agent.session({ environment: source() });
      const turn = await original.submit(rejectedInput);
      const result = turn.wait();
      void result.catch(() => {});
      if (heldStop) {
        await writeEntered.promise;
        const stopping = turn.cancel();
        releaseWrite.resolve();
        await stopping;
        const failure = await result.catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(TurnAborted);
        await original.flushMemory();
        const transcript = await readFile(
          join(workspace, 'sessions', `${original.id}.jsonl`),
          'utf8',
        );
        expect(JSON.parse(transcript).terminal_metadata).toMatchObject({
          terminal_state: 'cancelled',
          exception_type: 'TurnAborted',
          has_final_output: false,
        });
        expect(server.requests).toHaveLength(3);
        server.assertExhausted();
        return;
      }
      if (!missingProof) {
        await guardEntered.promise;
        await frameSent.promise;
        releaseGuard.resolve();
      }
      await expect(result).rejects.toBe(originalFailure);
      if (route === 'failed-write')
        await expect(original.flushMemory()).rejects.toBe(writeFailure);
      else if (route === 'missing-write')
        await expect(original.flushMemory()).rejects.toThrow(
          /proven input admission/,
        );
      else await expect(original.flushMemory()).rejects.toBe(originalFailure);
      restoreSpy?.();
      restoreSpy = undefined;
      expect(server.requests).toHaveLength(1);
      await expect(
        readFile(join(workspace, 'sessions', `${original.id}.jsonl`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        JSON.stringify((await original.historySnapshot()).items),
      ).toContain(rejectedInput);
      if (route === 'live') current = original;
      else {
        let state =
          route === 'fork' ? await original.fork() : await original.saveState();
        if (route === 'tampered') {
          const forged = JSON.parse(JSON.stringify(state));
          let marked = 0;
          for (const item of forged.history) {
            if (
              item.type === 'turn_context' &&
              item.payload.turn_id === turn.turnId &&
              item.payload.sdk_receipt
            ) {
              item.payload.sdk_receipt.sandbox_memory_input_admitted = true;
              marked++;
            }
          }
          expect(marked).toBeGreaterThan(0);
          state = parseSessionState(JSON.stringify(forged));
        }
        await original.close();
        current = await agent.session({ state, environment: source() });
      }
      expect(JSON.stringify((await current.historySnapshot()).items)).toContain(
        rejectedInput,
      );
      expect(
        (await (await current.submit(acceptedInput)).wait()).finalOutput,
      ).toBe('Fresh approved source answer.');
      await Promise.all([current.flushMemory(), current.flushMemory()]);
      await current.flushMemory();
      const transcript = await readFile(
        join(workspace, 'sessions', `${current.id}.jsonl`),
        'utf8',
      );
      expect(transcript.trim().split('\n')).toHaveLength(1);
      expect(transcript).toContain(acceptedInput);
      expect(transcript).not.toContain(rejectedInput);
      expect(transcript).not.toContain(rejectedAnswer);
      const extraction = JSON.stringify(server.requests.slice(2));
      expect(extraction).not.toContain(rejectedInput);
      expect(extraction).not.toContain(rejectedAnswer);
      expect(JSON.stringify((await current.historySnapshot()).items)).toContain(
        rejectedInput,
      );
      expect(server.requests).toHaveLength(4);
      server.assertExhausted();
    } finally {
      releaseGuard.resolve();
      releaseWrite.resolve();
      restoreSpy?.();
      await current?.close();
      await original?.close();
      await peer.close();
      await rm(base, { recursive: true, force: true });
    }
  },
  30_000,
);
