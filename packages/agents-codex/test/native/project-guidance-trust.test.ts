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

it.each([
  { trust: 'trusted', directory: '.agents', extraRoot: false },
  { trust: 'untrusted', directory: '.agents', extraRoot: false },
  { trust: 'trusted', directory: '.claude', extraRoot: false },
  { trust: 'untrusted', directory: '.claude', extraRoot: false },
  { trust: 'missing', directory: 'both', extraRoot: false },
  { trust: 'missing', directory: 'both', extraRoot: true },
] as const)(
  '$trust project trust with $directory rules and extra writable root=$extraRoot',
  async ({ trust, directory, extraRoot }) => {
    const home = await mkdtemp(join(tmpdir(), 'guidance-host-config-'));
    vi.stubEnv('CODEX_HOME', home);
    try {
      await using executor = await startProjectExecutor();
      await writeFile(
        join(home, 'config.toml'),
        'model = "ambient-model-canary"\nmodel_provider = "ambient-provider-canary"\n' +
          '[model_providers.ambient-provider-canary]\nname = "ambient-provider-canary"\n' +
          'base_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\n' +
          (trust === 'missing'
            ? ''
            : `[projects.${JSON.stringify(executor.cwd)}]\ntrust_level = "${trust}"\n`),
      );
      const image = join(executor.cwd, 'pixel.png');
      await writeFile(
        image,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
          'base64',
        ),
      );
      const canonicalMarker = 'CANONICAL_HOST_TRUST_GUIDANCE';
      const legacyMarker = 'LEGACY_HOST_TRUST_GUIDANCE';
      for (const name of directory === 'both'
        ? ['.agents', '.claude']
        : [directory]) {
        const rules = join(executor.cwd, name, 'rules');
        await mkdir(rules, { recursive: true });
        await writeFile(
          join(rules, 'general.md'),
          name === '.agents' ? canonicalMarker : legacyMarker,
        );
      }
      const writableRoot = join(home, 'extra-workspace');
      if (extraRoot) await mkdir(writableRoot);
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
        ...(extraRoot ? { writableRoots: [writableRoot] } : {}),
      });
      {
        await using baseline = await agent.session({ environment });
        expect(
          (await (await baseline.submit('Answer.')).wait()).finalOutput,
        ).toBe('baseline');
      }
      const baselineModel = server.requests[0]!.model;
      expect(baselineModel).not.toBe('ambient-model-canary');
      expect(JSON.stringify(server.requests[0])).not.toContain(canonicalMarker);
      expect(JSON.stringify(server.requests[0])).not.toContain(legacyMarker);
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
      const modelInput = JSON.stringify(server.requests[2]);
      expect(modelInput.includes(canonicalMarker)).toBe(
        trust !== 'untrusted' && directory !== '.claude',
      );
      expect(modelInput.includes(legacyMarker)).toBe(
        trust !== 'untrusted' && directory === '.claude',
      );
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
