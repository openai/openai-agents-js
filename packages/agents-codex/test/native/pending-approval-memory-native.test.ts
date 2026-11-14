import { EnvironmentAcquisition } from '../../src/runtime/environment-source';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeProvider,
  isFunctionApprovalRequest,
  tool,
} from '../../src';
import { binding } from '../../src/runtime/binding';
import type { NativeThread } from '../../native/index';
import { Manifest, sandboxEnvironment } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents-core/sandbox/local';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => {
  vi.restoreAllMocks();
  return ModelServer.closeAll();
});
const secret = 'UNAPPROVED_ARGUMENT_98B617';
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-pending-memory',
    supportsWebsockets: false,
  });
}

it.each([
  'capture',
  'race',
  'graph',
  'before_admission',
  'after_admission',
] as const)(
  'keeps pending approval authority during memory %s',
  async (mode) => {
    const peer = await startPublicExecutor();
    const sourceServer = new ModelServer([
      [call('risky', { value: secret }, { callId: 'pending-memory' })],
      [message('done')],
    ]);
    const memoryServer = new ModelServer([
      [
        message(
          JSON.stringify({
            rollout_summary: 'Approval interrupted.',
            rollout_slug: 'pending',
            raw_memory: 'No approved effect.',
          }),
        ),
      ],
      [
        message(
          JSON.stringify({
            summary: 'No approved effect.',
            memory: 'No approved effect.',
          }),
        ),
      ],
    ]);
    await using sourceProvider = await providerFor(sourceServer);
    await using memoryProvider = await providerFor(memoryServer);
    const files = new Map<string, Uint8Array>();
    const writeEntered = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    let firstWrite = true;
    const store = {
      read: async (path: string) => files.get(path) ?? null,
      write: async (path: string, value: Uint8Array) => {
        if (mode === 'after_admission' && firstWrite) {
          firstWrite = false;
          writeEntered.resolve();
          await releaseWrite.promise;
        }
        files.set(path, value.slice());
      },
      delete: async (path: string) => {
        files.delete(path);
      },
      list: async (prefix: string) =>
        [...files.keys()].filter((path) => path.startsWith(prefix)),
    };
    const environment = sandboxEnvironment({
      client: new UnixLocalSandboxClient(),
      manifest: new Manifest({ entries: {} }),
      memory: {
        phaseOne: new Agent({
          provider: memoryProvider,
          model: 'gpt-5.5',
          instructions: 'Extract.',
        }),
        phaseTwo: new Agent({
          provider: memoryProvider,
          model: 'gpt-5.5',
          instructions: 'Consolidate.',
        }),
        store,
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
    let effects = 0;
    const target = new Agent({ name: 'Other', instructions: 'Other.' });
    const agent = new Agent({
      provider: sourceProvider,
      model: 'gpt-5.5',
      instructions: 'Use risky.',
      ...(mode === 'graph' ? { handoffs: [target] } : {}),
      tools: [
        tool({
          name: 'risky',
          parameters: z.object({ value: z.string() }),
          needsApproval: true,
          execute: ({ value }) => {
            effects++;
            return value;
          },
        }),
      ],
    });
    try {
      await using session = await agent.session({ environment });
      const turn = await session.submit('begin');
      const interactions = session.interactions()[Symbol.asyncIterator]();
      const next = await interactions.next();
      if (next.done || !isFunctionApprovalRequest(next.value))
        throw Error('Missing live function approval');
      const approval = next.value;
      const prototype = (await binding()).NativeThread.prototype;
      const original = prototype._pending_memory_history;
      const owners: NativeThread[] = [];
      let receipt: string | undefined;
      let revision: string | undefined;
      const capture = vi
        .spyOn(prototype, '_pending_memory_history')
        .mockImplementation(async function (
          this: NativeThread,
          json: string,
          scope,
        ) {
          owners.push(this);
          receipt = json;
          const result = await original.call(this, json, scope);
          revision = JSON.parse(result).revision;
          if (mode === 'race')
            await session.respond(approval.reject('race denial'));
          return result;
        });
      await expect(session.historySnapshot()).rejects.toThrow();
      if (mode === 'capture' || mode === 'graph') {
        await session.flushMemory();
        expect(capture).toHaveBeenCalledTimes(1);
        expect(memoryServer.requests).toHaveLength(2);
        const path = [...files.keys()].find((path) => path.endsWith('.jsonl'))!;
        const raw = new TextDecoder().decode((await store.read(path))!);
        const data = JSON.parse(raw);
        expect(data.terminal_metadata.terminal_state).toBe('interrupted');
        expect(data.terminal_metadata.native_history_revision).toBe(revision);
        expect(data.terminal_metadata.has_final_output).toBe(false);
        expect(
          data.items.every(
            (item: Record<string, unknown>) => !('arguments' in item),
          ),
        ).toBe(true);
        for (const value of [
          raw,
          JSON.stringify(memoryServer.requests[0].input),
        ]) {
          expect(value).not.toContain(secret);
          expect(value).not.toContain('_sdk_python_tool');
          expect(value).not.toContain('manual_grant');
        }
        await session.flushMemory();
        expect(memoryServer.requests).toHaveLength(2);
        await session.respond(approval.reject('denial after export'));
        expect((await turn.wait()).finalOutput).toBe('done');
        expect(effects).toBe(0);
        await expect(original.call(owners[0], receipt!)).rejects.toThrow();
        await using foreign = await new Agent({
          provider: sourceProvider,
          model: 'gpt-5.5',
          instructions: 'Other root.',
        }).session();
        const forged = JSON.parse(receipt!);
        forged._sdk_python_tool.thread = foreign.id;
        await expect(
          original.call(owners[0], JSON.stringify(forged)),
        ).rejects.toThrow();
        await session.close();
        const cold = new TextDecoder().decode((await store.read(path))!);
        expect(cold).toBe(raw);
        expect(cold).not.toContain(secret);
      } else if (mode === 'before_admission') {
        const entered = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        const flush = EnvironmentAcquisition.prototype.flushMemory;
        vi.spyOn(
          EnvironmentAcquisition.prototype,
          'flushMemory',
        ).mockImplementation(async function (
          this: EnvironmentAcquisition,
          ...args
        ) {
          entered.resolve();
          await released.promise;
          return flush.apply(this, args);
        });
        const pending = session.flushMemory();
        let failed = false;
        try {
          await entered.promise;
          expect(capture).toHaveBeenCalledTimes(1);
          expect(files.size).toBe(0);
          expect(memoryServer.requests).toHaveLength(0);
          await session.respond(approval.reject('settled at resource handoff'));
          expect((await turn.wait()).finalOutput).toBe('done');
          expect(effects).toBe(0);
          released.resolve();
          await pending.catch(() => {
            failed = true;
          });
          expect({
            rejected: failed,
            writes: files.size,
            memoryRequests: memoryServer.requests.length,
          }).toEqual({ rejected: true, writes: 0, memoryRequests: 0 });
        } finally {
          released.resolve();
          await pending.catch(() => {});
        }
      } else if (mode === 'after_admission') {
        const nativeCheck = prototype._check_python_tool;
        const checks = vi
          .spyOn(prototype, '_check_python_tool')
          .mockImplementation(function (this: NativeThread, request) {
            return nativeCheck.call(this, request);
          });
        const pending = session.flushMemory();
        try {
          await writeEntered.promise;
          expect(files.size).toBe(0);
          expect(memoryServer.requests).toHaveLength(0);
          expect(checks).toHaveBeenCalledTimes(1);
          const checked = JSON.parse(checks.mock.calls[0][0]);
          const sampled = JSON.parse(receipt!);
          expect(checked._sdk_python_tool).toEqual(sampled._sdk_python_tool);
          expect(checked.callId).toBe(sampled.callId);
          expect(checked.turnId).toBe(sampled.turnId);
          await session.respond(
            approval.reject('settled after memory IO admission'),
          );
          expect((await turn.wait()).finalOutput).toBe('done');
          expect(effects).toBe(0);
          releaseWrite.resolve();
          await pending;
          expect(memoryServer.requests).toHaveLength(2);
          expect(files.size).toBeGreaterThan(0);
        } finally {
          releaseWrite.resolve();
          await pending.catch(() => {});
        }
      } else {
        await expect(async () => session.flushMemory()).rejects.toThrow(
          'expired',
        );
        expect(memoryServer.requests).toHaveLength(0);
        expect(files.size).toBe(0);
        expect((await turn.wait()).finalOutput).toBe('done');
        expect(effects).toBe(0);
      }
      expect(sourceServer.requests).toHaveLength(2);
    } finally {
      await peer.close();
    }
  },
  30_000,
);
