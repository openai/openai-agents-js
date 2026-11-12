/* global AbortSignal, process */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const [codexHome, accountId, expectedJson] = process.argv.slice(2);
let stage = 'import the root SDK';
try {
  const { Agent, localStorage, NativeError, NativeProvider } =
    await import('@openai/agents');
  const expected = JSON.parse(expectedJson);
  const rolloutRoot = expected?.useRetryPolicy
    ? join(dirname(codexHome), 'rollouts')
    : undefined;
  stage = 'construct the saved login provider';
  const provider = new NativeProvider({
    codexLogin: { codexHome, accountId },
    supportsWebsockets: false,
    requestMaxRetries: 1,
    streamMaxRetries: 1,
    streamIdleTimeoutMs: expected?.compaction ? 20_000 : 1_000,
  });
  try {
    let retryPolicyCalls = 0;
    stage = 'open the Session';
    const session = await new Agent({
      instructions: 'Reply.',
      model: 'gpt-5.5',
      provider,
      modelSettings: expected?.useRetryPolicy
        ? {
            retry: {
              maxRetries: 1,
              policy: () => {
                retryPolicyCalls++;
                return { retry: true, delayMs: 0 };
              },
            },
          }
        : undefined,
    }).session(rolloutRoot ? { storage: localStorage(rolloutRoot) } : {});
    try {
      stage = 'submit the first turn';
      let turn = await session.submit('Reply.');
      if (expected?.compaction) {
        stage = 'wait for the warm up turn';
        assert.equal((await turn.wait()).finalOutput, 'Recovered.');
        stage = 'submit the turn that triggers compaction';
        turn = await session.submit('Reply again.');
      }
      if (expected === null) {
        stage = 'wait for ordinary overload recovery';
        assert.equal((await turn.wait()).finalOutput, 'Recovered.');
      } else {
        stage = 'wait for provider attention';
        const signal = AbortSignal.timeout(8_000);
        const attention = await turn
          .waitForAttention({ signal })
          .catch((error) => {
            if (error === signal.reason) stage = 'provider attention deadline';
            throw error;
          });
        if (expected.useRetryPolicy) {
          stage = 'check terminal quota bypassed retry policy';
          assert.equal(retryPolicyCalls, 0);
        }
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

        if (rolloutRoot) {
          stage = 'close the terminal quota Session';
          await session.close();
          stage = 'check terminal quota attempt rollout';
          const rollout = (
            await readdir(rolloutRoot, { recursive: true })
          ).find((name) => name.endsWith(`${session.id}.jsonl`));
          assert(rollout, 'Expected the retained root rollout');
          const attempts = (await readFile(join(rolloutRoot, rollout), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
            .filter(
              ({ type, payload }) =>
                type === 'event_msg' &&
                payload.type === '_sdk_model_attempt' &&
                payload.turn_id === turn.turnId,
            )
            .map(({ payload }) => payload.data);
          assert.deepEqual(
            attempts.map(({ phase }) => phase),
            ['started', 'finished', 'terminal'],
          );
          const attemptId = attempts[0].attempt_id;
          assert.match(attemptId, /\S/);
          for (const attempt of attempts) {
            assert.equal(attempt.attempt_id, attemptId);
            assert.equal(attempt.owner_attempt_id, attemptId);
            assert.equal(attempt.terminal_attempt_id, null);
          }
          assert.deepEqual(
            attempts.slice(1).map(({ usage }) => usage.requests),
            [1, 1],
          );
        }

        if (!expected.compaction && !expected.useRetryPolicy) {
          stage = 'submit a fresh turn in the same Session';
          const next = await session.submit('Reply again.');
          assert.equal((await next.wait()).finalOutput, 'Recovered.');
        }
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
