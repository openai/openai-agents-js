import { createServer } from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { AgentCard, Task } from '@a2a-js/sdk';
import { connectA2A } from '../src/a2a/client';

it.each(
  ['discovery', 'RPC'].flatMap((phase) =>
    ['gzip', 'identity', 'absent', 'empty'].map((coding) => ({
      phase,
      coding,
    })),
  ),
)(
  'checks $coding coding before consuming the held $phase response',
  async ({ phase, coding }) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<boolean>();
    const limit = 1024;
    let released = false;
    let credentials = 0;
    const requestedEncodings: (string | undefined)[] = [];
    const server = createServer(async (request, response) => {
      const discovery = request.url === '/card';
      requestedEncodings.push(request.headers['accept-encoding']);
      let id: unknown;
      if (!discovery) {
        let body = '';
        for await (const chunk of request) body += chunk;
        id = JSON.parse(body).id;
      }
      const payload = Buffer.from(
        JSON.stringify(
          discovery
            ? AgentCard.toJSON(card)
            : {
                jsonrpc: '2.0',
                id,
                result: Task.toJSON(
                  Task.fromJSON({
                    id: 'task',
                    contextId: 'context',
                    status: { state: 'TASK_STATE_COMPLETED' },
                  }),
                ),
              },
        ),
      );
      const selected = discovery === (phase === 'discovery');
      expect(payload.byteLength).toBeLessThan(limit);
      response.setHeader('Content-Type', 'application/json');
      if (selected && coding === 'gzip') {
        const gzip = gzipSync(payload);
        const header = Buffer.from(gzip.subarray(0, 10));
        header[3] |= 8;
        // A legal gzip filename exceeds the cap without producing decoded bytes.
        const prefix = Buffer.concat([header, Buffer.alloc(limit * 8, 97)]);
        expect(prefix.byteLength).toBeGreaterThan(limit);
        response.setHeader('Content-Encoding', 'gzip');
        response.on('close', () => closed.resolve(!released));
        response.flushHeaders();
        response.write(prefix);
        entered.resolve();
        await release.promise;
        if (!response.destroyed)
          response.end(Buffer.concat([Buffer.from([0]), gzip.subarray(10)]));
      } else {
        if (selected && coding === 'empty')
          response.setHeader('Content-Encoding', '');
        else if (coding !== 'absent')
          response.setHeader('Content-Encoding', 'identity');
        response.end(payload);
        if (selected) entered.resolve();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing server address');
    const base = `http://127.0.0.1:${address.port}`;
    const card = AgentCard.fromJSON({
      name: 'bounded',
      version: '1',
      supportedInterfaces: [
        {
          url: `${base}/rpc`,
          protocolVersion: '1.0',
          protocolBinding: 'JSONRPC',
        },
      ],
    });
    const open = () =>
      connectA2A(
        { name: 'bounded', cardUrl: `${base}/card`, rpcUrl: `${base}/rpc` },
        {
          authorization: async () => {
            credentials++;
            return 'synthetic';
          },
          limits: { bodyBytes: limit },
        },
      );
    try {
      const operation =
        phase === 'discovery'
          ? open()
          : (await open()).getTask({ tenant: '', id: 'task' });
      const result = operation.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await entered.promise;
      if (coding === 'gzip') {
        const early = await Promise.race([
          result.then(() => true),
          new Promise<false>((resolve) =>
            setTimeout(() => resolve(false), 500),
          ),
        ]);
        if (!early) {
          released = true;
          release.resolve();
        }
        const outcome = await result;
        expect(early).toBe(true);
        expect('error' in outcome && outcome.error).toMatchObject({
          reason: 'unsupported',
        });
        expect(await closed.promise).toBe(true);
        expect(credentials).toBe(phase === 'discovery' ? 0 : 1);
      } else if (coding === 'empty') {
        const outcome = await result;
        expect('error' in outcome && outcome.error).toMatchObject({
          reason: 'unsupported',
        });
      } else {
        expect('value' in (await result)).toBe(true);
      }
      expect(requestedEncodings).toEqual(
        Array(phase === 'discovery' ? 1 : 2).fill('identity'),
      );
    } finally {
      released = true;
      release.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  10_000,
);
