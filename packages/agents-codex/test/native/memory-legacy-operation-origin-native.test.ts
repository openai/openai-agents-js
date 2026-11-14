import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, Environment, NativeProvider } from '../../src';
import { Session as CoreSession } from '../../src/runtime/session';
import { Manifest, sandboxEnvironment } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents-core/sandbox/local';
import { ModelServer, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => {
  vi.restoreAllMocks();
  return ModelServer.closeAll();
});

it('keeps an older durable input without declaration provenance outside restored memory', async () => {
  const peer = await startPublicExecutor();
  const cwd = await mkdtemp(join(tmpdir(), 'memory-origin-'));
  const server = new ModelServer([
    [message('legacy-output')],
    [message('fresh-owned-output')],
    [
      message(
        JSON.stringify({
          rollout_summary: 'Fresh facts',
          rollout_slug: 'fresh',
          raw_memory: 'Fresh facts only.',
        }),
      ),
    ],
    [
      message(
        JSON.stringify({ summary: 'Fresh facts', memory: 'Fresh facts only.' }),
      ),
    ],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-legacy-origin',
    supportsWebsockets: false,
  });
  const phase = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Return memory artifacts.',
  });
  let workspace = '';
  const source = () =>
    sandboxEnvironment({
      client: new UnixLocalSandboxClient(),
      manifest: new Manifest({ entries: {} }),
      memory: { phaseOne: phase, phaseTwo: phase },
      connect: async ({ state }) => {
        workspace = state.workspaceRootPath;
        return Environment.lease(
          new Environment({
            url: peer.url,
            headers: peer.headers,
            cwd,
            tools: [],
          }),
          async () => {},
        );
      },
    });
  const root = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Answer.',
  });
  try {
    await using original = await root.session({ environment: source() });
    // Reproduce the earlier SDK writer, keeping its native input-admission proof
    // while omitting only the newly required declaration origin for this turn.
    type SelectionPrototype = {
      captureSelection(...args: unknown[]): Record<string, unknown> | undefined;
    };
    const prototype = CoreSession.prototype as unknown as SelectionPrototype;
    const capture = prototype.captureSelection;
    vi.spyOn(prototype, 'captureSelection').mockImplementationOnce(function (
      this: SelectionPrototype,
      ...args
    ) {
      const selection = capture.apply(this, args);
      if (selection === undefined) return selection;
      const legacy = { ...selection };
      delete legacy.operationDeclarationSource;
      return legacy;
    });
    expect(
      (await (await original.submit('legacy-unproven-input')).wait())
        .finalOutput,
    ).toBe('legacy-output');
    const state = await original.saveState();
    await original.close();
    await using restored = await root.session({ environment: source(), state });
    expect(
      (await (await restored.submit('fresh-owned-input')).wait()).finalOutput,
    ).toBe('fresh-owned-output');
    const history = JSON.stringify(await restored.historySnapshot());
    expect(history).toContain('legacy-unproven-input');
    expect(history).toContain('legacy-output');
    await restored.flushMemory();
    const transcript = await readFile(
      join(workspace, 'sessions', `${restored.id}.jsonl`),
      'utf8',
    );
    expect(transcript).toContain('fresh-owned-input');
    expect(transcript).toContain('fresh-owned-output');
    expect(transcript).not.toContain('legacy-unproven-input');
    expect(transcript).not.toContain('legacy-output');
    expect(JSON.stringify(server.requests.slice(2))).not.toContain(
      'legacy-unproven-input',
    );
  } finally {
    await peer.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 60_000);
