import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  NativeProvider,
  hostedMcp,
  localStorage,
  parseSessionState,
} from '../../src';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('archives a settled native hosted approval when exporting LocalStorage', async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-settled-mcp-'));
  const directory = join(home, 'source');
  const approval = {
    type: 'mcp_approval_request',
    id: 'settled-approval',
    server_label: 'archive',
    name: 'lookup',
    arguments: '{}',
    caller: { type: 'direct' },
  };
  const denied = { ...approval, id: 'denied-before' };
  const server = new ModelServer([
    [denied],
    [message('denied history')],
    [approval],
    [message('source complete')],
    [approval],
    [message('restored complete')],
  ]);
  try {
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-local-mcp',
      supportsWebsockets: false,
    });
    const hosted = hostedMcp({
      serverLabel: 'archive',
      requireApproval: 'always',
    });
    const agent = new Agent({
      instructions: 'Ask before work.',
      model: 'gpt-5.2',
      tools: [hosted],
      provider,
    });
    const source = await agent.session({ storage: localStorage(directory) });
    let saved;
    let sourceMessages: unknown[] = [];
    try {
      const deniedTurn = await source.submit('Earlier denied hosted work.');
      const deniedBatch = await deniedTurn.wait({ until: 'manual_tool' });
      if (!('requests' in deniedBatch))
        throw new Error('Expected denied hosted approval');
      const deniedRequest = hosted.match(deniedBatch.requests[0]);
      if (!deniedRequest) throw new Error('Expected matching denied request');
      await source.respond(deniedRequest.reply({ approve: false }));
      expect((await deniedTurn.wait()).finalOutput).toBe('denied history');
      const turn = await source.submit('Request hosted work.');
      const pending = await turn.wait({ until: 'manual_tool' });
      if (!('requests' in pending)) throw new Error('Expected hosted approval');
      const request = hosted.match(pending.requests[0]);
      if (!request) throw new Error('Expected matching hosted approval');
      await source.respond(request.reply({ approve: true }));
      expect((await turn.wait()).finalOutput).toBe('source complete');
      const original = await source.historySnapshot();
      sourceMessages = original.items.filter((item) => item.type === 'message');
      expect(
        original.items.some(
          (item) =>
            item.type === 'mcp_approval_response' && item.approve === true,
        ),
      ).toBe(true);
      saved = parseSessionState(JSON.stringify(await source.saveState()));
      expect(await source.historySnapshot()).toEqual(original);
    } finally {
      await source.close();
    }
    await rename(directory, join(home, 'removed-source'));
    await using restored = await agent.session({ state: saved });
    const restoredHistory = await restored.historySnapshot();
    for (const item of sourceMessages)
      expect(restoredHistory.items).toContainEqual(item);
    const continuation = await restored.submit('Continue from history.');
    const fresh = await continuation.wait({ until: 'manual_tool' });
    if (!('requests' in fresh))
      throw new Error('Expected a fresh hosted approval');
    const freshRequest = hosted.match(fresh.requests[0]);
    if (!freshRequest)
      throw new Error('Expected matching fresh hosted approval');
    expect(freshRequest.callId).toBe('settled-approval');
    expect(server.requests).toHaveLength(5);
    await restored.respond(freshRequest.reply({ approve: false }));
    expect((await continuation.wait()).finalOutput).toBe('restored complete');
    const input = server.requests[4]!.input as Array<Record<string, unknown>>;
    const decisions = input.filter(
      (item) => item.type === 'mcp_approval_response',
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      approval_request_id: 'denied-before',
      approve: false,
    });
    expect(JSON.stringify(input)).toContain('Historical MCP approval data');
    expect(JSON.stringify(input)).toContain('settled-approval');
    server.assertExhausted();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
