import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ModelServer } from './model-server';
import type { JsonObject } from '../../../src/runtime/binding';

/** Synthetic local search endpoint in front of the existing real Responses fixture. */
export async function searchPeer(
  responses: ConstructorParameters<typeof ModelServer>[0],
) {
  const model = new ModelServer(responses);
  const config = await model.config();
  const upstream = (config['model_providers.fixture'] as JsonObject)
    .base_url as string;
  const searches: Array<{ body: JsonObject; authorization?: string }> = [];
  const failures: unknown[] = [];
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const controller = new AbortController();
    controllers.add(controller);
    const disconnected = () => {
      if (!response.writableFinished) controller.abort();
    };
    response.once('close', disconnected);
    const operation = (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString();
        if (request.url === '/v1/alpha/search' && request.method === 'POST') {
          searches.push({
            body: JSON.parse(body),
            authorization: request.headers.authorization,
          });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              output: 'native-search-fixture-result',
              results: null,
            }),
          );
        } else {
          assert.equal(request.url, '/v1/responses');
          assert.equal(request.method, 'POST');
          const forwarded = await fetch(upstream + '/responses', {
            method: 'POST',
            body,
            signal: controller.signal,
            headers: {
              'content-type': 'application/json',
              ...(request.headers.authorization
                ? { authorization: request.headers.authorization }
                : {}),
            },
          });
          response.writeHead(forwarded.status, {
            'content-type':
              forwarded.headers.get('content-type') ?? 'text/event-stream',
          });
          response.end(await forwarded.text());
        }
      } catch (error) {
        if (!controller.signal.aborted) failures.push(error);
        if (!response.destroyed) {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        }
      } finally {
        controllers.delete(controller);
        response.off('close', disconnected);
      }
    })();
    pending.add(operation);
    void operation
      .finally(() => pending.delete(operation))
      .catch((error: unknown) => failures.push(error));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  let closed = false;
  return {
    model,
    searches,
    url: `http://127.0.0.1:${address.port}/v1`,
    async [Symbol.asyncDispose]() {
      if (closed) return;
      closed = true;
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      const settled = await Promise.allSettled([...pending]);
      for (const result of settled)
        if (result.status === 'rejected') failures.push(result.reason);
      assert.deepEqual(failures, []);
    },
  };
}
