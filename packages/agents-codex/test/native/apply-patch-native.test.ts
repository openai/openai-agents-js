import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  NativeProvider,
  applyPatchTool,
  toolRef,
  type ApplyPatchEditor,
  type ApplyPatchOperation,
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
function call(operation: JsonObject): JsonObject {
  return {
    type: 'apply_patch_call',
    id: 'apc_item',
    call_id: 'patch-1',
    status: 'completed',
    operation,
    future_provider_field: 'preserved',
  };
}
for (const operation of [
  { type: 'create_file', path: 'application://custom', diff: 'create' },
  {
    type: 'update_file',
    path: '../application-owned',
    diff: 'update',
    move_to: 'outside-custom',
  },
  { type: 'delete_file', path: '/application-owned' },
] as JsonObject[])
  for (const status of ['completed', 'failed'] as const) {
    it(`routes native ${operation.type} with ${status} disposition`, async () => {
      const calls: ApplyPatchOperation[] = [];
      const edit = (op: ApplyPatchOperation) => {
        calls.push(op);
        return { status, output: 'editor receipt' };
      };
      const editor: ApplyPatchEditor = {
        createFile: edit,
        updateFile: edit,
        deleteFile: edit,
      };
      const original = call(operation);
      const server = new ModelServer([[original], [message('done')]]);
      await using selected = await provider(server);
      const agent = new Agent({
        instructions: 'Use the editor.',
        model: 'gpt-5',
        provider: selected,
        modelSettings: { toolChoice: toolRef('apply_patch') },
        tools: [applyPatchTool({ editor })],
      });
      expect((await agent.run('edit')).finalOutput).toBe('done');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(
        operation.type === 'update_file'
          ? {
              type: 'update_file',
              path: operation.path,
              diff: operation.diff,
              moveTo: operation.move_to,
            }
          : operation,
      );
      expect(server.requests[0].tools).toContainEqual({ type: 'apply_patch' });
      const input = server.requests[1].input as JsonObject[];
      expect(
        input.find((item) => item.type === 'apply_patch_call'),
      ).toMatchObject(original);
      expect(
        input.find((item) => item.type === 'apply_patch_call_output'),
      ).toMatchObject({ call_id: 'patch-1', status, output: 'editor receipt' });
      expect(
        input.filter(
          (item) =>
            item.type === 'function_call_output' && item.call_id === 'patch-1',
        ),
      ).toEqual([]);
      expect(server.requests).toHaveLength(2);
    });
  }
it('restores the accepted native receipt without replaying its editor', async () => {
  let effects = 0;
  const edit = () => {
    effects++;
    return { output: 'once' };
  };
  const server = new ModelServer([
    [call({ type: 'delete_file', path: 'owned' })],
    [message('first')],
    [message('continued')],
  ]);
  await using selected = await provider(server);
  const agent = new Agent({
    instructions: 'Use editor.',
    model: 'gpt-5',
    provider: selected,
    tools: [
      applyPatchTool({
        editor: { createFile: edit, updateFile: edit, deleteFile: edit },
      }),
    ],
  });
  const source = await agent.session();
  let state;
  try {
    expect((await (await source.submit('edit')).wait()).finalOutput).toBe(
      'first',
    );
    state = JSON.parse(JSON.stringify(await source.saveState()));
  } finally {
    await source.close();
  }
  const restored = await agent.session({ state });
  try {
    expect((await (await restored.submit('continue')).wait()).finalOutput).toBe(
      'continued',
    );
  } finally {
    await restored.close();
  }
  expect(effects).toBe(1);
  expect(server.requests).toHaveLength(3);
  expect(
    (server.requests[2].input as JsonObject[]).find(
      (item) => item.type === 'apply_patch_call_output',
    ),
  ).toMatchObject({ call_id: 'patch-1', status: 'completed', output: 'once' });
});
it('refuses a function-shaped masquerade before editor entry', async () => {
  let effects = 0;
  const edit = () => {
    effects++;
  };
  const server = new ModelServer([
    [
      {
        type: 'function_call',
        id: 'fc_fake',
        call_id: 'forged',
        name: 'apply_patch',
        arguments: JSON.stringify(call({ type: 'delete_file', path: 'owned' })),
      },
    ],
    [message('safe')],
  ]);
  await using selected = await provider(server);
  const agent = new Agent({
    instructions: 'Use editor.',
    model: 'gpt-5',
    provider: selected,
    tools: [
      applyPatchTool({
        editor: { createFile: edit, updateFile: edit, deleteFile: edit },
      }),
    ],
  });
  await agent.run('edit').catch(() => undefined);
  expect(effects).toBe(0);
});

it('retains an unresolved accepted LocalStorage edit after process loss', async () => {
  const { fork } = await import('node:child_process');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { LocalRecoveryRequired, localStorage } = await import('../../src');
  const root = await mkdtemp(join(tmpdir(), 'native-apply-patch-'));
  const server = new ModelServer([
    [call({ type: 'create_file', path: 'application-owned', diff: 'd' })],
  ]);
  await using selected = await provider(server);
  const child = fork(
    fileURLToPath(
      new URL('./fixtures/apply-patch-loss-worker.ts', import.meta.url),
    ),
    [JSON.stringify({ url: selected.baseUrl, root })],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  let opened: string | undefined,
    stderr = '';
  child.on('message', (value) => {
    opened = (value as { opened: string }).opened;
  });
  child.stderr?.on('data', (value) => {
    stderr += String(value);
  });
  try {
    const code = await new Promise<number | null>((resolve) =>
      child.once('exit', resolve),
    );
    expect(code, stderr).toBe(67);
    expect(opened).toBeTruthy();
    let effects = 0;
    const edit = () => {
      effects++;
    };
    const agent = new Agent({
      instructions: 'Use editor.',
      model: 'gpt-5',
      provider: selected,
      tools: [
        applyPatchTool({
          editor: { createFile: edit, updateFile: edit, deleteFile: edit },
        }),
      ],
    });
    let failure: unknown;
    try {
      const session = await agent.session({
        storage: localStorage(join(root, 'profile')),
        resume: opened,
      });
      await session.close();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(LocalRecoveryRequired);
    const uncertain = (failure as InstanceType<typeof LocalRecoveryRequired>)
      .calls;
    expect(uncertain).toHaveLength(1);
    expect(uncertain[0]).toMatchObject({
      name: 'apply_patch',
      callId: 'patch-1',
    });
    expect(JSON.parse(uncertain[0].arguments)).toMatchObject({
      type: 'apply_patch_call',
      call_id: 'patch-1',
      operation: { type: 'create_file', path: 'application-owned', diff: 'd' },
      future_provider_field: 'preserved',
    });
    expect(effects).toBe(0);
    expect(await readFile(join(root, 'effects'), 'utf8')).toBe(
      'one editor effect\n',
    );
    expect(server.requests).toHaveLength(1);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
