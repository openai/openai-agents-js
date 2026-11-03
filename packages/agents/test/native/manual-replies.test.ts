import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSessionState, type NativeProviderOptions } from '@openai/agents';
import {
  resumeLookup,
  runLookupWithHandler,
  savePendingLookup,
} from '../../examples/manual-replies';
import type { JsonObject } from '../../src/runtime/binding';
import { CODEX_REVISION } from '../../src/runtime/state';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('rejects an idle checkpoint before opening a pending lookup', async () => {
  const json = JSON.stringify({
    format_version: 2,
    codex_revision: CODEX_REVISION,
    source_session_id: 'idle-lookup-session',
    root_metadata: {},
    history: [],
  });
  await expect(resumeLookup(json, 'Unused label')).rejects.toThrow(
    'Expected a pending manual checkpoint.',
  );
});

async function providerOptions(
  server: ModelServer,
): Promise<NativeProviderOptions> {
  const config = await server.config();
  return {
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-manual-reply-key',
    supportsWebsockets: false,
  };
}

function outputFor(request: JsonObject, callId: string) {
  const item = (request.input as JsonObject[]).find(
    (entry) =>
      entry.type === 'function_call_output' && entry.call_id === callId,
  );
  expect(item).toBeDefined();
  return JSON.stringify(item!.output);
}

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'manual reply example through the native runtime',
  () => {
    it('saves a pending lookup and answers its restored request', async () => {
      const server = new ModelServer([
        [call('lookup', { key: 'record-a' }, { callId: 'saved-lookup' })],
        (request) => {
          expect(outputFor(request, 'saved-lookup')).toContain(
            'Application-selected label',
          );
          return [message('The label is Application-selected label.')];
        },
      ]);
      const options = await providerOptions(server);
      const json = await savePendingLookup(options);
      const state = parseSessionState(json);
      expect(state.format_version).toBe(16);
      if (state.format_version !== 16)
        throw new Error('Expected pending lookup state');
      expect(state.manual_continuation.pending_manual).toEqual([
        expect.objectContaining({
          call_id: 'saved-lookup',
          name: 'lookup',
          arguments: expect.stringContaining('record-a'),
        }),
      ]);
      expect(server.requests).toHaveLength(1);
      await expect(
        resumeLookup(json, 'Application-selected label', options),
      ).resolves.toBe('The label is Application-selected label.');
      expect(JSON.stringify(server.requests)).not.toContain(options.apiKey!);
      server.assertExhausted();
    }, 25000);

    it('answers separate requests during a one-shot run', async () => {
      const server = new ModelServer([
        [
          call('lookup', { key: 'record-a' }, { callId: 'lookup-a' }),
          call('lookup', { key: 'record-b' }, { callId: 'lookup-b' }),
        ],
        (request) => {
          expect(outputFor(request, 'lookup-a')).toContain(
            'Label for record-a',
          );
          expect(outputFor(request, 'lookup-b')).toContain(
            'Label for record-b',
          );
          return [message('Answered both lookups.')];
        },
      ]);
      await expect(
        runLookupWithHandler(await providerOptions(server)),
      ).resolves.toBe('Answered both lookups.');
      server.assertExhausted();
    }, 25000);

    it('reports early completion instead of waiting for a missing lookup', async () => {
      const server = new ModelServer([[message('No lookup needed.')]]);
      await expect(
        savePendingLookup(await providerOptions(server)),
      ).rejects.toThrow('The run completed without requesting lookup.');
      server.assertExhausted();
    }, 25000);

    it('retains an early provider failure while waiting for lookup', async () => {
      let requests = 0;
      const server = createServer((request, response) => {
        requests++;
        request.resume();
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              message: 'MANUAL_LOOKUP_PROVIDER_FAILED',
              type: 'invalid_request_error',
              code: 'invalid_request_error',
            },
          }),
        );
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      try {
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('Expected a local provider address');
        await expect(
          savePendingLookup({
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: 'synthetic-manual-reply-key',
            supportsWebsockets: false,
          }),
        ).rejects.toThrow('MANUAL_LOOKUP_PROVIDER_FAILED');
        expect(requests).toBe(1);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }, 25000);

    it('rejects an invalid resumed answer without continuing the model', async () => {
      const server = new ModelServer([
        [call('lookup', { key: 'record-a' }, { callId: 'invalid-answer' })],
        (request) => {
          expect(outputFor(request, 'invalid-answer')).toContain(
            'Corrected label',
          );
          return [message('Accepted the corrected label.')];
        },
      ]);
      const options = await providerOptions(server);
      const json = await savePendingLookup(options);
      await expect(resumeLookup(json, '', options)).rejects.toThrow(
        'Manual tool result failed validation',
      );
      expect(server.requests).toHaveLength(1);
      await expect(
        resumeLookup(json, 'Corrected label', options),
      ).resolves.toBe('Accepted the corrected label.');
      server.assertExhausted();
    }, 25000);
  },
);
