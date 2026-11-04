import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Agent,
  NativeError,
  type Session,
  type SteeringReceipt,
  type TurnNeedsAttention,
} from '@openai/agents';
import { expect, it, vi } from 'vitest';
import {
  publishAcceptedDraft,
  readWorkerSnapshot,
  superviseArtifact,
} from '../../examples/supervised-worker/worker';
import { BorrowedPeer, borrowedDeclaration } from './fixtures/borrowed-mcp';

function runWorker(directory: string, steer?: string) {
  const server = new BorrowedPeer();
  server.declarations = [borrowedDeclaration('report')];
  return superviseArtifact({
    directory,
    provider: { apiKey: 'synthetic-test' },
    model: 'fixture',
    reports: { name: 'reports', server },
    task: 'Draft a release note.',
    ...(steer === undefined ? {} : { steer }),
  });
}

it('records attention before disposing the session when submission rejects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-worker-submission-'));
  const error = new Error('Synthetic submission failure.');
  let snapshotAtDisposal: Awaited<ReturnType<typeof readWorkerSnapshot>>;
  const session = vi.spyOn(Agent.prototype, 'session').mockResolvedValue({
    id: 'thread',
    async [Symbol.asyncDispose]() {
      snapshotAtDisposal = await readWorkerSnapshot(directory);
    },
    async submit() {
      throw error;
    },
  } as unknown as Session);
  try {
    await expect(runWorker(directory)).rejects.toBe(error);
    expect(snapshotAtDisposal).toMatchObject({
      threadId: 'thread',
      state: 'needs_attention',
    });
  } finally {
    session.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

it('records attention before session disposal when cancelling active work fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-worker-cancel-'));
  const entered = Promise.withResolvers<void>();
  const steering = Promise.withResolvers<SteeringReceipt>();
  const observed = Promise.withResolvers<void>();
  const primary = new Error('Synthetic wait failure.');
  const cleanup = new Error('Synthetic cancellation failure.');
  const receipt = {
    sessionId: 'thread',
    submissionId: 'submission',
    turnId: 'turn',
    inputId: 'input',
  };
  let snapshotAtDisposal: Awaited<ReturnType<typeof readWorkerSnapshot>>;
  const dispose = vi.fn(async () => {
    snapshotAtDisposal = await readWorkerSnapshot(directory);
    steering.resolve(receipt);
    await observed.promise;
  });
  const session = vi.spyOn(Agent.prototype, 'session').mockResolvedValue({
    id: 'thread',
    [Symbol.asyncDispose]: dispose,
    async submit() {
      return {
        async *events() {
          try {
            yield { type: 'turn_started', turnId: 'turn' };
          } finally {
            observed.resolve();
          }
        },
        async steerExact() {
          entered.resolve();
          return steering.promise;
        },
        async waitForAttention() {
          await entered.promise;
          throw primary;
        },
        async cancel() {
          throw cleanup;
        },
      };
    },
  } as unknown as Session);
  try {
    await expect(
      runWorker(directory, 'Revise the release note.'),
    ).rejects.toMatchObject({
      name: 'AggregateError',
      cause: primary,
      errors: [primary, cleanup],
    });
    expect(dispose).toHaveBeenCalledOnce();
    expect(snapshotAtDisposal).toMatchObject({ state: 'needs_attention' });
    await expect(readWorkerSnapshot(directory)).resolves.toMatchObject({
      state: 'needs_attention',
    });
    await expect(publishAcceptedDraft(directory)).rejects.toThrow(
      'Publication requires an accepted draft.',
    );
  } finally {
    session.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

it('preserves the classified error and saves its attention reason', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-worker-attention-'));
  const error = new NativeError('Synthetic rate limit.', {
    category: 'rate_limit_exceeded',
    statusCode: 429,
    retryAfterMs: 1000,
  });
  const session = vi.spyOn(Agent.prototype, 'session').mockResolvedValue({
    id: 'thread',
    async [Symbol.asyncDispose]() {},
    async submit() {
      return {
        async *events() {},
        async waitForAttention() {
          return {
            type: 'needs_attention',
            reason: 'rate_limited',
            error,
            rateLimits: {},
          } satisfies TurnNeedsAttention;
        },
        async cancel() {},
      };
    },
  } as unknown as Session);
  try {
    await expect(runWorker(directory)).rejects.toBe(error);
    await expect(readWorkerSnapshot(directory)).resolves.toMatchObject({
      threadId: 'thread',
      state: 'needs_attention',
      attention: 'rate_limited',
    });
  } finally {
    session.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

it('saves a review snapshot when reading completed history fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-worker-history-'));
  const workspace = join(directory, 'workspace');
  const draft = '# Release note\nExample draft.\n';
  const sha256 = createHash('sha256').update(draft).digest('hex');
  const error = new Error('Synthetic history read failure.');
  const claim = { summary: 'Draft ready.', question: null };
  const session = vi.spyOn(Agent.prototype, 'session').mockResolvedValue({
    id: 'thread',
    async [Symbol.asyncDispose]() {},
    async submit() {
      return {
        turnId: 'turn',
        async *events() {},
        async waitForAttention() {
          return { finalOutput: claim };
        },
      };
    },
    async *items() {
      yield {
        id: 'partial-evidence',
        turnId: 'turn',
        type: 'command_execution',
        status: 'completed',
        exitCode: 0,
        cwd: await realpath(workspace),
        command: 'sha256sum draft.md',
        output: sha256 + '  draft.md',
      };
      throw error;
    },
  } as unknown as Session);
  try {
    await mkdir(workspace);
    await writeFile(join(workspace, 'draft.md'), draft);
    await expect(runWorker(directory)).rejects.toBe(error);
    const snapshot = await readWorkerSnapshot(directory);
    expect(snapshot).toMatchObject({
      threadId: 'thread',
      state: 'needs_review',
      claim,
      timings: { completionMs: expect.any(Number) },
    });
    expect(snapshot?.evidence).toBeUndefined();
    await expect(publishAcceptedDraft(directory)).rejects.toThrow(
      'Publication requires an accepted draft.',
    );
  } finally {
    session.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
