import { expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, Environment, NativeProvider, tool } from '@openai/agents';
import { sandboxEnvironment } from '@openai/agents/sandbox';
import { scriptedSandboxSession } from '@openai/agents/testing';
import { startPublicExecutor } from './fixtures/public-executor';

it('runs scripted sandbox operations inside a native Session', async () => {
  const sandbox = scriptedSandboxSession([
    {
      method: 'materializeEntry',
      match: ({ path, entry }) =>
        path === 'answer.txt' &&
        entry.type === 'file' &&
        entry.content === 'fixture file',
      result: undefined,
    },
    {
      method: 'execCommand',
      match: ({ cmd }) => cmd === 'fixture command',
      result: 'scripted command',
    },
    {
      method: 'readFile',
      match: ({ path }) => path === 'answer.txt',
      result: 'fixture file',
    },
    { method: 'persistWorkspace', result: Uint8Array.of(4, 5, 6) },
    {
      method: 'hydrateWorkspace',
      match: (archive) =>
        archive instanceof Uint8Array &&
        archive.length === 3 &&
        archive[2] === 6,
      result: undefined,
    },
  ]);
  const runOperations = tool({
    name: 'scripted_workspace',
    description: 'Exercise the configured workspace fixture.',
    parameters: z.object({}),
    execute: async () => {
      await sandbox.materializeEntry({
        path: 'answer.txt',
        entry: { type: 'file', content: 'fixture file' },
      });
      const command = await sandbox.execCommand({ cmd: 'fixture command' });
      const file = await sandbox.readFile({ path: 'answer.txt' });
      await sandbox.hydrateWorkspace(await sandbox.persistWorkspace());
      return `${command} and ${file}`;
    },
  });
  let modelCalls = 0;
  await using provider = new NativeProvider({
    modelBackend: {
      complete(request) {
        if (modelCalls++ === 0) {
          return {
            output: [
              {
                type: 'function_call',
                id: 'fc_workspace',
                call_id: 'call_workspace',
                name: 'scripted_workspace',
                arguments: '{}',
              },
            ],
          };
        }
        expect(JSON.stringify(request.body.input)).toContain(
          'scripted command and fixture file',
        );
        return {
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'done', annotations: [] }],
            },
          ],
        };
      },
    },
  });
  const peer = await startPublicExecutor();
  try {
    const source = sandboxEnvironment({
      client: { backendId: 'scripted-fixture' },
      manifest: sandbox.state.manifest,
      session: sandbox,
      async connect(acquired) {
        expect(acquired).toBe(sandbox);
        return Environment.lease(
          new Environment({
            url: peer.url,
            headers: peer.headers,
            cwd: peer.cwd,
            tools: [],
          }),
          () => peer.close(),
        );
      },
    });
    const agent = new Agent({
      provider,
      instructions: 'Use the scripted workspace tool.',
      tools: [runOperations],
    });
    await using session = await agent.session({ environment: source });
    expect(
      (await (await session.submit('Run the fixture.')).wait()).finalOutput,
    ).toBe('done');
    expect(modelCalls).toBe(2);
    sandbox.assertComplete();
  } finally {
    await peer.close();
  }
});
