import { createHash, randomUUID } from 'node:crypto';
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
import { dirname, join, resolve } from 'node:path';
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
  type UncertainCall,
} from '@openai/agents';
import { z } from 'zod';

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
      completionMs: z.number(),
    })
    .optional(),
});
export type WorkerSnapshot = z.infer<typeof snapshotSchema>;

type WorkerOptions = {
  /** Use a different private directory for each worker. */
  directory: string;
  provider: NativeProviderOptions & { apiKey: string };
  model: string;
  reports: McpNamespace<undefined>;
  task: string;
  /** A revision from the supervisor while the first turn is still active. */
  steer?: string;
  startupMs?: number;
  turnMs?: number;
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

async function atomicWrite(
  path: string,
  data: string | Buffer,
  replace: boolean,
) {
  const temporary = path + '.' + randomUUID();
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    if (replace) await rename(temporary, path);
    else await link(temporary, path);
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
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
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096)
      throw new Error('Draft must be a private regular file of at most 4 KiB.');
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await file.read(buffer);
    if (bytesRead > 4096) throw new Error('Draft grew past 4 KiB.');
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

export async function superviseArtifact(options: WorkerOptions) {
  const { directory, task, reports } = options;
  const path = paths(directory);
  await mkdir(path.workspace, { recursive: true, mode: 0o700 });
  const workspace = await realpath(path.workspace);
  const previous = await readWorkerSnapshot(directory);
  const startup = performance.now();
  const opening = AbortSignal.timeout(options.startupMs ?? 30_000);
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
  await using provider = new NativeProvider(options.provider);
  const agent = new Agent({
    provider,
    model: options.model,
    tools,
    outputType: claim,
    instructions:
      'Use the selected report tool to prepare a synthetic release note. ' +
      'Use exec_command to save draft.md in the workspace. Start the file with "# Release note". ' +
      'Run sha256sum draft.md after saving so the application can check the exact bytes. ' +
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
  const openSession = async () => {
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
      return await agent.session({ ...config, reconciledCalls: receipts });
    }
  };
  await using session = await openSession();
  const startupMs = performance.now() - startup;
  const started: WorkerSnapshot = { threadId: session.id, state: 'working' };
  await atomicWrite(path.snapshot, JSON.stringify(started), true);

  const submitted = performance.now();
  const deadline = AbortSignal.timeout(options.turnMs ?? 30_000);
  const turn = await session.submit(task, {
    ifBusy: 'reject',
    writableRoots: [],
  });
  const followUpSubmissionMs = previous ? performance.now() - submitted : null;
  let firstToolMs: number | null = null;
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
    }
  })();
  void observations.catch(observerFailure.reject);
  const summary = await (async () => {
    let attention: WorkerSnapshot['attention'];
    try {
      const outcome = await Promise.race([
        turn.waitForAttention({ signal: deadline }),
        observerFailure.promise,
      ]);
      if (!('finalOutput' in outcome)) {
        attention = 'type' in outcome ? outcome.reason : 'interaction';
        throw new Error('Supervisor action is needed before continuing.');
      }
      await observations;
      return outcome.finalOutput;
    } catch (error) {
      started.state = 'needs_attention';
      steer = undefined;
      if (deadline.aborted && error === deadline.reason) attention = 'deadline';
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
    completionMs: performance.now() - submitted,
  };
  const snapshot: WorkerSnapshot = {
    ...started,
    state: 'needs_review',
    claim: summary,
    timings,
  };
  if (summary.question === null) {
    const draft = await readDraft(path.draft).catch(async (error: unknown) => {
      if (isMissing(error)) return undefined;
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
    });
    const sha256 = draft && digest(draft);
    // Only a command in this completed operation can support these bytes.
    for await (const item of session.items()) {
      if (
        sha256 &&
        item.turnId === turn.turnId &&
        item.type === 'command_execution' &&
        item.status === 'completed' &&
        item.exitCode === 0 &&
        (item.cwd?.startsWith('file:') ? fileURLToPath(item.cwd) : item.cwd) ===
          workspace &&
        item.command.includes('sha256sum draft.md') &&
        item.output?.includes(sha256 + '  draft.md')
      )
        snapshot.evidence = item.id;
    }
    if (
      snapshot.evidence &&
      sha256 &&
      draft?.toString().startsWith('# Release note\n')
    ) {
      snapshot.state = 'accepted';
      snapshot.sha256 = sha256;
    }
  }
  await atomicWrite(path.snapshot, JSON.stringify(snapshot), true);
  return snapshot;
}

/** The supervisor calls this separately after the worker has joined. */
export async function publishAcceptedDraft(directory: string) {
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
  }
  return destination;
}
