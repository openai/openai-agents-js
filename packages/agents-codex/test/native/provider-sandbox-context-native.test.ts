import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { Manifest, sandboxEnvironment } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import {
  Agent,
  Environment,
  NativeProvider,
  applyPatchTool,
  shellTool,
  tool,
  type SandboxAccess,
  type ToolContext,
  type ToolCallContext,
} from '../../src';
import { ModelServer, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';
afterEach(() => ModelServer.closeAll());
let peer: Awaited<ReturnType<typeof startPublicExecutor>>;
beforeAll(async () => {
  peer = await startPublicExecutor();
});
afterAll(async () => {
  await peer?.close();
});
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
}
function sourceFor(roots: string[]) {
  return sandboxEnvironment({
    client: new UnixLocalSandboxClient(),
    manifest: new Manifest({
      entries: { 'marker.txt': { type: 'file', content: 'before' } },
    }),
    connect: async (sandbox) => {
      const root = sandbox.state.workspaceRootPath as string;
      roots.push(root);
      return Environment.lease(
        new Environment({
          url: peer.url,
          headers: peer.headers,
          cwd: root,
          tools: [],
        }),
        () => {},
      );
    },
  });
}
const shell = (label: string) => ({
  type: 'shell_call',
  call_id: 'shell',
  action: {
    commands: [`printf ${label} > marker.txt`],
    timeout_ms: 1000,
    max_output_length: 4096,
  },
});
async function executeShell(
  call: { action: { commands: readonly string[] } },
  context: ToolContext,
) {
  const output = [];
  for (const cmd of call.action.commands) {
    const value = await context.sandbox!.exec({ cmd, yieldTimeMs: 1000 });
    output.push({
      stdout: value.stdout,
      stderr: value.stderr,
      outcome:
        value.exitCode == null
          ? { type: 'timeout' as const }
          : { type: 'exit' as const, exit_code: value.exitCode },
    });
  }
  return { output };
}
it('has been binding concurrent native Shell callbacks to each acquired provider', async () => {
  const roots: string[] = [];
  const source = sourceFor(roots);
  const first = new ModelServer([[shell('first')], [message('first done')]]);
  const second = new ModelServer([[shell('second')], [message('second done')]]);
  await using aProvider = await providerFor(first);
  await using bProvider = await providerFor(second);
  let firstAccess: SandboxAccess | undefined;
  const shared = shellTool({
    execute: async (call, context) => {
      firstAccess ??= context.sandbox;
      return executeShell(call, context);
    },
  });
  await using a = await new Agent({
    instructions: 'Use Shell.',
    provider: aProvider,
    tools: [shared],
  }).session({ environment: source });
  await using b = await new Agent({
    instructions: 'Use Shell.',
    provider: bProvider,
    tools: [shared],
  }).session({ environment: source });
  const results = await Promise.all([
    a.submit('first').then((turn) => turn.wait()),
    b.submit('second').then((turn) => turn.wait()),
  ]);
  expect(results.map((result) => result.finalOutput)).toEqual([
    'first done',
    'second done',
  ]);
  expect(await readFile(roots[0] + '/marker.txt', 'utf8')).toBe('first');
  expect(await readFile(roots[1] + '/marker.txt', 'utf8')).toBe('second');
  await expect(
    firstAccess!.exec({ cmd: 'printf late > marker.txt' }),
  ).rejects.toThrow();
  first.assertExhausted();
  second.assertExhausted();
});
it('has been applying the native editor operation through the acquired provider', async () => {
  const roots: string[] = [];
  const server = new ModelServer([
    [
      {
        type: 'apply_patch_call',
        id: 'patch-item',
        call_id: 'patch',
        operation: {
          type: 'create_file',
          path: 'bound.txt',
          diff: '+bound provider\n',
        },
      },
    ],
    [message('edited')],
  ]);
  await using provider = await providerFor(server);
  const editor = {
    createFile: (
      op: Parameters<
        ReturnType<SandboxAccess['createEditor']>['createFile']
      >[0],
      context: ToolCallContext,
    ) => context.sandbox!.createEditor().createFile(op, context),
    updateFile: (
      op: Parameters<
        ReturnType<SandboxAccess['createEditor']>['updateFile']
      >[0],
      context: ToolCallContext,
    ) => context.sandbox!.createEditor().updateFile(op, context),
    deleteFile: (
      op: Parameters<
        ReturnType<SandboxAccess['createEditor']>['deleteFile']
      >[0],
      context: ToolCallContext,
    ) => context.sandbox!.createEditor().deleteFile(op, context),
  };
  await using session = await new Agent({
    instructions: 'Apply the patch.',
    provider,
    tools: [applyPatchTool({ editor })],
  }).session({ environment: sourceFor(roots) });
  expect((await (await session.submit('edit')).wait()).finalOutput).toBe(
    'edited',
  );
  expect(await readFile(roots[0] + '/bound.txt', 'utf8')).toBe(
    'bound provider',
  );
  server.assertExhausted();
});
it('has been revoking provider access under the callback deadline signal before reply', async () => {
  const roots: string[] = [];
  const late = vi.fn();
  const server = new ModelServer([
    [
      {
        type: 'function_call',
        id: 'late-item',
        call_id: 'late',
        name: 'late',
        arguments: '{}',
      },
    ],
    [message('recovered')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use late.',
    provider,
    tools: [
      tool({
        name: 'late',
        parameters: z.object({}),
        callbackTimeout: 0.01,
        timeoutBehavior: 'error_as_result',
        execute: async (_input, context) => {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          );
          await expect(
            context.sandbox!.exec({ cmd: 'printf forbidden > marker.txt' }),
          ).rejects.toBe(context.signal.reason);
          late();
          return 'late';
        },
      }),
    ],
  }).session({ environment: sourceFor(roots) });
  expect((await (await session.submit('begin')).wait()).finalOutput).toBe(
    'recovered',
  );
  expect(late).toHaveBeenCalledTimes(1);
  expect(await readFile(roots[0] + '/marker.txt', 'utf8')).toBe('before');
  server.assertExhausted();
});
