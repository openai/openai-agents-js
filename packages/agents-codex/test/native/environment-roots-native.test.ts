import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Agent,
  Environment,
  NativeProvider,
  type SessionState,
} from '@openai/agents';
import { ModelServer, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

async function skill(root: string, name: string, marker: string) {
  const directory = join(root, 'skills', name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${marker}\n---\nUse this skill when requested.\n`,
  );
}

it.each(['selected', 'omitted', 'empty', 'no-environment'] as const)(
  'uses only current destination roots after idle restore: %s',
  async (mode) => {
    const executor = await startPublicExecutor();
    const host = await mkdtemp(join(tmpdir(), 'agents-roots-host-'));
    const originalCwd = process.cwd();
    try {
      const chosen = join(executor.cwd, 'chosen');
      const unselected = join(executor.cwd, 'unselected');
      const destination = join(executor.cwd, 'destination');
      await skill(chosen, 'source-skill', 'SOURCE_ORCHID_ROOT');
      await skill(unselected, 'unselected-skill', 'UNSELECTED_RUBY_ROOT');
      await skill(destination, 'destination-skill', 'DESTINATION_AMBER_ROOT');
      await skill(join(host, '.agents'), 'host-skill', 'HOST_ZIRCON_ROOT');
      process.chdir(host);
      const server = new ModelServer([
        [message('source')],
        [message('destination')],
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-roots-provider',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        instructions: 'Inspect the skill catalog.',
        provider,
        model: 'gpt-5',
      });
      const directories = [chosen];
      const connection = {
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        // This discovery-only fixture also restores without an Environment.
        writePolicy: 'legacy' as const,
      };
      const sourceEnvironment = new Environment({
        ...connection,
        capabilityDirectories: directories,
      });
      directories.push(unselected);
      let saved: SessionState;
      {
        await using source = await agent.session({
          environment: sourceEnvironment,
        });
        expect(
          (await (await source.submit('Catalog')).wait()).finalOutput,
        ).toBe('source');
        const wire = JSON.stringify(server.requests[0]);
        expect(wire).toContain('SOURCE_ORCHID_ROOT');
        expect(wire).not.toContain('UNSELECTED_RUBY_ROOT');
        expect(wire).not.toContain('HOST_ZIRCON_ROOT');
        expect(wire).not.toContain('DESTINATION_AMBER_ROOT');
        expect(JSON.stringify(server.requests[0]?.tools ?? [])).not.toContain(
          'exec_command',
        );
        saved = await source.saveState();
        expect(saved).not.toHaveProperty('executor_policy_digest');
        expect(JSON.stringify(saved)).not.toContain(
          executor.headers.Authorization,
        );
      }
      const firstEnd = executor.requests.length;
      const environment =
        mode === 'no-environment'
          ? undefined
          : new Environment({
              ...connection,
              ...(mode === 'omitted'
                ? {}
                : {
                    capabilityDirectories:
                      mode === 'selected' ? [destination] : [],
                  }),
            });
      {
        await using restored = await agent.session({
          state: saved,
          environment,
        });
        expect(
          (await (await restored.submit('Catalog now')).wait()).finalOutput,
        ).toBe('destination');
        const wire = JSON.stringify(server.requests[1]);
        expect(wire.includes('DESTINATION_AMBER_ROOT')).toBe(
          mode === 'selected',
        );
        expect(wire).not.toContain('UNSELECTED_RUBY_ROOT');
        expect(wire).not.toContain('HOST_ZIRCON_ROOT');
        expect(JSON.stringify(server.requests[1]?.tools ?? [])).not.toContain(
          'exec_command',
        );
      }
      const discovery = executor.requests
        .slice(firstEnd)
        .filter(
          (request) =>
            String(request.method).startsWith('capabilityRoots/') ||
            String(request.method).startsWith('fs/'),
        );
      const params = JSON.stringify(discovery.map((request) => request.params));
      expect(params.includes(pathToFileURL(destination).href)).toBe(
        mode === 'selected',
      );
      expect(params).not.toContain(pathToFileURL(chosen).href);
      expect(params).not.toContain(pathToFileURL(unselected).href);
      expect(params).not.toContain(pathToFileURL(host).href);
      expect(
        executor.requests.filter(
          (request) => request.method === 'process/start',
        ),
      ).toHaveLength(0);
      server.assertExhausted();
    } finally {
      process.chdir(originalCwd);
      try {
        await executor.close();
      } finally {
        await rm(host, { recursive: true, force: true });
      }
    }
  },
  30_000,
);

it.each(['duplicate', 'over-limit'] as const)(
  'rejects %s native root admission before model work',
  async (kind) => {
    const executor = await startPublicExecutor();
    try {
      const server = new ModelServer([]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-roots-provider',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        instructions: 'Inspect.',
        model: 'gpt-5',
        provider,
      });
      const directories =
        kind === 'duplicate'
          ? ['file:///remote/catalog', 'file://localhost/remote/catalog']
          : Array.from({ length: 257 }, (_, i) => `/remote/catalog-${i}`);
      const environment = new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        capabilityDirectories: directories,
      });
      await expect(agent.session({ environment })).rejects.toThrow(
        /unique|256/,
      );
      expect(server.requests).toHaveLength(0);
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  30_000,
);
