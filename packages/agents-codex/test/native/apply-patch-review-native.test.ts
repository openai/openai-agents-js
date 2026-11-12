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
  parseSessionState,
  tool,
} from '../../src';
import { ModelServer, message } from './fixtures/model-server';
import type { JsonObject } from '../../src/runtime/binding';
import { z } from 'zod';

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
  'restores a pending typed patch approval with the current editor (approve=%s)',
  async (approve) => {
    const effects: unknown[] = [];
    const sourceEdit = () => {
      throw new Error('Source editor must not run');
    };
    const currentEdit = (operation: unknown) => {
      effects.push(operation);
      return { status: 'completed' as const, output: 'current editor result' };
    };
    const original = patchCall();
    const server = new ModelServer([
      [original],
      [message('restored')],
      [message('continued')],
    ]);
    await using selected = await provider(server);
    const createAgent = (edit: typeof currentEdit) =>
      new Agent({
        instructions: 'Use the application editor.',
        model: 'gpt-5',
        provider: selected,
        tools: [
          applyPatchTool({
            editor: { createFile: edit, updateFile: edit, deleteFile: edit },
            needsApproval: true,
          }),
        ],
      });
    let state;
    let sourceReply;
    {
      await using source = await createAgent(sourceEdit).session();
      await source.submit('edit');
      sourceReply = (await nextApproval(source)).approve();
      expect(effects).toEqual([]);
      state = parseSessionState(JSON.stringify(await source.suspend()));
    }
    await using restored = await createAgent(currentEdit).session({ state });
    const request = await nextApproval(restored);
    expect(request.callId).toBe('patch-1');
    expect(effects).toEqual([]);
    expect(server.requests).toHaveLength(1);
    await expect(restored.respond(sourceReply)).rejects.toThrow();
    const reply = approve
      ? request.approve()
      : request.reject('current refused edit');
    await restored.respond(reply);
    await expect(restored.respond(reply)).rejects.toThrow();
    expect((await restored.restoredTurn!.wait()).finalOutput).toBe('restored');
    expect(effects).toEqual(approve ? [original.operation] : []);
    expect(
      (server.requests[1].input as JsonObject[]).filter(
        (item) => item.type === 'apply_patch_call_output',
      ),
    ).toEqual([
      expect.objectContaining({
        call_id: 'patch-1',
        status: approve ? 'completed' : 'failed',
        output: approve ? 'current editor result' : 'current refused edit',
      }),
    ]);
    const settled = parseSessionState(
      JSON.stringify(await restored.saveState()),
    );
    await using replay = await createAgent(currentEdit).session({
      state: settled,
    });
    expect((await (await replay.submit('continue')).wait()).finalOutput).toBe(
      'continued',
    );
    expect(effects).toEqual(approve ? [original.operation] : []);
    expect(
      (server.requests[2].input as JsonObject[]).filter(
        (item) => item.type === 'apply_patch_call_output',
      ),
    ).toHaveLength(1);
    server.assertExhausted();
  },
);

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

it.each(['declaration', 'operation', 'effective_operation'] as const)(
  'refuses a changed pending patch %s before editor execution',
  async (changed) => {
    let effects = 0;
    const execute = () => {
      effects++;
      throw new Error('Editor must not run');
    };
    const server = new ModelServer([[patchCall()]]);
    await using selected = await provider(server);
    const instructions = 'Use the application editor.';
    const agent = new Agent({
      instructions,
      model: 'gpt-5',
      provider: selected,
      tools: [
        applyPatchTool({
          editor: {
            createFile: execute,
            updateFile: execute,
            deleteFile: execute,
          },
          needsApproval: true,
        }),
      ],
    });
    let raw;
    {
      await using source = await agent.session();
      await source.submit('edit');
      await nextApproval(source);
      raw = JSON.parse(JSON.stringify(await source.suspend()));
    }
    let current = agent;
    if (changed === 'declaration') {
      current = new Agent({
        instructions,
        model: 'gpt-5',
        provider: selected,
        tools: [
          tool({ name: 'apply_patch', parameters: z.object({}), execute }),
        ],
      });
    } else {
      const pending = raw.manual_continuation.pending_manual[0];
      const field =
        changed === 'operation' ? 'arguments' : 'effective_arguments';
      const call = JSON.parse(pending[field] ?? pending.arguments);
      call.operation.path = 'application://changed';
      pending[field] = JSON.stringify(call);
    }
    await expect(
      current.session({ state: parseSessionState(JSON.stringify(raw)) }),
    ).rejects.toThrow();
    expect(server.requests).toHaveLength(1);
    expect(effects).toBe(0);
    server.assertExhausted();
  },
);

it('retains an accepted typed patch without output beside the pending approval', async () => {
  const effects: string[] = [];
  const first = {
    ...patchCall(),
    call_id: 'patch-first',
    operation: { type: 'delete_file', path: 'application://first' },
  };
  const second = {
    ...patchCall(),
    call_id: 'patch-second',
    operation: { type: 'delete_file', path: 'application://second' },
  };
  const server = new ModelServer([[first, second], [message('both settled')]]);
  await using selected = await provider(server);
  const editor = (label: string) => {
    const edit = (operation: { path: string }) => {
      effects.push(`${label}:${operation.path}`);
    };
    return new Agent({
      instructions: 'Use the application editor.',
      model: 'gpt-5',
      provider: selected,
      tools: [
        applyPatchTool({
          editor: { createFile: edit, updateFile: edit, deleteFile: edit },
          needsApproval: (context) => context.callId === 'patch-second',
        }),
      ],
    });
  };
  let state;
  {
    await using source = await editor('source').session();
    await source.submit('edit twice');
    const request = await nextApproval(source);
    expect(request.callId).toBe('patch-second');
    state = parseSessionState(JSON.stringify(await source.suspend()));
  }
  expect(effects).toEqual(['source:application://first']);
  await using restored = await editor('current').session({ state });
  const request = await nextApproval(restored);
  expect(request.callId).toBe('patch-second');
  await restored.respond(request.approve());
  expect((await restored.restoredTurn!.wait()).finalOutput).toBe(
    'both settled',
  );
  expect(effects).toEqual([
    'source:application://first',
    'current:application://second',
  ]);
  const outputs = (server.requests[1].input as JsonObject[]).filter(
    (item) => item.type === 'apply_patch_call_output',
  );
  expect(outputs.map((item) => [item.call_id, item.status])).toEqual([
    ['patch-first', 'completed'],
    ['patch-second', 'completed'],
  ]);
  server.assertExhausted();
});
