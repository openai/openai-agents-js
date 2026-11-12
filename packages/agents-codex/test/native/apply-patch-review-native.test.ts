import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Agent,
  NativeProvider,
  applyPatchTool,
  isFunctionApprovalRequest,
  localStorage,
} from '../../src';
import { ModelServer, message } from './fixtures/model-server';
import type { JsonObject } from '../../src/runtime/binding';

afterEach(() => ModelServer.closeAll());

async function provider(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
}

function patchCall(): JsonObject {
  return {
    type: 'apply_patch_call',
    id: 'apc_native_edit',
    call_id: 'patch-1',
    status: 'completed',
    operation: { type: 'delete_file', path: 'application://owned' },
    future_provider_field: 'preserved',
  };
}

it.each(['completed', 'failed'] as const)(
  'retains a completed LocalStorage receipt with %s status across cold resume',
  async (status) => {
    const root = await mkdtemp(join(tmpdir(), 'native-patch-completed-'));
    let effects = 0;
    const edit = () => {
      effects++;
      return { status, output: 'authoritative editor result' };
    };
    const original = patchCall();
    const server = new ModelServer([
      [original],
      [message('first')],
      [message('continued')],
    ]);
    await using selected = await provider(server);
    const agent = new Agent({
      instructions: 'Use the application editor.',
      model: 'gpt-5',
      provider: selected,
      tools: [
        applyPatchTool({
          editor: { createFile: edit, updateFile: edit, deleteFile: edit },
        }),
      ],
    });
    const storage = localStorage(join(root, 'profile'));
    try {
      const source = await agent.session({ storage });
      const id = source.id;
      try {
        expect((await (await source.submit('edit')).wait()).finalOutput).toBe(
          'first',
        );
        expect(effects).toBe(1);
      } finally {
        await source.close();
      }
      await using restored = await agent.session({ storage, resume: id });
      expect(restored.id).toBe(id);
      expect(
        (await (await restored.submit('continue')).wait()).finalOutput,
      ).toBe('continued');
      expect(effects).toBe(1);
      const input = server.requests[2].input as JsonObject[];
      expect(input).toContainEqual(expect.objectContaining(original));
      expect(
        input.filter((item) => item.type === 'apply_patch_call_output'),
      ).toEqual([
        expect.objectContaining({
          call_id: 'patch-1',
          status,
          output: 'authoritative editor result',
        }),
      ]);
      server.assertExhausted();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function nextApproval(session: {
  interactions(): AsyncIterable<unknown>;
}) {
  for await (const event of session.interactions())
    if (isFunctionApprovalRequest(event)) return event;
  throw new Error('The turn ended without its required editor approval');
}

it.each([true, false])(
  'gates the native editor through its exact approval (approve=%s)',
  async (approve) => {
    let effects = 0;
    const edit = () => {
      effects++;
      return { output: 'one accepted edit' };
    };
    const server = new ModelServer([[patchCall()], [message('done')]]);
    await using selected = await provider(server);
    const agent = new Agent({
      instructions: 'Use the application editor.',
      model: 'gpt-5',
      provider: selected,
      tools: [
        applyPatchTool({
          editor: { createFile: edit, updateFile: edit, deleteFile: edit },
          needsApproval: approve
            ? true
            : (context) => {
                expect(context.callId).toBe('patch-1');
                return true;
              },
        }),
      ],
    });
    await using session = await agent.session();
    await using foreign = await agent.session();
    const turn = await session.submit('edit');
    const phase = await Promise.race([
      nextApproval(session).then((request) => ({
        kind: 'approval' as const,
        request,
      })),
      turn.wait().then(() => ({ kind: 'completed' as const })),
    ]);
    expect(phase.kind).toBe('approval');
    if (phase.kind !== 'approval')
      throw new Error('The editor bypassed approval');
    expect(effects).toBe(0);
    expect(server.requests).toHaveLength(1);
    expect(phase.request.callId).toBe('patch-1');
    expect(phase.request.turnId).toBe(turn.turnId);
    const reply = approve
      ? phase.request.approve()
      : phase.request.reject('application denied edit');
    await expect(foreign.respond(reply)).rejects.toThrow();
    await session.respond(reply);
    await expect(session.respond(reply)).rejects.toThrow();
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(effects).toBe(approve ? 1 : 0);
    expect(server.requests[0].tools).toContainEqual({ type: 'apply_patch' });
    expect(
      (server.requests[1].input as JsonObject[]).find(
        (item) => item.type === 'apply_patch_call_output',
      ),
    ).toMatchObject({
      call_id: 'patch-1',
      status: approve ? 'completed' : 'failed',
    });
    server.assertExhausted();
  },
);
