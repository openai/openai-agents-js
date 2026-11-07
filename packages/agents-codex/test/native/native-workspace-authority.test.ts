import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeProvider,
} from '@openai/agents';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

// This suite's file effects require a filesystem sandbox, which Codex cannot nest.
const native = describe.skipIf(
  process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1' ||
    process.env.OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX === '1',
);

native('selected remote workspace authority', () => {
  it('writes an ordinary file and refuses all four protected metadata paths in one unattended session', async () => {
    const executor = await startPublicExecutor({
      captureFileSystemDiagnostics: true,
    });
    try {
      const protectedNames = ['.git', '.agents', '.codex', '.aws'];
      for (const name of protectedNames) {
        await mkdir(join(executor.cwd, name));
        await writeFile(join(executor.cwd, name, 'proof'), 'retained\n');
      }
      const targets = [
        'workspace-proof',
        ...protectedNames.map((name) => `${name}/proof`),
      ];
      const calls: JsonObject[] = targets.map((target, index) => ({
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: `workspace-authority-${index}`,
        input:
          index === 0
            ? `*** Begin Patch\n*** Add File: ${join(executor.cwd, target)}\n+proof\n*** End Patch`
            : `*** Begin Patch\n*** Update File: ${join(executor.cwd, target)}\n@@\n-retained\n+changed\n*** End Patch`,
      }));
      const model = new ModelServer([
        ...calls.map((call) => [call]),
        [message('finished')],
      ]);
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-workspace-authority',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        instructions: 'Perform each requested native file operation.',
        model: 'gpt-5.5',
        provider,
        tools: [new NativeAgents({ maxChildren: 1 })],
      });
      const environment = new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      });
      await using session = await agent.session({ environment });
      const turn = await session.submit('Perform the five file operations.');
      const result = await turn.wait({ until: 'interaction' });
      if ('requests' in result)
        throw new Error('Unattended file operations requested approval');
      expect(result.finalOutput).toBe('finished');
      expect(await session.pendingInteractions()).toEqual([]);
      model.assertExhausted();

      // Retain only bounded, redacted filesystem diagnostics on failure.
      const diagnostic = JSON.stringify(executor.fileSystemDiagnostics).slice(
        0,
        16_384,
      );
      for (let index = 0; index < calls.length; index++) {
        const outputs = (
          model.requests[index + 1]!.input as JsonObject[]
        ).filter(
          (item) =>
            item.type === 'custom_tool_call_output' &&
            item.call_id === calls[index]!.call_id,
        );
        expect(outputs).toHaveLength(1);
        const output = String(outputs[0]!.output);
        if (index === 0) {
          expect(output, diagnostic).toMatch(/^Exit code: 0\n/);
          expect(output).toContain('workspace-proof');
          expect(
            await readFile(join(executor.cwd, targets[index]!), 'utf8'),
          ).toBe('proof\n');
        } else {
          expect(output).not.toMatch(/^Exit code: 0\n/);
          expect(output).toMatch(/denied|reject|permission|writable|approval/i);
          expect(
            await readFile(join(executor.cwd, targets[index]!), 'utf8'),
          ).toBe('retained\n');
        }
      }
      const write = executor.fileSystemDiagnostics.find(
        (entry) =>
          entry.direction === 'request' &&
          entry.method === 'fs/writeFile' &&
          entry.path ===
            pathToFileURL(join(executor.cwd, 'workspace-proof')).href,
      );
      expect(write, diagnostic).toBeDefined();
      expect(write!.sandbox).toMatchObject({
        permissions: {
          type: 'managed',
          network: 'restricted',
          file_system: {
            type: 'restricted',
            entries: [
              {
                access: 'read',
                path: { type: 'special', value: { kind: 'root' } },
              },
              {
                access: 'write',
                path: { type: 'path', path: pathToFileURL(executor.cwd).href },
              },
              ...protectedNames.map((name) => ({
                access: 'read',
                missing_path_behavior: 'skip',
                path: {
                  type: 'path',
                  path: pathToFileURL(join(executor.cwd, name)).href,
                },
              })),
            ],
          },
        },
        policyContext: {
          cwd: pathToFileURL(executor.cwd).href,
          workspaceRoots: [pathToFileURL(executor.cwd).href],
        },
      });
      expect(
        executor.fileSystemDiagnostics.find(
          (entry) => entry.direction === 'response' && entry.id === write!.id,
        ),
      ).toMatchObject({ success: true });
    } finally {
      await executor.close();
    }
  }, 30_000);
});
