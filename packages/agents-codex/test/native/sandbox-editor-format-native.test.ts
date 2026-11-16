import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Manifest, file, sandboxEnvironment } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents-core/sandbox/local';
import {
  Agent,
  Environment,
  NativeProvider,
  localStorage,
  applyPatchTool,
  isFunctionApprovalRequest,
  tool,
  type ApplyPatchEditor,
  type ApplyPatchOperation,
  type PatchFormat,
  type ToolCallContext,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';
import type { JsonObject } from '../../src/runtime/binding';

let peer: Awaited<ReturnType<typeof startPublicExecutor>>;
beforeAll(async () => {
  peer = await startPublicExecutor();
});
afterAll(async () => {
  await peer.close();
});
afterEach(() => ModelServer.closeAll());
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-format',
    supportsWebsockets: false,
  });
}
function patch(id: string, operation: JsonObject): JsonObject {
  return { type: 'apply_patch_call', id: `apc_${id}`, call_id: id, operation };
}
function resource(
  label: string,
  roots: Map<string, string>,
  readOnly = false,
  onClose?: () => Promise<void>,
) {
  return sandboxEnvironment({
    client: new UnixLocalSandboxClient(),
    manifest: new Manifest({
      entries: {
        'target.txt': file({ content: 'before' }),
        'moved.txt': file({ content: label }),
      },
    }),
    connect: async ({ state }) => {
      roots.set(label, state.workspaceRootPath);
      return Environment.lease(
        new Environment({
          url: peer.url,
          headers: peer.headers,
          cwd: state.workspaceRootPath,
          tools: [],
          readOnly,
        }),
        async () => {
          await onClose?.();
        },
      );
    },
  });
}
function managed(
  format: PatchFormat,
  retain?: (editor: ApplyPatchEditor, context: ToolCallContext) => void,
): ApplyPatchEditor {
  const edit = (
    method: keyof ApplyPatchEditor,
    operation: ApplyPatchOperation,
    context: ToolCallContext,
  ) => {
    const editor = context.sandbox!.createEditor({ format });
    retain?.(editor, context);
    return editor[method](operation, context);
  };
  return {
    createFile: (op, ctx) => edit('createFile', op, ctx),
    updateFile: (op, ctx) => edit('updateFile', op, ctx),
    deleteFile: (op, ctx) => edit('deleteFile', op, ctx),
  };
}

it('uses a custom managed format only on the selected child resource and revokes a saved editor', async () => {
  const roots = new Map<string, string>();
  const calls: Array<{ input: string; mode: string }> = [];
  let saved: { editor: ApplyPatchEditor; context: ToolCallContext } | undefined;
  const format: PatchFormat = {
    applyDiff(input, diff, mode = 'default') {
      calls.push({ input, mode });
      const edit = JSON.parse(diff) as { value?: string; append?: string };
      return mode === 'create' ? edit.value! : input + edit.append;
    },
  };
  const server = new ModelServer([
    [call('transfer_to_child', {}, { callId: 'to_child' })],
    [
      call(
        'edit',
        {
          type: 'create_file',
          path: 'custom.txt',
          diff: JSON.stringify({ value: 'child-created' }),
        },
        { callId: 'create' },
      ),
    ],
    [
      call(
        'edit',
        {
          type: 'update_file',
          path: 'custom.txt',
          moveTo: 'moved.txt',
          diff: JSON.stringify({ append: '-updated' }),
        },
        { callId: 'update' },
      ),
    ],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  const child = new Agent({
    name: 'child',
    model: 'gpt-5.5',
    provider,
    instructions: 'Use the custom JSON patch format.',
    environment: resource('child', roots),
    tools: [
      tool({
        name: 'edit',
        parameters: z.object({
          type: z.enum(['create_file', 'update_file']),
          path: z.string(),
          diff: z.string(),
          moveTo: z.string().optional(),
        }),
        execute: async (operation, context) => {
          const editor = context.sandbox!.createEditor({ format });
          saved = { editor, context };
          if (operation.type === 'create_file')
            await editor.createFile(operation, context);
          else await editor.updateFile(operation, context);
          return 'edited';
        },
      }),
    ],
  });
  const root = new Agent({
    model: 'gpt-5.5',
    provider,
    instructions: 'Transfer to child.',
    handoffs: [child],
  });
  await using session = await root.session({
    environment: resource('root', roots),
  });
  expect((await (await session.submit('edit')).wait()).finalOutput).toBe(
    'done',
  );
  expect(calls).toEqual([
    { input: '', mode: 'create' },
    { input: 'child-created', mode: 'default' },
  ]);
  expect(await readFile(join(roots.get('child')!, 'moved.txt'), 'utf8')).toBe(
    'child-created-updated',
  );
  expect(await readFile(join(roots.get('root')!, 'moved.txt'), 'utf8')).toBe(
    'root',
  );
  await expect(
    saved!.editor.deleteFile(
      { type: 'delete_file', path: 'moved.txt' },
      saved!.context,
    ),
  ).rejects.toThrow();
  expect(await readFile(join(roots.get('child')!, 'moved.txt'), 'utf8')).toBe(
    'child-created-updated',
  );
  server.assertExhausted();
}, 60_000);

it.each(['read-only', 'outside-source', 'outside-destination'] as const)(
  'rejects %s before invoking a managed format',
  async (mode) => {
    const roots = new Map<string, string>();
    let formats = 0;
    const format: PatchFormat = {
      applyDiff() {
        formats++;
        return 'must not write';
      },
    };
    const operation: JsonObject = {
      type: 'update_file',
      path: mode === 'outside-source' ? '../outside.txt' : 'target.txt',
      diff: 'custom',
      ...(mode === 'outside-destination' ? { move_to: '../outside.txt' } : {}),
    };
    const server = new ModelServer([[patch('denied', operation)]]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Use the editor.',
      tools: [applyPatchTool({ editor: managed(format) })],
    });
    await using session = await agent.session({
      environment: resource('source', roots, mode === 'read-only'),
    });
    await expect((await session.submit('edit')).wait()).rejects.toThrow();
    expect(formats).toBe(0);
    expect(
      await readFile(join(roots.get('source')!, 'target.txt'), 'utf8'),
    ).toBe('before');
    expect(server.requests).toHaveLength(1);
  },
  60_000,
);

it('reviews the native operation before a managed formatter enters', async () => {
  const roots = new Map<string, string>();
  let formats = 0;
  const format: PatchFormat = {
    applyDiff(input) {
      formats++;
      return input + '-reviewed';
    },
  };
  const server = new ModelServer([
    [
      patch('review', {
        type: 'update_file',
        path: 'target.txt',
        diff: 'custom',
      }),
    ],
    [message('reviewed')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Use the editor.',
    tools: [applyPatchTool({ editor: managed(format), needsApproval: true })],
  }).session({ environment: resource('source', roots) });
  const turn = await session.submit('edit');
  for await (const request of session.interactions()) {
    if (isFunctionApprovalRequest(request)) {
      expect(formats).toBe(0);
      expect(
        await readFile(join(roots.get('source')!, 'target.txt'), 'utf8'),
      ).toBe('before');
      await session.respond(request.approve());
      break;
    }
  }
  expect((await turn.wait()).finalOutput).toBe('reviewed');
  expect(formats).toBe(1);
  expect(await readFile(join(roots.get('source')!, 'target.txt'), 'utf8')).toBe(
    'before-reviewed',
  );
}, 60_000);

it('revokes a managed editor on callback cancellation and joins its resource', async () => {
  const roots = new Map<string, string>();
  let formats = 0;
  let releases = 0;
  let retained = '';
  const format: PatchFormat = {
    applyDiff() {
      formats++;
      return 'late mutation';
    },
  };
  const server = new ModelServer([
    [call('edit', {}, { callId: 'cancel' })],
    [message('cancelled safely')],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Use the editor.',
    tools: [
      tool({
        name: 'edit',
        parameters: z.object({}),
        callbackTimeout: 0.02,
        timeoutBehavior: 'error_as_result',
        execute: async (_input, context) => {
          const editor = context.sandbox!.createEditor({ format });
          if (!context.signal.aborted)
            await new Promise<void>((resolve) =>
              context.signal.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            );
          await expect(
            editor.updateFile(
              { type: 'update_file', path: 'target.txt', diff: 'custom' },
              context,
            ),
          ).rejects.toBe(context.signal.reason);
          return 'cancelled';
        },
      }),
    ],
  });
  const result = await agent.run('edit', {
    environment: resource('source', roots, false, async () => {
      retained = await readFile(
        join(roots.get('source')!, 'target.txt'),
        'utf8',
      );
      releases++;
    }),
  });
  expect(result.finalOutput).toBe('cancelled safely');
  expect(formats).toBe(0);
  expect(retained).toBe('before');
  expect(releases).toBe(1);
}, 60_000);

it.each(['editor', 'plain-source', 'plain-environment'] as const)(
  'has been rebinding the public selected-child editor after settled durable resume (%s)',
  async (mode) => {
    const home = await mkdtemp(join(tmpdir(), 'sdk-editor-cold-'));
    const client = new UnixLocalSandboxClient();
    const manifests = [
      new Manifest({
        entries: { 'target.txt': file({ content: 'root-before' }) },
      }),
      new Manifest({
        entries: { 'target.txt': file({ content: 'child-before' }) },
      }),
    ] as const;
    const resources: Awaited<ReturnType<typeof client.create>>[] = [];
    const samples = new ModelServer([
      [call('transfer_to_child', {}, { callId: 'cold-transfer' })],
      [call('edit', { append: '-first' }, { callId: 'cold-edit-first' })],
      [message('Child settled.')],
      [call('edit', { append: '-second' }, { callId: 'cold-edit-second' })],
      [message('Child rebound.')],
    ]);
    let saved:
      { editor: ApplyPatchEditor; context: ToolCallContext } | undefined;
    const effects: string[] = [];
    let phase = 'resource-create';
    try {
      for (const manifest of manifests)
        resources.push(await client.create({ manifest }));
      const source = (index: 0 | 1, changedSource = false) =>
        mode === 'plain-environment'
          ? new Environment({
              url: peer.url,
              headers: peer.headers,
              cwd: resources[index]!.state.workspaceRootPath,
              tools: [],
            })
          : sandboxEnvironment({
              client,
              session: resources[index]!,
              manifest: manifests[index],
              capabilities: [],
              connect: async ({ state }) =>
                Environment.lease(
                  new Environment({
                    url: peer.url,
                    headers: peer.headers,
                    cwd: state.workspaceRootPath,
                    tools: [],
                    readOnly: changedSource,
                  }),
                  () => {},
                ),
            });
      const graph = (
        provider: NativeProvider,
        owner: string,
        changedSource = false,
      ) => {
        const child = new Agent({
          name: 'child',
          instructions: 'Edit the selected workspace.',
          model: 'gpt-5.5',
          provider,
          environment: source(1, changedSource),
          tools: [
            tool({
              name: 'edit',
              description:
                'Apply the supplied suffix through the current managed editor.',
              parameters: z.object({ append: z.string() }),
              async execute({ append }, context) {
                if (mode !== 'editor') {
                  effects.push(owner);
                  return 'plain callback';
                }
                const editor = context.sandbox!.createEditor({
                  format: {
                    applyDiff(input, diff) {
                      effects.push(owner);
                      return input + JSON.parse(diff).append;
                    },
                  },
                });
                saved = { editor, context };
                await editor.updateFile(
                  {
                    type: 'update_file',
                    path: 'target.txt',
                    diff: JSON.stringify({ append }),
                  },
                  context,
                );
                return 'edited';
              },
            }),
          ],
        });
        return new Agent({
          name: 'root',
          instructions: 'Transfer to child.',
          model: 'gpt-5.5',
          provider,
          environment: source(0),
          handoffs: [child],
        });
      };
      const storage = localStorage(join(home, 'history'));
      let id: string;
      {
        await using provider = await providerFor(samples);
        phase = 'open-first-session';
        await using session = await graph(provider, 'first-owner').session({
          storage,
        });
        id = session.id;
        phase = 'first-turn';
        expect(
          (await (await session.submit('Transfer and edit.')).wait())
            .finalOutput,
        ).toBe('Child settled.');
      }
      phase = 'first-session-closed';
      const stale = saved!;
      if (mode === 'editor')
        await expect(
          stale.editor.updateFile(
            {
              type: 'update_file',
              path: 'target.txt',
              diff: '{"append":"-stale"}',
            },
            stale.context,
          ),
        ).rejects.toThrow();
      expect(effects).toEqual(['first-owner']);
      if (mode === 'editor') {
        phase = 'reject-changed-source';
        await using provider = await providerFor(samples);
        await expect(
          graph(provider, 'rejected-owner', true).session({
            storage,
            resume: id,
          }),
        ).rejects.toThrow(/recorded Agent environment grants/);
        expect(samples.requests).toHaveLength(3);
        expect(effects).toEqual(['first-owner']);
      }
      {
        await using provider = await providerFor(samples);
        phase = 'open-resumed-session';
        await using session = await graph(provider, 'fresh-owner').session({
          storage,
          resume: id,
        });
        phase = 'resumed-turn';
        expect(
          (
            await (
              await session.submit('Edit the selected child again.')
            ).wait()
          ).finalOutput,
        ).toBe('Child rebound.');
      }
      expect(effects).toEqual(['first-owner', 'fresh-owner']);
      expect(
        await readFile(
          join(resources[1]!.state.workspaceRootPath, 'target.txt'),
          'utf8',
        ),
      ).toBe(mode === 'editor' ? 'child-before-first-second' : 'child-before');
      expect(
        await readFile(
          join(resources[0]!.state.workspaceRootPath, 'target.txt'),
          'utf8',
        ),
      ).toBe('root-before');
      samples.assertExhausted();
    } catch (error) {
      throw new Error(
        `Editor cold ${phase}; requests=${samples.requests.length}; effects=${effects.join(',')}; resumedTools=${JSON.stringify(samples.requests[3]?.tools)}; secondOutputs=${JSON.stringify(samples.requests.flatMap((request) => (Array.isArray(request.input) ? request.input.filter((item) => item && typeof item === 'object' && !Array.isArray(item) && item.call_id === 'cold-edit-second') : [])))}`,
        { cause: error },
      );
    } finally {
      for (const resource of resources.reverse()) await resource.delete();
      await rm(home, { recursive: true, force: true });
    }
  },
  60_000,
);
