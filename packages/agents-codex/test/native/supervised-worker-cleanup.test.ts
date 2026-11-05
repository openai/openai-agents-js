import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Agent,
  LocalRecoveryRequired,
  NativeError,
  NativeProvider,
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

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const fs = await importOriginal();
  return {
    ...fs,
    open: vi.fn(fs.open),
    rename: vi.fn(fs.rename),
    rm: vi.fn(fs.rm),
  };
});

function runWorker(
  directory: string,
  options?: Pick<
    Parameters<typeof superviseArtifact>[0],
    'reconcile' | 'startupMs' | 'steer'
  >,
) {
  const server = new BorrowedPeer();
  server.declarations = [borrowedDeclaration('report')];
  return superviseArtifact({
    directory,
    provider: { apiKey: 'synthetic-test' },
    model: 'fixture',
    reports: { name: 'reports', server },
    task: 'Draft a release note.',
    ...options,
  });
}

it('creates a new canonical worker directory before opening its session', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'native-worker-new-'));
  const directory = join(parent, 'new-worker');
  const primary = new Error('Synthetic opening failure.');
  const session = vi
    .spyOn(Agent.prototype, 'session')
    .mockRejectedValue(primary);
  try {
    await expect(runWorker(directory)).rejects.toBe(primary);
    await expect(realpath(join(directory, 'workspace'))).resolves.toBe(
      join(await realpath(directory), 'workspace'),
    );
    expect(session).toHaveBeenCalledOnce();
  } finally {
    session.mockRestore();
    await rm(parent, { recursive: true, force: true });
  }
});

it('journals a joined worker when reopening its profile times out', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-worker-reopen-'));
  let timeout: unknown;
  const session = vi
    .spyOn(Agent.prototype, 'session')
    .mockImplementation(async (options) => {
      const signal = options?.signal;
      if (!signal) throw new Error('Expected a startup deadline.');
      if (!signal.aborted)
        await new Promise<void>((done) => {
          signal.addEventListener('abort', () => done(), { once: true });
        });
      timeout = signal.reason;
      throw timeout;
    });
  try {
    await writeFile(
      join(directory, 'snapshot.json'),
      JSON.stringify({ threadId: 'thread', state: 'working' }),
    );
    const failure = await runWorker(directory, { startupMs: 20 }).catch(
      (error: unknown) => error,
    );
    expect(timeout).toMatchObject({ name: 'TimeoutError' });
    expect(failure).toBe(timeout);
    await expect(readWorkerSnapshot(directory)).resolves.toMatchObject({
      threadId: 'thread',
      state: 'needs_attention',
      attention: 'deadline',
    });
  } finally {
    session.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  {
    label: 'printed hash',
    forge: true,
    accepted: false,
  },
  {
    label: 'output after the hash',
    output: (line: string) => `${line}\nOther output.\n`,
    accepted: false,
  },
  {
    label: 'a shell diagnostic before the hash',
    output: (line: string) =>
      `/bin/bash: warning: setlocale: LC_ALL: cannot change locale (C.UTF-8)\n${line}\n`,
    accepted: true,
  },
  {
    label: 'duplicate hash results',
    output: (line: string) => `${line}\n${line}\n`,
    accepted: false,
  },
  {
    label: 'conflicting hash results',
    output: (line: string) => `${'0'.repeat(64)}  draft.md\n${line}\n`,
    accepted: false,
  },
  {
    label: 'standalone hash',
    accepted: true,
  },
])(
  'checks native command evidence for $label',
  async ({ forge, output, accepted }) => {
    const directory = await mkdtemp(join(tmpdir(), 'native-worker-evidence-'));
    const workspace = join(directory, 'workspace');
    const draft = '# Release note\nExample draft.\n';
    const sha256 = createHash('sha256').update(draft).digest('hex');
    const hashLine = sha256 + '  draft.md';
    const script = forge
      ? `printf '%s\\n' '${hashLine}' # sha256sum draft.md`
      : 'sha256sum draft.md';
    const close = vi.fn(async () => {});
    const session = vi.spyOn(Agent.prototype, 'session').mockResolvedValue({
      id: 'thread',
      close,
      async submit() {
        return {
          turnId: 'turn',
          async *events() {},
          async waitForAttention() {
            return { finalOutput: { summary: 'Draft ready.', question: null } };
          },
        };
      },
      async *items() {
        yield {
          id: 'hash-evidence',
          turnId: 'turn',
          type: 'command_execution',
          status: 'completed',
          exitCode: 0,
          cwd: pathToFileURL(await realpath(workspace)).href,
          command: `/bin/bash -c '${script}'`,
          argv: ['/bin/bash', '-c', script],
          output: output?.(hashLine) ?? hashLine + '\n',
        };
      },
    } as unknown as Session);
    try {
      await mkdir(workspace);
      await writeFile(join(workspace, 'draft.md'), draft);
      const snapshot = await runWorker(directory);
      expect(snapshot.state).toBe(accepted ? 'accepted' : 'needs_review');
      expect(snapshot.evidence).toBe(accepted ? 'hash-evidence' : undefined);
      expect(close).toHaveBeenCalledOnce();
      if (!accepted)
        await expect(publishAcceptedDraft(directory)).rejects.toThrow(
          'Publication requires an accepted draft.',
        );
    } finally {
      session.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each([
  { label: 'no reconciliation callback', reconcile: undefined },
  { label: 'an unverified effect', reconcile: async () => undefined },
])('journals blocked recovery with $label', async ({ reconcile }) => {
  const directory = await mkdtemp(join(tmpdir(), 'native-worker-recovery-'));
  const recovery = new LocalRecoveryRequired(
    [
      {
        threadId: 'thread',
        turnId: 'turn',
        callId: 'call',
        namespace: 'reports',
        name: 'report',
        arguments: '{}',
      },
    ],
    [],
    [],
  );
  const session = vi
    .spyOn(Agent.prototype, 'session')
    .mockRejectedValue(recovery);
  try {
    await writeFile(
      join(directory, 'snapshot.json'),
      JSON.stringify({ threadId: 'thread', state: 'working' }),
    );
    await expect(runWorker(directory, { reconcile })).rejects.toBe(recovery);
    await expect(readWorkerSnapshot(directory)).resolves.toMatchObject({
      threadId: 'thread',
      state: 'needs_attention',
      attention: 'interrupted',
    });
  } finally {
    session.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

it.for([false, true])(
  'publishes the accepted draft with short reads (retarget: %s)',
  async (retarget, context) => {
    if (retarget && process.platform === 'win32')
      context.skip('Requires creating a directory symbolic link.');
    const directory = await mkdtemp(
      join(tmpdir(), 'native-worker-short-read-'),
    );
    const workspace = join(directory, 'workspace');
    const directoryLink = directory + '-link';
    const other = directory + '-other';
    const draft = Buffer.from('# Release note\nExample draft.\n');
    const sha256 = createHash('sha256').update(draft).digest('hex');
    const fs =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    vi.mocked(open).mockImplementationOnce(async (path, flags, mode) => {
      const file = await fs.open(path, flags, mode);
      const read = file.read.bind(file);
      const close = file.close.bind(file);
      // A filesystem read can stop before EOF even when more bytes are available.
      return Object.assign(file, {
        async close() {
          await close();
          if (retarget) {
            await rm(directoryLink);
            await symlink(other, directoryLink, 'dir');
          }
        },
        read(
          buffer: Buffer,
          offset = 0,
          length = buffer.length,
          position = null,
        ) {
          return read(buffer, offset, Math.min(length, 5), position);
        },
      });
    });
    try {
      await mkdir(workspace);
      await writeFile(join(workspace, 'draft.md'), draft);
      await writeFile(
        join(directory, 'snapshot.json'),
        JSON.stringify({ threadId: 'thread', state: 'accepted', sha256 }),
      );
      if (retarget) {
        await mkdir(other);
        await symlink(directory, directoryLink, 'dir');
      }
      const published = await publishAcceptedDraft(
        retarget ? directoryLink : directory,
      );
      const original = join(
        await realpath(directory),
        'published-' + sha256 + '.md',
      );
      await expect(readFile(original)).resolves.toEqual(draft);
      expect(published).toBe(original);
      await expect(readFile(published)).resolves.toEqual(draft);
      if (retarget)
        await expect(
          readFile(join(other, 'published-' + sha256 + '.md')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.mocked(open).mockReset();
      await rm(directoryLink, { force: true });
      await rm(other, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.for([
  'none',
  'session',
  'provider',
  'both',
  'review',
  'retarget',
  'status',
] as const)(
  'accepts and publishes only after owned cleanup succeeds (%s)',
  async (failureAt, context) => {
    if (failureAt === 'retarget' && process.platform === 'win32')
      context.skip('Requires creating a directory symbolic link.');
    const directory = await mkdtemp(
      join(tmpdir(), 'native-worker-accept-close-'),
    );
    const workspace = join(directory, 'workspace');
    const directoryLink = directory + '-link';
    const other = directory + '-other';
    const draft = '# Release note\nExample draft.\n';
    const sha256 = createHash('sha256').update(draft).digest('hex');
    const sessionFailure = new Error('Synthetic session close failure.');
    const providerFailure = new Error('Synthetic provider close failure.');
    const persistenceFailure = new Error(
      'Synthetic attention persistence failure.',
    );
    const order: string[] = [];
    const states: (string | undefined)[] = [];
    const session = vi.spyOn(Agent.prototype, 'session').mockResolvedValue({
      id: 'thread',
      async close() {
        order.push('session');
        states.push((await readWorkerSnapshot(directory))?.state);
        if (failureAt === 'retarget') {
          await rm(directoryLink);
          await symlink(other, directoryLink, 'dir');
        }
        if (failureAt === 'status') {
          vi.mocked(rename).mockRejectedValueOnce(persistenceFailure);
          throw sessionFailure;
        }
        if (
          failureAt === 'session' ||
          failureAt === 'both' ||
          failureAt === 'review'
        )
          throw sessionFailure;
      },
      async submit() {
        return {
          turnId: 'turn',
          async *events() {},
          async waitForAttention() {
            return {
              finalOutput: {
                summary: 'Draft ready.',
                question:
                  failureAt === 'review' ? 'What date should I use?' : null,
              },
            };
          },
        };
      },
      async *items() {
        yield {
          id: 'hash-evidence',
          turnId: 'turn',
          type: 'command_execution',
          status: 'completed',
          exitCode: 0,
          cwd: await realpath(workspace),
          argv: ['/bin/bash', '-c', 'sha256sum draft.md'],
          output: sha256 + '  draft.md\n',
        };
      },
    } as unknown as Session);
    const closeProvider = NativeProvider.prototype.close;
    const provider = vi
      .spyOn(NativeProvider.prototype, 'close')
      .mockImplementation(async function (this: NativeProvider) {
        order.push('provider');
        states.push((await readWorkerSnapshot(directory))?.state);
        await closeProvider.call(this);
        if (failureAt === 'provider' || failureAt === 'both')
          throw providerFailure;
      });
    try {
      await mkdir(workspace);
      await writeFile(join(workspace, 'draft.md'), draft);
      if (failureAt === 'retarget') {
        await mkdir(other);
        await symlink(directory, directoryLink, 'dir');
      }
      const result = await runWorker(
        failureAt === 'retarget' ? directoryLink : directory,
      ).catch((error: unknown) => error);
      expect(order).toEqual(['session', 'provider']);
      if (failureAt === 'none' || failureAt === 'retarget') {
        expect(result).toMatchObject({ state: 'accepted', sha256 });
        await expect(readWorkerSnapshot(directory)).resolves.toMatchObject({
          state: 'accepted',
        });
        if (failureAt === 'retarget')
          await expect(readWorkerSnapshot(other)).resolves.toBeUndefined();
        const published = await publishAcceptedDraft(directory);
        await expect(readFile(published, 'utf8')).resolves.toBe(draft);
      } else {
        if (failureAt === 'status')
          expect(result).toMatchObject({
            name: 'AggregateError',
            cause: sessionFailure,
            errors: [sessionFailure, persistenceFailure],
          });
        else if (failureAt === 'both')
          expect(result).toMatchObject({
            name: 'AggregateError',
            cause: sessionFailure,
            errors: [sessionFailure, providerFailure],
          });
        else
          expect(result).toBe(
            failureAt === 'session' || failureAt === 'review'
              ? sessionFailure
              : providerFailure,
          );
        await expect(publishAcceptedDraft(directory)).rejects.toThrow(
          'Publication requires an accepted draft.',
        );
        expect((await readWorkerSnapshot(directory))?.state).not.toBe(
          'accepted',
        );
      }
      if (failureAt === 'review') {
        expect(states).toEqual(['needs_review', 'needs_review']);
        await expect(readWorkerSnapshot(directory)).resolves.toMatchObject({
          state: 'needs_review',
          claim: { question: 'What date should I use?' },
        });
      } else {
        expect(states).toEqual(['working', 'working']);
        if (['session', 'provider', 'both'].includes(failureAt)) {
          const saved = await readWorkerSnapshot(directory);
          expect(saved).toMatchObject({
            threadId: 'thread',
            state: 'needs_attention',
            attention: 'interrupted',
            claim: { summary: 'Draft ready.', question: null },
          });
          expect(saved?.sha256).toBeUndefined();
          expect(saved?.evidence).toBeUndefined();
        }
      }
    } finally {
      vi.mocked(rename).mockReset();
      provider.mockRestore();
      session.mockRestore();
      await rm(directoryLink, { force: true });
      await rm(other, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each(['read', 'validation', 'success'] as const)(
  'preserves the draft outcome when closing its file fails (%s)',
  async (outcome) => {
    const directory = await mkdtemp(
      join(tmpdir(), 'native-worker-draft-close-'),
    );
    const workspace = join(directory, 'workspace');
    const primary = new Error('Synthetic draft read failure.');
    const cleanup = new Error('Synthetic draft close failure.');
    const fs =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    try {
      await mkdir(workspace);
      await writeFile(
        join(workspace, 'draft.md'),
        outcome === 'validation'
          ? Buffer.alloc(4097)
          : '# Release note\nDraft.\n',
      );
      await writeFile(
        join(directory, 'snapshot.json'),
        JSON.stringify({
          threadId: 'thread',
          state: 'accepted',
          sha256: '0'.repeat(64),
        }),
      );
      const closed = vi.fn();
      vi.mocked(open).mockImplementationOnce(async (path, flags, mode) => {
        const file = await fs.open(path, flags, mode);
        const close = file.close.bind(file);
        const read = file.read.bind(file);
        return Object.assign(file, {
          read:
            outcome === 'read'
              ? async () => {
                  throw primary;
                }
              : read,
          async close() {
            await close();
            closed();
            throw cleanup;
          },
        });
      });
      const failure = await publishAcceptedDraft(directory).catch(
        (error: unknown) => error,
      );
      expect(closed).toHaveBeenCalledOnce();
      if (outcome === 'success') expect(failure).toBe(cleanup);
      else {
        expect(failure).toBeInstanceOf(AggregateError);
        const cause = (failure as AggregateError).cause;
        if (outcome === 'read') expect(cause).toBe(primary);
        else
          expect(cause).toMatchObject({
            message: 'Draft must be a private regular file of at most 4 KiB.',
          });
        expect((failure as AggregateError).errors).toEqual([cause, cleanup]);
      }
      await expect(
        readFile(join(directory, 'published-' + '0'.repeat(64) + '.md')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.mocked(open).mockReset();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it('preserves a snapshot write failure when temporary file cleanup also fails', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'native-worker-atomic-write-'),
  );
  const persistence = new Error('Synthetic snapshot rename failure.');
  const cleanup = new Error('Synthetic temporary file removal failure.');
  const session = vi.spyOn(Agent.prototype, 'session').mockResolvedValue({
    id: 'thread',
    async close() {},
  } as unknown as Session);
  vi.mocked(rename).mockRejectedValueOnce(persistence);
  vi.mocked(rm).mockRejectedValueOnce(cleanup);
  try {
    await expect(runWorker(directory)).rejects.toMatchObject({
      name: 'AggregateError',
      cause: persistence,
      errors: [persistence, cleanup],
    });
    await expect(readWorkerSnapshot(directory)).resolves.toBeUndefined();
  } finally {
    vi.mocked(rename).mockReset();
    vi.mocked(rm).mockReset();
    session.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

it('records attention before disposing the session when submission rejects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-worker-submission-'));
  const error = new Error('Synthetic submission failure.');
  let snapshotAtDisposal: Awaited<ReturnType<typeof readWorkerSnapshot>>;
  const session = vi.spyOn(Agent.prototype, 'session').mockResolvedValue({
    id: 'thread',
    async close() {
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

it.each([false, true])(
  'preserves the submission failure when close rejects (provider also rejects: %s)',
  async (providerRejects) => {
    const directory = await mkdtemp(join(tmpdir(), 'native-worker-close-'));
    const primary = new Error('Synthetic submission failure.');
    const sessionFailure = new Error('Synthetic session close failure.');
    const providerFailure = new Error('Synthetic provider close failure.');
    const order: string[] = [];
    let snapshotAtClose: Awaited<ReturnType<typeof readWorkerSnapshot>>;
    const close = async () => {
      order.push('session');
      snapshotAtClose = await readWorkerSnapshot(directory);
      throw sessionFailure;
    };
    const session = vi.spyOn(Agent.prototype, 'session').mockResolvedValue({
      id: 'thread',
      close,
      [Symbol.asyncDispose]: close,
      async submit() {
        throw primary;
      },
    } as unknown as Session);
    const closeProvider = NativeProvider.prototype.close;
    const provider = vi
      .spyOn(NativeProvider.prototype, 'close')
      .mockImplementation(async function (this: NativeProvider) {
        order.push('provider');
        if (providerRejects) throw providerFailure;
        await closeProvider.call(this);
      });
    try {
      const failure = await runWorker(directory).catch(
        (error: unknown) => error,
      );
      expect(snapshotAtClose).toMatchObject({
        threadId: 'thread',
        state: 'needs_attention',
      });
      expect(order).toEqual(['session', 'provider']);
      expect(failure).toMatchObject({
        name: 'AggregateError',
        cause: primary,
        errors: [
          primary,
          providerRejects
            ? expect.objectContaining({
                cause: sessionFailure,
                errors: [sessionFailure, providerFailure],
              })
            : sessionFailure,
        ],
      });
      expect((failure as AggregateError).cause).toBe(primary);
    } finally {
      provider.mockRestore();
      session.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

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
    close: dispose,
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
      runWorker(directory, { steer: 'Revise the release note.' }),
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
    async close() {},
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
    async close() {},
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
        command: "/bin/bash -c 'sha256sum draft.md'",
        argv: ['/bin/bash', '-c', 'sha256sum draft.md'],
        output: sha256 + '  draft.md\n',
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

it.each(['matching', 'different'] as const)(
  'retries publication directory sync for existing bytes (%s)',
  async (contents) => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'native-worker-publish-sync-')),
    );
    const draft = Buffer.from('# Release note\nDurable draft.\n');
    const sha256 = createHash('sha256').update(draft).digest('hex');
    const failure = new Error('Synthetic directory sync failure.');
    const fs =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    let attempts = 0;
    try {
      await mkdir(join(directory, 'workspace'));
      await writeFile(join(directory, 'workspace', 'draft.md'), draft);
      await writeFile(
        join(directory, 'snapshot.json'),
        JSON.stringify({ threadId: 'thread', state: 'accepted', sha256 }),
      );
      vi.mocked(open).mockImplementation(async (path, flags, mode) => {
        const file = await fs.open(path, flags, mode);
        if (path !== directory) return file;
        const close = file.close.bind(file);
        return Object.assign(Object.create(file), {
          async sync() {
            attempts++;
            if (attempts < 3) throw failure;
            await file.sync();
          },
          close,
        });
      });
      const destination = join(directory, 'published-' + sha256 + '.md');
      await expect(publishAcceptedDraft(directory)).rejects.toBe(failure);
      await expect(readFile(destination)).resolves.toEqual(draft);
      if (contents === 'different') {
        await writeFile(destination, 'Other publication');
        await expect(publishAcceptedDraft(directory)).rejects.toMatchObject({
          code: 'EEXIST',
        });
        expect(attempts).toBe(1);
        await expect(readFile(destination, 'utf8')).resolves.toBe(
          'Other publication',
        );
      } else {
        await expect(publishAcceptedDraft(directory)).rejects.toBe(failure);
        expect(attempts).toBe(2);
        await expect(publishAcceptedDraft(directory)).resolves.toBe(
          destination,
        );
        expect(attempts).toBe(3);
      }
    } finally {
      vi.mocked(open).mockReset();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
