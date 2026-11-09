import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  HttpMCP,
  InteractionRequired,
  NativeProvider,
  manualTool,
  type SessionState,
} from '../../src';
import { isManualSessionState } from '../../src/runtime/state';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

for (const rootManual of [false, true]) {
  for (const automatic of [false, true]) {
    it(`restores a target-only manual tool with ${rootManual ? 'an unrelated' : 'an empty'} root catalog and ${automatic ? 'automatic' : 'explicit'} suspension`, async () => {
      const lookup = manualTool({
        name: 'lookup',
        description: 'Read a fixture record.',
        parameters: z.object({}),
        result: z.string(),
      });
      const spare = manualTool({
        name: 'spare',
        description: 'An unrelated root tool.',
        parameters: z.object({}),
        result: z.number(),
      });
      const model = new ModelServer([
        [call('transfer_to_b', {}, { callId: 'handoff' })],
        [call('lookup', {}, { callId: 'lookup' })],
        [message('done')],
      ]);
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-handoff-manual',
        supportsWebsockets: false,
      });
      const b = new Agent({
        name: 'B',
        instructions: 'Read lookup.',
        tools: [lookup],
      });
      const a = new Agent({
        name: 'A',
        instructions: 'Hand off to B.',
        model: 'gpt-5.5',
        provider,
        programmaticToolCalling: false,
        tools: rootManual ? [spare] : [],
        handoffs: [b],
      });
      let state: SessionState;
      if (automatic) {
        const failure = await a.run('read').catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(InteractionRequired);
        state = (failure as InteractionRequired).state!;
      } else {
        await using session = await a.session();
        const turn = await session.submit('read');
        const batch = await turn.wait({ until: 'manual_tool' });
        if (!('requests' in batch))
          throw new Error('Expected target manual request');
        expect(lookup.match(batch.requests[0])).toBeDefined();
        await expect
          .poll(
            async () =>
              (await session.checkpointStatus({ kind: 'manualWait' })).status,
            { timeout: 2_000 },
          )
          .toBe('ready');
        state = await session.suspend();
      }
      if (!isManualSessionState(state))
        throw new Error('Expected manual checkpoint');
      expect(
        state.manual_context.result_schemas.map((entry) => entry.name),
      ).toEqual(['lookup']);
      await using resumed = await a.session({ state });
      const pending = await resumed.pendingInteractions();
      expect(pending).toHaveLength(1);
      const request = lookup.match(pending[0]);
      if (!request) throw new Error('Expected restored target declaration');
      await resumed.respond(request.reply('record'));
      expect((await resumed.restoredTurn!.wait()).finalOutput).toBe('done');
      model.assertExhausted();
    }, 20_000);
  }
}

for (const approvalMode of ['preapproved', 'native'] as const) {
  it.each(['lookup', 'find-record'])(
    `observes selected target-only MCP %s with ${approvalMode} approval`,
    async (rawName) => {
      const serverName = 'records-service';
      const projectedName = rawName === 'find-record' ? 'find_record' : rawName;
      const effects: unknown[] = [];
      const peer = createServer(async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405).end();
          return;
        }
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const rpc = JSON.parse(raw);
        if (rpc.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        let result: unknown = {};
        if (rpc.method === 'initialize')
          result = {
            protocolVersion: rpc.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'handoff-fixture', version: '1' },
          };
        else if (rpc.method === 'tools/list')
          result = {
            tools: [rawName, 'remove-record'].map((name) => ({
              name,
              description: 'Read a fixture record.',
              inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
            })),
          };
        else if (rpc.method === 'tools/call') {
          effects.push(rpc.params);
          result = { content: [{ type: 'text', text: 'record' }] };
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      });
      peer.listen(0, '127.0.0.1');
      await once(peer, 'listening');
      try {
        const address = peer.address();
        if (!address || typeof address === 'string')
          throw new Error('Expected TCP peer');
        const model = new ModelServer([
          [call('transfer_to_b', {}, { callId: 'handoff' })],
          [
            call(
              projectedName,
              {},
              { callId: 'selected', namespace: 'mcp__records_service' },
            ),
            call(
              'remove_record',
              {},
              { callId: 'unselected', namespace: 'mcp__records_service' },
            ),
          ],
          [message('done')],
        ]);
        const config = await model.config();
        await using provider = new NativeProvider({
          baseUrl: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'synthetic-handoff-mcp',
          supportsWebsockets: false,
        });
        const records = new HttpMCP({
          name: serverName,
          url: `http://127.0.0.1:${address.port}`,
          tools: [rawName, 'remove-record'],
          approvalMode,
        });
        const b = new Agent({
          name: 'B',
          instructions: 'Read lookup.',
          tools: [records],
        });
        await using session = await new Agent({
          name: 'A',
          instructions: 'Hand off.',
          tools: [],
          handoffs: [b],
          provider,
          model: 'gpt-5.5',
          programmaticToolCalling: false,
        }).session();
        const turn = await session.submit('read', {
          beforeStep: ({ stepIndex }) =>
            stepIndex === 0 ? undefined : [records.tool(rawName)],
        });
        if (approvalMode === 'native') {
          const batch = await turn.wait({ until: 'interaction' });
          if (!('requests' in batch))
            throw new Error('Expected target approval');
          expect(batch.requests).toHaveLength(1);
          expect(effects).toHaveLength(0);
          const request = batch.requests[0];
          if (request.type !== 'approval_request')
            throw new Error('Expected approval');
          await session.respond(request.reply('allow_once'));
        }
        expect((await turn.wait()).finalOutput).toBe('done');
        expect(effects).toEqual([expect.objectContaining({ name: rawName })]);
        const advertised = JSON.stringify(model.requests[1].tools);
        expect(advertised).toContain(projectedName);
        expect(advertised).not.toContain('remove_record');
        const events = [];
        for await (const event of turn.events()) {
          if ('family' in event && event.family === 'mcp') events.push(event);
        }
        expect(events).toMatchObject([
          {
            type: 'tool_started',
            callId: 'selected',
            name: rawName,
            namespace: serverName,
          },
          {
            type: 'tool_finished',
            callId: 'selected',
            name: rawName,
            namespace: serverName,
            status: 'completed',
          },
        ]);
        model.assertExhausted();
      } finally {
        peer.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          peer.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
    20_000,
  );
}
