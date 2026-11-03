import { createServer } from 'node:http';

export async function startHostedSearchServer(
  reply: (body: Record<string, unknown>, index: number) => unknown,
) {
  const requests: Array<{
    path: string;
    authorization: string | undefined;
    body: Record<string, unknown>;
  }> = [];
  const errors: unknown[] = [];
  const pending = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const operation = (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new Error('Expected a JSON request object.');
        }
        const captured = {
          path: request.url ?? '',
          authorization: request.headers.authorization,
          body: body as Record<string, unknown>,
        };
        const index = requests.push(captured) - 1;
        if (request.method !== 'POST' || captured.path !== '/v1/responses') {
          throw new Error('Expected POST /v1/responses.');
        }
        const result = await reply(captured.body, index);
        const serialized = JSON.stringify(result);
        if (serialized === undefined) {
          throw new Error('Expected a JSON response.');
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(serialized);
      } catch (error) {
        errors.push(error);
        if (!response.destroyed) {
          if (!response.headersSent) {
            response.writeHead(400, { 'content-type': 'application/json' });
          }
          response.end('{"error":{"message":"Hosted search fixture failed"}}');
        }
      }
    })();
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      (error: unknown) => {
        errors.push(error);
        pending.delete(operation);
        response.destroy();
      },
    );
  });

  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    closing ??= (async () => {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      const settled = await Promise.allSettled([closed, ...pending]);
      const failures = settled
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length) {
        throw new AggregateError(
          failures,
          'Hosted search fixture cleanup failed.',
        );
      }
    })();
    return closing;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a loopback TCP address.');
    }
    return {
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      requests,
      errors,
      close,
    };
  } catch (error) {
    server.closeAllConnections();
    if (server.listening) {
      try {
        await close();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Fixture startup failed.',
        );
      }
    }
    throw error;
  }
}
