import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { createServer } from 'node:http';
import type { VerificationProof } from '../../../src/runtime/verification';

export type VerificationOutcome =
  'accepted' | 'wrong-key' | 'wrong-challenge' | 'replay' | 'expired';

/** A real loopback MCP service that verifies and consumes its own challenge. */
export async function startVerificationPeer(
  outcome: VerificationOutcome = 'accepted',
) {
  const enrollment = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const challenge = Buffer.from(
    'synthetic-private-account-and-action-challenge',
  );
  const deadline = Date.now() + (outcome === 'expired' ? -1 : 60_000);
  const replies: Array<{ result?: { action?: string; content?: unknown } }> =
    [];
  const calls: unknown[] = [];
  const failures: unknown[] = [];
  const handlers = new Set<Promise<void>>();
  const answered = Promise.withResolvers<void>();
  const releaseVerification = Promise.withResolvers<void>();
  const incoming = Promise.withResolvers<
    (typeof replies)[number] | undefined
  >();
  let accepted = false;
  let consumed = outcome === 'replay';
  let joinedCalls = 0;
  const server = createServer((request, response) => {
    const work = (async () => {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      if (!rpc.method) {
        replies.push(rpc);
        if (rpc.id === 873) {
          incoming.resolve(rpc);
          answered.resolve();
        }
        response.writeHead(202).end();
        return;
      }
      let result: unknown = {};
      if (rpc.method === 'initialize')
        result = {
          protocolVersion: rpc.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'synthetic-verifier', version: '1' },
        };
      else if (rpc.method === 'tools/list')
        result = {
          tools: [
            {
              name: 'search',
              description: 'Read one synthetic verification result',
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                openWorldHint: false,
              },
              inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
            },
          ],
        };
      else if (rpc.method === 'tools/call') {
        calls.push(rpc.params);
        response.once('close', () => incoming.resolve(undefined));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            id: 873,
            method: 'openai/elicitation/create',
            params: {
              mode: 'openai/userVerification',
              title: 'Approve a synthetic action',
              description: 'Service text is not authority',
              challenge: challenge.toString('base64url'),
            },
          })}\n\n`,
        );
        try {
          const answer = await incoming.promise;
          await releaseVerification.promise;
          const value = answer?.result?.content as
            VerificationProof | undefined;
          accepted =
            !response.destroyed &&
            answer?.result?.action === 'accept' &&
            !consumed &&
            Date.now() < deadline &&
            value?.credentialId === 'synthetic-enrolled-credential' &&
            typeof value.signature === 'string' &&
            verify(
              'sha256',
              challenge,
              enrollment.publicKey,
              Buffer.from(value.signature, 'base64url'),
            );
          if (accepted) consumed = true;
          result = {
            isError: !accepted,
            content: [
              {
                type: 'text',
                text: accepted
                  ? 'verification_accepted'
                  : 'verification_rejected',
              },
            ],
          };
          if (!response.destroyed)
            response.end(
              `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`,
            );
        } finally {
          joinedCalls++;
        }
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    })().catch((error) => {
      failures.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
    handlers.add(work);
    void work.finally(() => handlers.delete(work));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing verifier fixture address');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    replies,
    answered: answered.promise,
    get accepted() {
      return accepted;
    },
    get joinedCalls() {
      return joinedCalls;
    },
    releaseVerification: () => releaseVerification.resolve(),
    proof(bytes: Uint8Array): VerificationProof {
      return {
        credentialId: 'synthetic-enrolled-credential',
        signature: sign(
          'sha256',
          outcome === 'wrong-challenge'
            ? Buffer.from('another-challenge')
            : bytes,
          outcome === 'wrong-key' ? other.privateKey : enrollment.privateKey,
        ).toString('base64url'),
      };
    },
    async close() {
      releaseVerification.resolve();
      incoming.resolve(undefined);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await Promise.all(handlers);
      if (failures.length)
        throw new AggregateError(failures, 'Verifier fixture failed');
    },
  };
}
