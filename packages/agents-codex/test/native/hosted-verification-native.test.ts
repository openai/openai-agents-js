import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  HostedVerificationMCP,
  HttpMCP,
  NativeProvider,
  type Session,
} from '../../src';
import type { UserVerificationRequest } from '../../src/runtime/verification';
import { TurnAborted } from '../../src/runtime/session';
import { ModelServer, call, message } from './fixtures/model-server';
import {
  startVerificationPeer,
  type VerificationOutcome,
} from './fixtures/hosted-verification';

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

async function closeApplication(
  session: Session | undefined,
  provider: NativeProvider,
  ...peers: Awaited<ReturnType<typeof startVerificationPeer>>[]
) {
  for (const peer of peers) peer.releaseVerification();
  const failures: unknown[] = [];
  for (const close of [
    () => session?.close(),
    () => provider.close(),
    ...peers.map((peer) => () => peer.close()),
  ]) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, 'Verification cleanup failed');
}

function isVerification(value: unknown): value is UserVerificationRequest {
  return (
    !!value &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'user_verification_request'
  );
}

async function application(url: string, trusted = true) {
  const model = new ModelServer([
    [
      call(
        'search',
        {},
        {
          callId: 'verify-one',
          namespace: trusted ? 'mcp__codex_apps' : 'mcp__ordinary',
        },
      ),
    ],
    [message('finished')],
  ]);
  const config = await model.config();
  const route = config['model_providers.fixture'] as { base_url: string };
  const provider = new NativeProvider({
    baseUrl: route.base_url,
    apiKey: 'synthetic-model-key',
    supportsWebsockets: false,
  });
  const registration = trusted
    ? new HostedVerificationMCP({ url, tools: ['search'] })
    : new HttpMCP({ name: 'ordinary', url, tools: ['search'] });
  return {
    model,
    provider,
    registration,
    agent: new Agent({
      instructions: 'Use search once.',
      model: 'gpt-5',
      provider,
      tools: [registration],
    }),
  };
}

it.each<VerificationOutcome>([
  'accepted',
  'wrong-key',
  'wrong-challenge',
  'replay',
  'expired',
])(
  'the registered service verifies and consumes the original challenge: %s',
  async (outcome) => {
    const peer = await startVerificationPeer(outcome);
    const f = await application(peer.url);
    let session: Session | undefined;
    try {
      session = await f.agent.session();
      const turn = await session.submit('Verify this synthetic action');
      const pending = await turn.wait({ until: 'interaction' });
      if (!('requests' in pending) || !isVerification(pending.requests[0]))
        throw new Error('Expected the registered native verification request');
      const request = pending.requests[0];
      expect(request.sessionId).toBe(session.id);
      expect(request.subagentId).toBeNull();
      expect(request.turnId).toBe(turn.turnId);
      expect(JSON.stringify(request)).not.toContain('synthetic-private');
      request.challenge.fill(255);
      expect(() =>
        request.reply({ credentialId: 'enrolled', signature: 'AAB' }),
      ).toThrow();
      expect(peer.replies).toHaveLength(0);
      const proof = peer.proof(request.challenge);
      const reply = request.reply(proof);
      const duplicate = request.reply(proof);
      let completed = false;
      const completion = turn.wait().finally(() => {
        completed = true;
      });
      completion.catch(() => {});
      await session.respond(reply);
      await peer.answered;
      // Enqueue and peer receipt cannot stand in for verification or consumption.
      expect(completed).toBe(false);
      expect(peer.accepted).toBe(false);
      await expect(session.respond(duplicate)).rejects.toThrow();
      peer.releaseVerification();
      expect((await completion).finalOutput).toBe('finished');
      expect(peer.accepted).toBe(outcome === 'accepted');
      expect(JSON.stringify(f.model.requests[1]?.input)).toContain(
        outcome === 'accepted'
          ? 'verification_accepted'
          : 'verification_rejected',
      );
      expect(peer.calls).toHaveLength(1);
      expect(peer.replies).toHaveLength(1);
      expect(() => request.reply(proof)).toThrow();
    } finally {
      await closeApplication(session, f.provider, peer);
    }
    expect(peer.joinedCalls).toBe(1);
  },
  30_000,
);

it('does not expose signer authority for an ordinary MCP registration', async () => {
  const peer = await startVerificationPeer();
  peer.releaseVerification();
  const f = await application(peer.url, false);
  let session: Session | undefined;
  try {
    session = await f.agent.session();
    const turn = await session.submit('Use the ordinary service');
    expect((await turn.wait()).finalOutput).toBe('finished');
    expect(await session.pendingInteractions()).toEqual([]);
    expect(peer.accepted).toBe(false);
    expect(
      peer.replies.every((reply) => reply.result?.action !== 'accept'),
    ).toBe(true);
    expect(peer.calls).toHaveLength(1);
  } finally {
    await closeApplication(session, f.provider, peer);
  }
}, 30_000);

it('revokes the exact pending request on cancellation and physically joins the peer', async () => {
  const peer = await startVerificationPeer();
  const f = await application(peer.url);
  let session: Session | undefined;
  try {
    session = await f.agent.session();
    const turn = await session.submit('Hold verification');
    const pending = await turn.wait({ until: 'interaction' });
    if (!('requests' in pending) || !isVerification(pending.requests[0]))
      throw new Error('Expected live verification');
    const request = pending.requests[0];
    const reply = request.reply(peer.proof(request.challenge));
    const completion = turn.wait();
    completion.catch(() => {});
    const stopping = turn.cancel({ mode: 'force' });
    peer.releaseVerification();
    await stopping;
    await expect(completion).rejects.toBeInstanceOf(TurnAborted);
    expect(() => request.reply(peer.proof(request.challenge))).toThrow();
    await expect(session.respond(reply)).rejects.toThrow();
    // Native cancellation must settle the remote handler before fixture teardown.
    await expect.poll(() => peer.joinedCalls, { timeout: 5_000 }).toBe(1);
    expect(peer.accepted).toBe(false);
    expect(
      peer.replies.every((answer) => answer.result?.action !== 'accept'),
    ).toBe(true);
  } finally {
    await closeApplication(session, f.provider, peer);
  }
  expect(peer.joinedCalls).toBe(1);
}, 30_000);

it('joins an aborted signer callback and refuses its late proof', async () => {
  const peer = await startVerificationPeer();
  const f = await application(peer.url);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let session: Session | undefined;
  let received: UserVerificationRequest | undefined;
  let callbackSignal: AbortSignal | undefined;
  let joined = false;
  let closed = false;
  const original = f.agent.session.bind(f.agent);
  vi.spyOn(f.agent, 'session').mockImplementation(async (options) => {
    session = await original(options);
    return session;
  });
  const operation = f.agent.run('Verify this action', {
    onNativeQuestion: async (request, signal) => {
      if (!isVerification(request)) throw new Error('Expected verification');
      received = request;
      callbackSignal = signal;
      const prepared = request.reply(peer.proof(request.challenge));
      entered.resolve();
      try {
        await release.promise;
      } finally {
        joined = true;
      }
      return prepared;
    },
  });
  operation.catch(() => {});
  try {
    await Promise.race([
      entered.promise,
      operation.then(() => {
        throw new Error('Run ended before the signer callback');
      }),
    ]);
    const closing = session!.close().finally(() => {
      closed = true;
    });
    closing.catch(() => {});
    await expect
      .poll(() => callbackSignal?.aborted, { timeout: 5_000 })
      .toBe(true);
    expect(joined).toBe(false);
    expect(closed).toBe(false);
    release.resolve();
    peer.releaseVerification();
    await expect(operation).rejects.toThrow();
    await closing;
    expect(joined).toBe(true);
    expect(
      peer.replies.every((answer) => answer.result?.action !== 'accept'),
    ).toBe(true);
    expect(() => received!.reply(peer.proof(received!.challenge))).toThrow();
    await expect.poll(() => peer.joinedCalls, { timeout: 5_000 }).toBe(1);
  } finally {
    release.resolve();
    peer.releaseVerification();
    await operation.catch(() => {});
    await closeApplication(session, f.provider, peer);
  }
}, 30_000);

it('keeps the original host registration fixed after settlement', async () => {
  const peer = await startVerificationPeer();
  const replacement = await startVerificationPeer();
  peer.releaseVerification();
  const f = await application(peer.url);
  let session: Session | undefined;
  try {
    session = await f.agent.session();
    const turn = await session.submit('Verify once');
    const pending = await turn.wait({ until: 'interaction' });
    if (!('requests' in pending) || !isVerification(pending.requests[0]))
      throw new Error('Expected live verification');
    const request = pending.requests[0];
    await session.respond(request.reply(peer.proof(request.challenge)));
    await turn.wait();
    await expect(
      session.update({
        tools: [
          new HostedVerificationMCP({
            url: replacement.url,
            tools: ['search'],
          }),
        ],
      }),
    ).rejects.toThrow(/registration is fixed/i);
    expect(replacement.calls).toHaveLength(0);
  } finally {
    await closeApplication(session, f.provider, peer, replacement);
  }
}, 30_000);
