import { createHash, randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { constants } from 'node:fs';
import {
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  Agent,
  Environment,
  LocalRecoveryRequired,
  NativeProvider,
  localStorage,
  selectMcpTools,
  type McpNamespace,
  type NativeProviderOptions,
  type ReconciledCall,
  type Session,
  type UncertainCall,
} from '@openai/agents';
import { z } from 'zod';

import type { WorkerSignals } from './signals.js';
import { waitForWorkerAttention } from './supervision.js';

const verifyDraftCommand = 'sha256sum draft.md';

const claim = z.strictObject({
  summary: z.string().min(1).max(512),
  question: z.string().min(1).max(256).nullable(),
});
const snapshotSchema = z.strictObject({
  threadId: z.string(),
  state: z.enum(['working', 'needs_attention', 'needs_review', 'accepted']),
  attention: z
    .enum([
      'deadline',
      'interaction',
      'interrupted',
      'connection_lost',
      'rate_limited',
      'quota_blocked',
    ])
    .optional(),
  steering: z
    .object({
      sessionId: z.string(),
      submissionId: z.string(),
      turnId: z.string(),
      inputId: z.string(),
    })
    .optional(),
  claim: claim.optional(),
  evidence: z.string().optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  timings: z
    .object({
      startupMs: z.number(),
      followUpSubmissionMs: z.number().nullable(),
      firstToolMs: z.number().nullable(),
      firstToolResultMs: z.number().nullable().optional(),
      completionMs: z.number(),
    })
    .optional(),
});
export type WorkerSnapshot = z.infer<typeof snapshotSchema>;

type WorkerOptions = {
  /** Use a private directory. Admit only one worker at a time and join it before reuse. */
  directory: string;
  provider: NativeProviderOptions & { apiKey: string };
  model: string;
  reports: McpNamespace<undefined>;
  task: string;
  /** A revision from the supervisor while the first turn is still active. */
  steer?: string;
  startupMs?: number;
  turnMs?: number;
  /** Optional trusted account observations supplied by the application. */
  signals?: WorkerSignals;
  /** Verify effects in independent application records. Unknown stays blocked. */
  reconcile?: (
    call: UncertainCall,
    signal: AbortSignal,
  ) => Promise<ReconciledCall | undefined>;
};

const isMissing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

function paths(directory: string) {
  directory = resolve(directory);
  return {
    workspace: join(directory, 'workspace'),
    profile: localStorage(join(directory, 'profile')),
    snapshot: join(directory, 'snapshot.json'),
    draft: join(directory, 'workspace', 'draft.md'),
  };
}

async function withCleanup<Result>(
  run: () => Promise<Result>,
  cleanup: () => Promise<void>,
  cleanupFailure: string,
): Promise<Result> {
  let result: Result;
  try {
    result = await run();
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], cleanupFailure, {
        cause: error,
      });
    }
    throw error;
  }
  await cleanup();
  return result;
}

const writeCleanupFailure = 'Cleaning up the worker write failed.';

async function syncParentDirectory(path: string) {
  const directory = await open(dirname(path), 'r');
  await withCleanup(
    () => directory.sync(),
    () => directory.close(),
    writeCleanupFailure,
  );
}

async function atomicWrite(
  path: string,
  data: string | Buffer,
  replace: boolean,
) {
  const temporary = path + '.' + randomUUID();
  await withCleanup(
    async () => {
      const file = await open(temporary, 'wx', 0o600);
      await withCleanup(
        async () => {
          await file.writeFile(data);
          await file.sync();
        },
        () => file.close(),
        writeCleanupFailure,
      );
      if (replace) await rename(temporary, path);
      else await link(temporary, path);
      await syncParentDirectory(path);
    },
    () => rm(temporary, { force: true }),
    writeCleanupFailure,
  );
}

/** A detached reader can load this snapshot without opening the SDK writer. */
export async function readWorkerSnapshot(directory: string) {
  try {
    return snapshotSchema.parse(
      JSON.parse(await readFile(paths(directory).snapshot, 'utf8')),
    );
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function readDraft(path: string) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  return withCleanup(
    async () => {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096)
        throw new Error(
          'Draft must be a private regular file of at most 4 KiB.',
        );
      const buffer = Buffer.alloc(4097);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > 4096) throw new Error('Draft grew past 4 KiB.');
      if (length !== stat.size) throw new Error('Draft changed while reading.');
      return buffer.subarray(0, length);
    },
    () => file.close(),
    'Closing the worker draft failed.',
  );
}

const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

function matchesDraftHash(output: string | null, sha256: string): boolean {
  // Native history combines stdout and stderr. Shell diagnostics can precede
  // the hash, so require it on the final line and reject other hash lines.
  const lines = output?.split('\n');
  return (
    lines !== undefined &&
    lines.pop() === '' &&
    lines.pop() === `${sha256}  draft.md` &&
    !lines.some((line) => /^[a-f0-9]{64} [ *]/i.test(line))
  );
}

export async function superviseArtifact(options: WorkerOptions) {
  const { task, reports } = options;
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const directory = await realpath(options.directory);
  const path = paths(directory);
  const saveStatusAndThrow = async (
    snapshot: WorkerSnapshot,
    error: unknown,
  ): Promise<never> => {
    try {
      await atomicWrite(path.snapshot, JSON.stringify(snapshot), true);
    } catch (persistence) {
      throw new AggregateError(
        [error, persistence],
        'Saving the worker status failed.',
        { cause: error },
      );
    }
    throw error;
  };
  const previous = await readWorkerSnapshot(directory);
  const startup = performance.now();
  const opening = AbortSignal.timeout(options.startupMs ?? 30_000);
  const recordStartupFailure = async (error: unknown): Promise<never> => {
    // Admission guarantees the previous worker has exited.
    if (previous?.state === 'working') {
      return saveStatusAndThrow(
        {
          ...previous,
          state: 'needs_attention',
          attention:
            opening.aborted && error === opening.reason
              ? 'deadline'
              : 'interrupted',
        },
        error,
      );
    }
    throw error;
  };
  const prepare = async () => {
    await mkdir(path.workspace, { recursive: true, mode: 0o700 });
    const workspace = await realpath(path.workspace);
    // The caller owns the MCP client and connects it with a bounded transport.
    // Approve only the explicitly selected report tool, which records a report.
    const tools = await selectMcpTools(reports, {
      context: undefined,
      toolNames: ['report'],
      approval: ({ toolName }) => toolName === 'report',
      signal: opening,
    });
    const environment = Environment.local({
      cwd: workspace,
      tools: ['exec_command'],
      writableRoots: [],
    });
    return {
      workspace,
      tools,
      environment,
      provider: new NativeProvider(options.provider),
    };
  };
  const { workspace, tools, environment, provider } =
    await prepare().catch(recordStartupFailure);
  const openSession = async () => {
    const agent = new Agent({
      provider,
      model: options.model,
      tools,
      outputType: claim,
      // Local checkpoints require the original instructions on reopen.
      instructions:
        'Use the selected report tool to prepare a synthetic release note. ' +
        'Use exec_command to save draft.md in the workspace. Start the file with "# Release note". ' +
        `Run ${verifyDraftCommand} after saving so the application can check the exact bytes. ` +
        'If you need information, return it in question. Return a brief summary. ' +
        'The application reviews and publishes the draft.',
    });
    const config = {
      storage: path.profile,
      ...(previous === undefined ? {} : { resume: previous.threadId }),
      environment,
      projectGuidance: false,
      signal: opening,
    };
    try {
      return await agent.session(config);
    } catch (error) {
      if (!(error instanceof LocalRecoveryRequired) || !options.reconcile)
        throw error;
      const receipts: ReconciledCall[] = [];
      for (const call of error.calls) {
        opening.throwIfAborted();
        const receipt = await options.reconcile(call, opening);
        if (!receipt) throw error;
        receipts.push(receipt);
      }
      return agent.session({ ...config, reconciledCalls: receipts });
    }
  };
  let closingSession: Promise<void> | undefined;
  const runSession = async (session: Session<z.infer<typeof claim>>) => {
    const startupMs = performance.now() - startup;
    const started: WorkerSnapshot = { threadId: session.id, state: 'working' };
    await atomicWrite(path.snapshot, JSON.stringify(started), true);

    const submitted = performance.now();
    const deadline = AbortSignal.timeout(options.turnMs ?? 30_000);
    const taskWithVerification =
      task +
      `\n\nAfter saving draft.md, run ${verifyDraftCommand} as a standalone exec_command without a terminal.`;
    const expired = Promise.withResolvers<never>();
    const listener = addAbortListener(deadline, () =>
      expired.reject(deadline.reason),
    );
    const submission = session.submit(taskWithVerification, {
      ifBusy: 'reject',
      writableRoots: [],
    });
    const turn = await Promise.race([submission, expired.promise])
      .finally(() => listener[Symbol.dispose]())
      .catch((error: unknown) => {
        const attention =
          deadline.aborted && error === deadline.reason
            ? 'deadline'
            : undefined;
        if (attention === 'deadline') {
          // With no admitted Turn handle, close the owned Session to fence work.
          closingSession = session.close().finally(async () => {
            await submission.catch(() => {});
          });
          // Join and report cleanup failures after saving the timeout status.
          void closingSession.catch(() => {});
        }
        return saveStatusAndThrow(
          { ...started, state: 'needs_attention', attention },
          error,
        );
      });
    const followUpSubmissionMs = previous
      ? performance.now() - submitted
      : null;
    let firstToolMs: number | null = null;
    let firstToolResultMs: number | null = null;
    let steer = options.steer;
    let steeringWrite: Promise<void> | undefined;
    const observerFailure = Promise.withResolvers<never>();
    const observations = (async () => {
      for await (const event of turn.events()) {
        if (event.type === 'turn_started' && steer !== undefined) {
          const text = steer;
          steer = undefined;
          started.steering = await turn.steerExact(text, event.turnId);
          if (started.state === 'working') {
            steeringWrite = atomicWrite(
              path.snapshot,
              JSON.stringify(started),
              true,
            );
            await steeringWrite;
          }
        }
        if (event.type === 'tool_started')
          firstToolMs ??= performance.now() - submitted;
        if (
          (event.type === 'tool_finished' && event.status !== 'cancelled') ||
          (event.type === 'execution_item_completed' &&
            (event.item.status === 'completed' ||
              event.item.status === 'failed'))
        )
          firstToolResultMs ??= performance.now() - submitted;
      }
    })();
    void observations.catch(observerFailure.reject);
    const summary = await (async () => {
      let attention: WorkerSnapshot['attention'];
      try {
        const outcome = await Promise.race([
          waitForWorkerAttention(turn, {
            signal: deadline,
            signals: options.signals,
          }),
          observerFailure.promise,
        ]);
        if (!('finalOutput' in outcome)) {
          if ('type' in outcome) {
            if (outcome.type === 'account_quota_blocked') {
              attention = 'quota_blocked';
              throw new Error(
                'Account quota prevents the worker from continuing.',
              );
            }
            attention = outcome.reason;
            throw outcome.error;
          }
          attention = 'interaction';
          throw new Error('Supervisor action is needed before continuing.');
        }
        await observations;
        return outcome.finalOutput;
      } catch (error) {
        started.state = 'needs_attention';
        steer = undefined;
        if (deadline.aborted && error === deadline.reason)
          attention = 'deadline';
        const failures = [error];
        try {
          await turn.cancel();
          await observations.catch(() => {});
        } catch (cleanup) {
          failures.push(cleanup);
        }
        // A failed cancellation can leave the observer open. Join only any
        // steering write it already started before saving the attention state.
        await steeringWrite?.catch(() => {});
        try {
          await atomicWrite(
            path.snapshot,
            JSON.stringify({ ...started, attention }),
            true,
          );
        } catch (persistence) {
          throw new AggregateError(
            [...failures, persistence],
            'Saving the worker status failed.',
            { cause: error },
          );
        }
        if (failures.length > 1)
          throw new AggregateError(failures, 'Turn cancellation failed.', {
            cause: error,
          });
        throw error;
      }
    })();
    const timings = {
      startupMs,
      followUpSubmissionMs,
      firstToolMs,
      firstToolResultMs,
      completionMs: performance.now() - submitted,
    };
    const snapshot: WorkerSnapshot = {
      ...started,
      state: 'needs_review',
      claim: summary,
      timings,
    };
    if (summary.question === null) {
      try {
        const draft = await readDraft(path.draft).catch((error: unknown) => {
          if (isMissing(error)) return undefined;
          throw error;
        });
        const sha256 = draft && digest(draft);
        let evidence: string | undefined;
        // Only a command in this completed operation can support these bytes.
        for await (const item of session.items()) {
          if (
            sha256 &&
            item.turnId === turn.turnId &&
            item.type === 'command_execution' &&
            item.status === 'completed' &&
            item.exitCode === 0 &&
            (item.cwd?.startsWith('file:')
              ? fileURLToPath(item.cwd)
              : item.cwd) === workspace &&
            item.argv?.length === 3 &&
            ['bash', 'sh', 'zsh'].includes(basename(item.argv[0])) &&
            item.argv[1] === '-c' &&
            item.argv[2] === verifyDraftCommand &&
            matchesDraftHash(item.output, sha256)
          )
            evidence = item.id;
        }
        if (evidence !== undefined) snapshot.evidence = evidence;
        if (
          evidence &&
          sha256 &&
          draft?.toString().startsWith('# Release note\n')
        ) {
          snapshot.state = 'accepted';
          snapshot.sha256 = sha256;
        }
      } catch (error) {
        await saveStatusAndThrow(snapshot, error);
      }
    }
    if (snapshot.state !== 'accepted')
      await atomicWrite(path.snapshot, JSON.stringify(snapshot), true);
    return snapshot;
  };

  let session: Session<z.infer<typeof claim>> | undefined;
  let completed: WorkerSnapshot | undefined;
  const snapshot = await withCleanup(
    async () => {
      session = await openSession().catch(recordStartupFailure);
      completed = await runSession(session);
      return completed;
    },
    () =>
      withCleanup(
        async () => {
          await (closingSession ?? session?.close());
        },
        () => provider.close(),
        'Closing the worker provider failed.',
      ),
    'Closing the worker failed.',
  ).catch((error: unknown) => {
    if (completed?.state === 'accepted') {
      const attention: WorkerSnapshot = {
        ...completed,
        state: 'needs_attention',
        attention: 'interrupted',
      };
      delete attention.sha256;
      delete attention.evidence;
      return saveStatusAndThrow(attention, error);
    }
    throw error;
  });
  // Publication eligibility requires both owned resources to finish closing.
  if (snapshot.state === 'accepted')
    await atomicWrite(path.snapshot, JSON.stringify(snapshot), true);
  return snapshot;
}

/** The supervisor calls this separately after the worker has joined. */
export async function publishAcceptedDraft(directory: string) {
  try {
    directory = await realpath(directory);
  } catch (error) {
    if (!isMissing(error)) throw error;
    throw new Error('Publication requires an accepted draft.');
  }
  const snapshot = await readWorkerSnapshot(directory);
  if (snapshot?.state !== 'accepted' || !snapshot.sha256)
    throw new Error('Publication requires an accepted draft.');
  const draft = await readDraft(paths(directory).draft);
  if (digest(draft) !== snapshot.sha256)
    throw new Error('Draft changed after acceptance. Review it again.');
  const destination = join(
    resolve(directory),
    'published-' + snapshot.sha256 + '.md',
  );
  try {
    await atomicWrite(destination, draft, false);
  } catch (error) {
    if (
      !(error instanceof Error && 'code' in error && error.code === 'EEXIST') ||
      !(await readFile(destination)).equals(draft)
    )
      throw error;
    await syncParentDirectory(destination);
  }
  return destination;
}
