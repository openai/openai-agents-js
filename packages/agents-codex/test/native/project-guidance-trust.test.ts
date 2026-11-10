import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, Environment } from '@openai/agents';
import { call, message, ModelServer } from './fixtures/model-server';
import {
  providerFor,
  startProjectExecutor,
} from './fixtures/project-guidance/project';

afterEach(async () => {
  vi.unstubAllEnvs();
  await ModelServer.closeAll();
});

it.each([false, true])(
  'projects explicit host trust=%s without ambient provider or default-model selection',
  async (trusted) => {
    const home = await mkdtemp(join(tmpdir(), 'guidance-host-config-'));
    vi.stubEnv('CODEX_HOME', home);
    try {
      await using executor = await startProjectExecutor();
      await writeFile(
        join(home, 'config.toml'),
        'model = "ambient-model-canary"\nmodel_provider = "ambient-provider-canary"\n' +
          '[model_providers.ambient-provider-canary]\nname = "ambient-provider-canary"\n' +
          'base_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\n' +
          `[projects.${JSON.stringify(executor.cwd)}]\ntrust_level = "${trusted ? 'trusted' : 'untrusted'}"\n`,
      );
      const image = join(executor.cwd, 'pixel.png');
      await writeFile(
        image,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
          'base64',
        ),
      );
      const rules = join(executor.cwd, '.agents', 'rules');
      await mkdir(rules, { recursive: true });
      const marker = 'EXPLICIT_HOST_TRUST_GUIDANCE';
      await writeFile(join(rules, 'general.md'), marker);
      const server = new ModelServer([
        [message('baseline')],
        [call('view_image', { path: image }, { callId: 'image' })],
        [message('image read')],
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({ instructions: 'Answer.', provider });
      const environment = new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
      });
      {
        await using baseline = await agent.session({ environment });
        expect(
          (await (await baseline.submit('Answer.')).wait()).finalOutput,
        ).toBe('baseline');
      }
      const baselineModel = server.requests[0]!.model;
      expect(baselineModel).not.toBe('ambient-model-canary');
      expect(JSON.stringify(server.requests[0])).not.toContain(marker);
      {
        await using session = await agent.session({
          environment,
          projectGuidance: true,
        });
        expect(
          (await (await session.submit('Read the image.')).wait()).finalOutput,
        ).toBe('image read');
      }
      expect(server.requests).toHaveLength(3);
      expect(
        server.requests.every((request) => request.model === baselineModel),
      ).toBe(true);
      expect(JSON.stringify(server.requests[2])).toContain(
        'data:image/png;base64,',
      );
      expect(JSON.stringify(server.requests[2]).includes(marker)).toBe(trusted);
      expect(environment.tools).toEqual([]);
      expect(
        JSON.stringify(server.requests.map((request) => request.tools)),
      ).not.toContain('exec_command');
      expect(
        executor.requests.some((request) => request.method === 'process/start'),
      ).toBe(false);
      server.assertExhausted();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  30_000,
);
