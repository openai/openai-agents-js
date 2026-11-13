import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  fileSessionStore,
  hostedMcp,
  tool,
  type SessionStore,
} from '../../src';
import { encryptedSessionStore } from '../../src/runtime/encrypted-thread-store';
import { encode, type JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

const directories: string[] = [];
afterEach(async () => {
  await ModelServer.closeAll();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function home() {
  const directory = await mkdtemp(join(tmpdir(), 'custom-idle-export-'));
  directories.push(directory);
  return directory;
}
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-idle-export',
    supportsWebsockets: false,
  });
}
function track(backend: SessionStore) {
  const counts = { acquire: 0, release: 0 };
  const tokens: string[] = [];
  const store: SessionStore = {
    async acquire(id) {
      counts.acquire++;
      const token = await backend.acquire(id);
      tokens.push(token);
      return token;
    },
    read: (...args) => backend.read(...args),
    commit: (...args) => backend.commit(...args),
    flush: async (...args) => {
      await backend.flush?.(...args);
    },
    async release(...args) {
      counts.release++;
      await backend.release(...args);
    },
  };
  return { store, counts, tokens };
}
it.each([false, true])(
  'exports an idle canonical root without transferring its store lease (encrypted=%s)',
  async (encrypted) => {
    const directory = await home();
    const tracked = track(fileSessionStore(directory));
    const encryptionKey = Buffer.alloc(32, 43);
    const storage = encrypted
      ? encryptedSessionStore(tracked.store, { encryptionKey })
      : tracked.store;
    let sourceCalls = 0;
    let destinationCalls = 0;
    const originalTool = tool({
      name: 'receipt',
      description: 'Read.',
      parameters: z.object({}),
      execute: () => {
        sourceCalls++;
        return 'source-callback';
      },
    });
    const currentTool = tool({
      name: 'receipt',
      description: 'Read.',
      parameters: z.object({}),
      execute: () => {
        destinationCalls++;
        return 'fresh-memory-callback';
      },
    });
    const server = new ModelServer([
      [message('retained conversation')],
      [message('source still live')],
      [call('receipt', {}, { callId: 'fresh-callback' })],
      [message('memory continued')],
      [message('source final')],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      model: 'gpt-5.5',
      provider,
      instructions: 'Answer.',
      tools: [originalTool],
    });
    const source = await agent.session({ storage });
    try {
      expect(
        (await (await source.submit('Snapshot me.')).wait()).finalOutput,
      ).toBe('retained conversation');
      expect((await source.checkpointStatus({ kind: 'idle' })).status).toBe(
        'ready',
      );
      const state = await source.saveState();
      expect(state.source_session_id).toBe(source.id);
      const serialized = encode(state);
      expect(serialized).not.toContain(encryptionKey.toString('hex'));
      expect(serialized).not.toContain(encryptionKey.toString('base64'));
      expect(serialized).not.toContain(directory);
      for (const token of tracked.tokens)
        expect(serialized).not.toContain(token);
      expect(state.agent_options).not.toHaveProperty('storage');
      expect(state.agent_options).not.toHaveProperty('customStore');
      expect(tracked.counts).toEqual({ acquire: 1, release: 0 });
      expect(
        (await (await source.submit('Source continues.')).wait()).finalOutput,
      ).toBe('source still live');
      const current = new Agent({
        model: 'gpt-5.5',
        provider,
        instructions: 'Answer.',
        tools: [currentTool],
      });
      const restored = await current.session({ state });
      try {
        expect(restored).not.toBe(source);
        expect(restored.id).toBe(source.id);
        expect(
          (await (await restored.submit('Continue memory.')).wait())
            .finalOutput,
        ).toBe('memory continued');
        expect(JSON.stringify(server.requests[2].input)).toContain(
          'retained conversation',
        );
        expect(JSON.stringify(server.requests[2].input)).not.toContain(
          'source still live',
        );
        expect(JSON.stringify(server.requests[3].input)).toContain(
          'fresh-memory-callback',
        );
        expect(sourceCalls).toBe(0);
        expect(destinationCalls).toBe(1);
        expect(tracked.counts).toEqual({ acquire: 1, release: 0 });
      } finally {
        await restored.close();
      }
      expect(tracked.counts).toEqual({ acquire: 1, release: 0 });
      expect(
        (await (await source.submit('After isolated close.')).wait())
          .finalOutput,
      ).toBe('source final');
      expect(JSON.stringify(server.requests[4].input)).toContain(
        'source still live',
      );
      expect(JSON.stringify(server.requests[4].input)).not.toContain(
        'memory continued',
      );
    } finally {
      await source.close();
    }
    expect(tracked.counts).toEqual({ acquire: 1, release: 1 });
    server.assertExhausted();
  },
  30000,
);

it('archives settled canonical Hosted MCP approvals before portable restore', async () => {
  const directory = await home();
  const approval = {
    type: 'mcp_approval_request',
    id: 'canonical-export-approval',
    server_label: 'docs',
    name: 'lookup',
    arguments: '{"key":"one"}',
  };
  const completed = {
    type: 'mcp_call',
    id: 'canonical-export-call',
    server_label: 'docs',
    name: 'lookup',
    arguments: '{"key":"one"}',
    output: 'retained remote result',
    status: 'completed',
  };
  const server = new ModelServer([
    [approval],
    [completed, message('accepted')],
    [message('memory continued')],
  ]);
  await using provider = await providerFor(server);
  const original = vi.fn(() => ({ approve: true, reason: 'live owner' }));
  const fresh = vi.fn(() => ({ approve: false, reason: 'current owner' }));
  const agentFor = (
    onApprovalRequest: () => { approve: boolean; reason: string },
  ) =>
    new Agent({
      model: 'gpt-5.5',
      provider,
      instructions: 'Use docs.',
      tools: [
        hostedMcp({
          serverLabel: 'docs',
          serverUrl: 'https://docs.invalid/mcp',
          requireApproval: 'always',
          onApprovalRequest,
        }),
      ],
    });
  const source = await agentFor(original).session({
    storage: fileSessionStore(directory),
  });
  try {
    expect((await (await source.submit('Lookup.')).wait()).finalOutput).toBe(
      'accepted',
    );
    const decision = (server.requests[1].input as JsonObject[]).find(
      (item) => item.type === 'mcp_approval_response',
    );
    expect(decision).toMatchObject({
      approval_request_id: 'canonical-export-approval',
      approve: true,
    });
    const state = await source.saveState();
    await using restored = await agentFor(fresh).session({ state });
    expect(
      (await (await restored.submit('Continue.')).wait()).finalOutput,
    ).toBe('memory continued');
    const input = server.requests[2].input as JsonObject[];
    expect(
      input.filter(
        (item) =>
          item.type === 'mcp_approval_request' ||
          item.type === 'mcp_approval_response',
      ),
    ).toHaveLength(0);
    expect(input.find((item) => item.type === 'mcp_call')).toMatchObject({
      output: 'retained remote result',
    });
    expect(original).toHaveBeenCalledTimes(1);
    expect(fresh).not.toHaveBeenCalled();
    server.assertExhausted();
  } finally {
    await source.close();
  }
}, 30000);
