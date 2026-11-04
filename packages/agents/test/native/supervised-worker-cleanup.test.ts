import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type Session, type SteeringReceipt } from '@openai/agents';
import { expect, it, vi } from 'vitest';
import {
  publishAcceptedDraft,
  readWorkerSnapshot,
  superviseArtifact,
} from '../../examples/supervised-worker/worker';
import { BorrowedPeer, borrowedDeclaration } from './fixtures/borrowed-mcp';

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
  const server = new BorrowedPeer();
  server.declarations = [borrowedDeclaration('report')];
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
      superviseArtifact({
        directory,
        provider: { apiKey: 'synthetic-test' },
        model: 'fixture',
        reports: { name: 'reports', server },
        task: 'Draft a release note.',
        steer: 'Revise the release note.',
      }),
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
