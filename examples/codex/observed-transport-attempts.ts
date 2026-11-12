/**
 * Caller-owned fetch observation around a borrowed Responses client.
 * From the matching source build, the command has been running without credentials:
 *   pnpm exec tsx examples/codex/observed-transport-attempts.ts
 *
 * One native model invocation has been receiving a synthetic 503 then 200 through
 * the borrowed client's retry loop. The caller has been counting fetch entries
 * before awaiting a send, separately from peer receipt and completed model usage.
 * Entry has not been proving a socket write, provider receipt, success, or billing.
 * These process-local counts have not been covering other clients, native internal
 * requests, child clients, remote-service retries, or work before observation.
 * The caller has been owning installation, retention, and trusted attribution.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import OpenAI from 'openai';
import { Agent, NativeProvider, ResponsesModel } from '@openai/agents';

export async function runObservedTransportAttemptsExample() {
  let entries = 0;
  let peerRequests = 0;
  let adapterInvocations = 0;
  const observedFetch: typeof fetch = async (input, init) => {
    entries += 1;
    return fetch(input, init);
  };
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* The peer has been draining input. */
    }
    peerRequests += 1;
    if (peerRequests === 1) {
      response.writeHead(503, {
        'content-type': 'application/json',
        'retry-after': '0',
      });
      response.end(
        JSON.stringify({
          error: { message: 'Synthetic retry', type: 'server_error' },
        }),
      );
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'resp_observed_attempts',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'msg_observed_attempts',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Done.', annotations: [] }],
          },
        ],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      }),
    );
  }).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = new OpenAI({
      apiKey: 'synthetic',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      maxRetries: 1,
      fetch: observedFetch,
    });
    await using provider = new NativeProvider({
      modelBackend: new ResponsesModel(client, undefined, {
        requestOptions: () => {
          adapterInvocations += 1;
          return {};
        },
      }),
      supportsWebsockets: false,
    });
    const result = await new Agent({
      model: 'fixture-observed-attempts',
      instructions: 'Answer briefly.',
      provider,
    }).run('Complete the synthetic request.');
    assert.equal(result.finalOutput, 'Done.');
    assert.equal(Number(result.runUsage.requests), 1);
    assert.equal(adapterInvocations, 1);
    assert.equal(entries, 2);
    assert.equal(peerRequests, entries);
    return {
      observed_transport_entries: entries,
      loopback_peer_receipts: peerRequests,
      completed_model_responses: Number(result.runUsage.requests),
      adapter_invocations: adapterInvocations,
      other_paths: 'unavailable',
    };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  runObservedTransportAttemptsExample().then(
    (result) => console.log(JSON.stringify(result)),
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
