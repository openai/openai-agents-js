/* global AbortSignal, process */
import assert from 'node:assert/strict';

const [codexHome, accountId, expectedJson] = process.argv.slice(2);
let stage = 'import the root SDK';
try {
  const { Agent, NativeError, NativeProvider } = await import('@openai/agents');
  const expected = JSON.parse(expectedJson);
  stage = 'construct the saved login provider';
  const provider = new NativeProvider({
    codexLogin: { codexHome, accountId },
    supportsWebsockets: false,
    requestMaxRetries: 1,
    streamMaxRetries: 1,
    streamIdleTimeoutMs: 1_000,
  });
  try {
    stage = 'open the Session';
    const session = await new Agent({
      instructions: 'Reply.',
      model: 'gpt-5.5',
      provider,
    }).session();
    try {
      stage = 'submit the first turn';
      const turn = await session.submit('Reply.');
      if (expected === null) {
        stage = 'wait for ordinary overload recovery';
        assert.equal((await turn.wait()).finalOutput, 'Recovered.');
      } else {
        stage = 'wait for provider attention';
        const attention = await turn.waitForAttention({
          signal: AbortSignal.timeout(8_000),
        });
        stage = 'check typed terminal attention';
        assert.equal(attention.type, 'needs_attention');
        assert.equal(attention.reason, expected.reason);
        assert(attention.error instanceof NativeError);
        const quota = expected.reason === 'quota_blocked';
        assert.equal(
          attention.error.category,
          quota ? 'usage_limit_exceeded' : 'rate_limit_exceeded',
        );
        assert.equal(attention.error.retryable, !quota);

        stage = 'check provider retry metadata';
        assert.deepEqual(attention.rateLimits, expected.rateLimits);
        assert.deepEqual(session.rateLimits(), expected.rateLimits);
        const { retryAfterMs } = attention.error;
        const { retryAfterSeconds } = expected.rateLimits;
        if (retryAfterSeconds !== undefined) {
          assert(retryAfterMs > 0 && retryAfterMs <= retryAfterSeconds * 1_000);
        } else if (!quota) {
          assert.equal(retryAfterMs, 0);
        }
        await assert.rejects(turn.wait(), (error) => error === attention.error);

        stage = 'submit a fresh turn in the same Session';
        const next = await session.submit('Reply again.');
        assert.equal((await next.wait()).finalOutput, 'Recovered.');
      }
    } finally {
      await session.close();
    }
  } finally {
    await provider.close();
  }
} catch {
  // Report only the stage. Native errors can include request diagnostics.
  process.stdout.write(stage);
  process.exitCode = 1;
}
