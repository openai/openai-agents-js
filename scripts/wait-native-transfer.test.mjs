import assert from 'node:assert/strict';
import { test } from 'vitest';
import { waitForNativeTransfer } from './wait-native-transfer.mjs';

const identity = {
  runId: 42,
  runAttempt: 1,
  headSha: 'a'.repeat(40),
  inputsHash: 'b'.repeat(64),
};
const artifact = { 'artifact-id': '1042', 'artifact-digest': 'c'.repeat(64) };
const prefix = '/repos/openai/openai-agents-js/actions';
const jobsPath = `${prefix}/runs/42/jobs?filter=all&per_page=100`;

function producer(attempt = 1) {
  return {
    id: 700 + attempt,
    name: 'produce-macos / Native bundle (darwin-arm64)',
    run_id: 42,
    run_attempt: attempt,
    head_sha: identity.headSha,
    status: 'completed',
    conclusion: 'success',
    steps: [
      {
        name: 'Publish native bundle',
        number: 20,
        status: 'completed',
        conclusion: 'success',
      },
      {
        name: 'Record native transfer identity',
        number: 21,
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-11-13T03:45:56Z',
        completed_at: '2026-11-13T03:45:56Z',
      },
    ],
  };
}

function receipt(attempt = 1, changes = {}) {
  return (
    '2026-11-13T03:45:56.1525590Z AGENTS_NATIVE_TRANSFER ' +
    JSON.stringify({
      runId: 42,
      runAttempt: attempt,
      headSha: identity.headSha,
      inputsHash: identity.inputsHash,
      artifact: { ...artifact, 'artifact-url': 'ignored action output' },
      ...changes,
    })
  );
}

function fixture() {
  const state = {
    jobs: [producer()],
    log: receipt(),
    requests: [],
    clock: 0,
    reads: 0,
  };
  state.options = {
    ...identity,
    timeoutMs: 60,
    pollIntervalMs: 20,
    now: () => state.clock,
    pause: async (ms) => {
      state.clock += ms;
    },
    get: async (path, options) => {
      state.requests.push(path);
      assert(options.timeoutMs > 0);
      if (path === jobsPath) {
        state.reads++;
        const jobs =
          typeof state.jobs === 'function' ? state.jobs() : state.jobs;
        return state.listing ?? { total_count: jobs.length, jobs };
      }
      assert.match(
        path,
        /^\/repos\/openai\/openai-agents-js\/actions\/jobs\/70[12]\/steps\/21\/logs$/,
      );
      assert.equal(options.text, true);
      return typeof state.log === 'function' ? state.log(path) : state.log;
    },
  };
  return state;
}

test('returns only the exact upload pair from the authenticated receipt step', async () => {
  const state = fixture();
  assert.deepEqual(await waitForNativeTransfer(state.options), artifact);
  assert.deepEqual(state.requests, [
    jobsPath,
    `${prefix}/jobs/701/steps/21/logs`,
    jobsPath,
  ]);
});

test('accepts fractional log timestamps for a zero-duration step', async () => {
  const state = fixture();
  const step = state.jobs[0].steps[1];
  assert.equal(step.started_at, step.completed_at);
  assert.deepEqual(await waitForNativeTransfer(state.options), artifact);
});

test('ignores the marker inside echoed producer command text', async () => {
  const state = fixture();
  state.log =
    '2026-11-13T03:45:56Z console.log("AGENTS_NATIVE_TRANSFER " + json)\n' +
    receipt();
  assert.deepEqual(await waitForNativeTransfer(state.options), artifact);
});

test('reuses the latest successful earlier producer for a failed-job rerun', async () => {
  const state = fixture();
  state.options.runAttempt = 2;
  assert.deepEqual(await waitForNativeTransfer(state.options), artifact);
});

test('selects a newer successful producer instead of the earlier attempt', async () => {
  const state = fixture();
  state.options.runAttempt = 2;
  state.jobs.push(producer(2));
  state.log = receipt(2);
  assert.deepEqual(await waitForNativeTransfer(state.options), artifact);
  assert(state.requests.includes(`${prefix}/jobs/702/steps/21/logs`));
  assert(!state.requests.includes(`${prefix}/jobs/701/steps/21/logs`));
});

test('waits for a newer queued producer without consuming the earlier receipt', async () => {
  const state = fixture();
  state.options.runAttempt = 2;
  state.jobs = () => [
    producer(),
    {
      ...producer(2),
      status: state.clock ? 'completed' : 'queued',
    },
  ];
  state.log = receipt(2);
  assert.deepEqual(await waitForNativeTransfer(state.options), artifact);
  assert.equal(state.clock, 20);
  assert(!state.requests.includes(`${prefix}/jobs/701/steps/21/logs`));
});

test('does not fall back when a newer producer failed', async () => {
  const state = fixture();
  state.options.runAttempt = 2;
  state.jobs.push({ ...producer(2), conclusion: 'failure' });
  await assert.rejects(
    waitForNativeTransfer(state.options),
    /producer did not succeed/,
  );
  assert.deepEqual(state.requests, [jobsPath]);
});

test('rejects a newer producer appearing during receipt verification', async () => {
  const state = fixture();
  state.options.runAttempt = 2;
  state.jobs = () =>
    state.reads === 1 ? [producer()] : [producer(), producer(2)];
  await assert.rejects(
    waitForNativeTransfer(state.options),
    /producer changed/,
  );
});

test.each([
  ['run_id', 99],
  ['head_sha', 'd'.repeat(40)],
  ['run_attempt', 2],
  ['run_attempt', 0],
])(
  'rejects a producer with the wrong %s identity (%s)',
  async (field, value) => {
    const state = fixture();
    state.jobs[0][field] = value;
    await assert.rejects(
      waitForNativeTransfer(state.options),
      /producer identity/,
    );
  },
);

test('rejects ambiguous exact-name producers even when one succeeded', async () => {
  const state = fixture();
  state.jobs.push({ ...producer(), id: 702, conclusion: 'skipped' });
  await assert.rejects(waitForNativeTransfer(state.options), /Ambiguous/);
});

test.each([
  ['runId', 99],
  ['runAttempt', 2],
  ['headSha', 'd'.repeat(40)],
  ['inputsHash', 'd'.repeat(64)],
])('rejects a receipt with the wrong %s', async (field, value) => {
  const state = fixture();
  state.log = receipt(1, { [field]: value });
  await assert.rejects(
    waitForNativeTransfer(state.options),
    /receipt identity/,
  );
});

test('binds a reused receipt to its producer attempt, not the waiter attempt', async () => {
  const state = fixture();
  state.options.runAttempt = 2;
  state.log = receipt(2);
  await assert.rejects(
    waitForNativeTransfer(state.options),
    /receipt identity/,
  );
});

test.each([
  ['artifact-id', '0'],
  ['artifact-id', '01'],
  ['artifact-id', '9007199254740992'],
  ['artifact-id', 1042],
  ['artifact-digest', 'C'.repeat(64)],
  ['artifact-digest', 'sha256:' + 'c'.repeat(64)],
])('rejects malformed %s (%s)', async (field, value) => {
  const state = fixture();
  state.log = receipt(1, { artifact: { ...artifact, [field]: value } });
  await assert.rejects(
    waitForNativeTransfer(state.options),
    /artifact ID or digest/,
  );
});

test.each(['', receipt() + '\n' + receipt()])(
  'rejects missing or duplicate receipt records',
  async (log) => {
    const state = fixture();
    state.log = log;
    await assert.rejects(
      waitForNativeTransfer(state.options),
      /Missing or duplicate/,
    );
  },
);

test.each(['upload', 'receipt'])(
  'requires successful %s steps',
  async (which) => {
    const state = fixture();
    state.jobs[0].steps[which === 'upload' ? 0 : 1].conclusion = 'failure';
    await assert.rejects(
      waitForNativeTransfer(state.options),
      /step did not succeed/,
    );
  },
);

test.each(['missing', 'duplicate', 'reversed'])(
  'rejects %s producer step proof',
  async (which) => {
    const state = fixture();
    if (which === 'missing') state.jobs[0].steps.pop();
    if (which === 'duplicate')
      state.jobs[0].steps.push({ ...state.jobs[0].steps[1] });
    if (which === 'reversed') state.jobs[0].steps[1].number = 19;
    await assert.rejects(
      waitForNativeTransfer(state.options),
      /duplicate|follow publication/,
    );
  },
);

test('polls absent or running producers to a bounded timeout', async () => {
  const state = fixture();
  state.jobs = () =>
    state.clock ? [{ ...producer(), status: 'in_progress' }] : [];
  await assert.rejects(waitForNativeTransfer(state.options), /Timed out/);
  assert.equal(state.clock, 60);
  assert(state.requests.every((path) => path === jobsPath));
});

test('retries a temporarily unavailable successful receipt step', async () => {
  const state = fixture();
  state.log = () => {
    if (!state.clock)
      throw Object.assign(new Error('not ready'), { status: 404 });
    return receipt();
  };
  assert.deepEqual(await waitForNativeTransfer(state.options), artifact);
  assert.equal(state.clock, 20);
});

test('stops on authorization failure without retrying', async () => {
  const state = fixture();
  state.log = () => {
    throw Object.assign(new Error('forbidden'), { status: 403 });
  };
  await assert.rejects(waitForNativeTransfer(state.options), /forbidden/);
  assert.equal(state.clock, 0);
});

test.each([
  { total_count: 101, jobs: [] },
  { total_count: 2, jobs: [producer()] },
])('fails closed on incomplete or oversized history', async (listing) => {
  const state = fixture();
  state.listing = listing;
  await assert.rejects(waitForNativeTransfer(state.options), /job listing/);
});
