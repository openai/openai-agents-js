import { randomUUID } from 'node:crypto';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeProvider,
  NativeRole,
  tool,
  type Completed,
  type ChildTurn,
  type ChildCompleted,
  type EnvironmentOptions,
  type NativeProviderOptions,
  type ObservedEvent,
  type Subagent,
  type ToolCallInfo,
} from '@openai/agents';
import { z } from 'zod';

const sourceSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    title: z.string().trim().min(1).max(120),
    text: z.string().trim().min(1).max(8_000),
  })
  .strict();
export type ResearchSource = z.infer<typeof sourceSchema>;

export const DEFAULT_SOURCES: readonly ResearchSource[] = Object.freeze([
  Object.freeze({
    id: 'roofs',
    title: 'Roof study',
    text: 'The roof study found that cobalt roofs reduce summer heat.',
  }),
  Object.freeze({
    id: 'courtyards',
    title: 'Courtyard study',
    text: 'The courtyard study found that shaded courtyards retain cool air.',
  }),
]);

export type SourceReceipt = Readonly<{
  sourceId: string;
  childId: string;
  turnId: string;
  submissionId: string;
  callId: string;
  call: ToolCallInfo;
  text: string;
}>;

export type ResearchProgress = Readonly<{
  event: ObservedEvent;
  children: readonly Subagent[];
}>;

export interface ParallelResearchOptions {
  sources: readonly ResearchSource[];
  model: string;
  providerOptions: NativeProviderOptions;
  executorOptions: Pick<EnvironmentOptions, 'url' | 'cwd' | 'headers'>;
  /** Synchronous application observer. Child handles are captured observations. */
  onProgress?: (progress: ResearchProgress) => void;
}

export interface ParallelResearchResult {
  parent: Completed<string>;
  children: Array<{
    sourceId: string;
    child: Subagent;
    turn: ChildTurn;
    completed: ChildCompleted;
  }>;
  sources: readonly SourceReceipt[];
  events: readonly ObservedEvent[];
}

/** Two native researchers report to their native parent; the application observes. */
export async function researchInParallel(
  options: ParallelResearchOptions,
): Promise<ParallelResearchResult> {
  const sources = z.array(sourceSchema).length(2).parse(options.sources);
  if (new Set(sources.map((source) => source.id)).size !== 2)
    throw new TypeError('Choose two distinct sources');
  const model = z.string().trim().min(1).parse(options.model);
  // Copy caller-owned settings and capture ambient credentials before any await.
  const apiKey = options.providerOptions.apiKey ?? process.env.OPENAI_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0)
    throw new TypeError('Configure provider credentials');
  const providerOptions = { ...options.providerOptions, apiKey };
  const executorOptions = {
    ...options.executorOptions,
    headers: { ...options.executorOptions.headers },
  };
  const onProgress = options.onProgress;
  if (onProgress !== undefined && typeof onProgress !== 'function')
    throw new TypeError('onProgress must be callable');
  const tasks = sources.map((source) => {
    const key = randomUUID();
    return {
      source,
      key,
      name: `research_${source.id}`,
      message: `Read source ${source.id} with read_source using assignmentKey ${key}. Return one finding that cites ${source.id}.`,
    };
  });
  const admitted = new Set<string>();
  const children = new Map<string, Subagent>();
  const receipts: SourceReceipt[] = [];
  const events: ObservedEvent[] = [];
  const failures: unknown[] = [];
  const waits: Promise<unknown>[] = [];
  const observerFailed = Promise.withResolvers<never>();
  void observerFailed.promise.catch(() => {});
  const fail = (error: unknown) => {
    if (!failures.includes(error)) failures.push(error);
  };
  let session: Awaited<ReturnType<Agent['session']>> | undefined;
  let iterator: AsyncIterableIterator<ObservedEvent> | undefined;
  let observer: Promise<void> | undefined;
  let result: ParallelResearchResult | undefined;
  const provider = new NativeProvider(providerOptions);
  const actorTasks = new Map<string, (typeof tasks)[number]>();
  const taskActors = new Map<string, string>();
  const taskFor = (child: Subagent) => actorTasks.get(child.id);
  const refresh = async () => {
    const captured: Subagent[] = [];
    for await (const child of session!.subagents()) {
      if (child.parentAgentId !== session!.id)
        throw new Error('Unexpected research child');
      captured.push(child);
      if (child.turn && !children.has(child.id)) children.set(child.id, child);
    }
    return captured;
  };
  const wait = async <T>(pending: Promise<T>): Promise<T> => {
    waits.push(pending);
    return Promise.race([pending, observerFailed.promise]);
  };
  try {
    const readSource = tool({
      name: 'read_source',
      description: 'Read the trusted excerpt assigned to this researcher.',
      parameters: z.object({ sourceId: z.string(), assignmentKey: z.string() }),
      async execute({ sourceId, assignmentKey }, context) {
        const captured = await refresh();
        const child = captured.find((item) => item.id === context.threadId);
        const task = tasks.find(
          (item) => item.source.id === sourceId && item.key === assignmentKey,
        );
        if (
          !child?.turn ||
          !task ||
          !admitted.has(task.name) ||
          (actorTasks.has(child.id) && actorTasks.get(child.id) !== task) ||
          (taskActors.has(task.name) &&
            taskActors.get(task.name) !== child.id) ||
          context.call?.childId !== child.id ||
          context.call.sessionId !== session!.id ||
          child.turn.turnId !== context.turnId ||
          child.turn.submissionId !== context.submission.submissionId
        ) {
          throw new Error('Source is not assigned to this native child');
        }
        actorTasks.set(child.id, task);
        taskActors.set(task.name, child.id);
        receipts.push(
          Object.freeze({
            sourceId,
            childId: child.id,
            turnId: context.turnId,
            submissionId: context.submission.submissionId,
            callId: context.callId,
            call: context.call,
            text: task.source.text,
          }),
        );
        return task.source.text;
      },
    });
    const nativeAgents = new NativeAgents({
      maxChildren: 2,
      maxDepth: 1,
      additionalRoles: [
        new NativeRole({
          name: 'researcher',
          description: 'Research one assigned source.',
          instructions:
            'Use read_source for your assigned source only. Return one concise finding citing its source ID. Do not delegate or use executor tools.',
        }),
      ],
      approval(_context, call) {
        if (call.threadId !== session?.id) return false;
        if (call.name === 'wait_agent') return true;
        if (call.name !== 'spawn_agent') return false;
        let input: unknown = call.input;
        try {
          if (typeof input === 'string') input = JSON.parse(input);
        } catch {
          return false;
        }
        const parsed = z
          .object({
            task_name: z.string(),
            message: z.string(),
            agent_type: z.literal('researcher'),
            fork_turns: z.literal('none'),
          })
          .strict()
          .safeParse(input);
        if (!parsed.success) return false;
        const task = tasks.find(
          (item) =>
            item.name === parsed.data.task_name &&
            item.message === parsed.data.message,
        );
        if (!task || admitted.has(task.name)) return false;
        admitted.add(task.name);
        return true;
      },
    });
    const assignments = tasks.map((task) => ({
      task_name: task.name,
      message: task.message,
      agent_type: 'researcher',
      fork_turns: 'none',
    }));
    session = await new Agent({
      model,
      provider,
      tools: [nativeAgents, readSource],
      instructions: `Spawn these two research tasks exactly, without waiting between spawns: ${JSON.stringify(assignments)}. Use collaboration.wait_agent until both findings arrive. Then combine both source-specific findings in your own final answer. Do not read sources yourself or use executor tools.`,
    }).session({
      environment: new Environment({
        ...executorOptions,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
        approval: () => false,
      }),
    });
    iterator = session.events();
    observer = (async () => {
      for await (const event of iterator!) {
        if (event.type === 'gap')
          throw new Error('Research observations were lost');
        events.push(event);
        const captured =
          event.type === 'subagent_lifecycle'
            ? await refresh()
            : [...children.values()];
        onProgress?.(
          Object.freeze({ event, children: Object.freeze(captured) }),
        );
      }
    })().catch((error) => {
      fail(error);
      observerFailed.reject(error);
    });
    const root = await session.submit(
      'Compare the two selected studies and give one combined finding.',
    );
    const parent = await wait(root.wait());
    await refresh();
    if (children.size !== 2 || admitted.size !== 2)
      throw new Error('The parent did not create both researchers');
    const childTasks = [...children.values()].map(async (child) => {
      const turn = child.turn!;
      const completed = await turn.wait();
      if (completed.turn !== turn || turn.childId !== child.id)
        throw new Error('Research result identity changed');
      const task = taskFor(child);
      if (
        !task ||
        !receipts.some(
          (receipt) =>
            receipt.childId === child.id && receipt.sourceId === task.source.id,
        )
      )
        throw new Error('Researcher did not read its assigned source');
      return { sourceId: task.source.id, child, turn, completed };
    });
    waits.push(...childTasks);
    const findings = await wait(Promise.all(childTasks));
    result = { parent, children: findings, sources: receipts, events };
  } catch (error) {
    fail(error);
  } finally {
    try {
      await iterator?.return?.();
    } catch (error) {
      fail(error);
    }
    await observer;
    try {
      await session?.close();
    } catch (error) {
      fail(error);
    }
    for (const settled of await Promise.allSettled(waits)) {
      if (settled.status === 'rejected') fail(settled.reason);
    }
    try {
      await provider.close();
    } catch (error) {
      fail(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, 'Research and cleanup failed');
  return result!;
}

export async function main(): Promise<void> {
  const model = process.env.OPENAI_MODEL;
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL;
  const url = process.env.RESEARCH_EXECUTOR_URL;
  const cwd = process.env.RESEARCH_EXECUTOR_CWD;
  const token = process.env.RESEARCH_EXECUTOR_TOKEN;
  if (!model?.trim() || !apiKey?.trim() || !url || !cwd)
    throw new Error(
      'Configure model, provider credentials and a trusted executor',
    );
  const result = await researchInParallel({
    sources: DEFAULT_SOURCES,
    model,
    providerOptions: { apiKey, baseUrl, supportsWebsockets: false },
    executorOptions: {
      url,
      cwd,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    },
    onProgress({ event, children }) {
      if (event.type === 'subagent_lifecycle')
        console.log(
          JSON.stringify({
            event,
            children: children.map((child) => ({
              id: child.id,
              name: child.name,
              status: child.status,
              turnId: child.turn?.turnId,
            })),
          }),
        );
    },
  });
  console.log(
    JSON.stringify({
      finalOutput: result.parent.finalOutput,
      parentTurnId: result.parent.turn.turnId,
      children: result.children.map(({ sourceId, child, turn, completed }) => ({
        sourceId,
        childId: child.id,
        turnId: turn.turnId,
        submissionId: turn.submissionId,
        finalOutput: completed.finalOutput,
      })),
      sources: result.sources,
    }),
  );
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch(() => {
    console.error(
      'Parallel research failed. Check trusted provider and executor configuration.',
    );
    process.exitCode = 1;
  });
}
