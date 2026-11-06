import { randomUUID } from 'node:crypto';
import {
  Agent,
  manualTool,
  parseSessionState,
  selectMcpTools,
  tool,
  type NativeProvider,
  type Session,
  type ToolContext,
} from '@openai/agents';
import { MCPServerStreamableHttp } from '@openai/agents/classic';
import {
  text,
  toolCall,
  withScriptedResponses,
  type ScriptedResponse,
} from '@openai/agents/testing';
import { z } from 'zod';
import {
  AppError,
  presentationSchema,
  resultSchema,
  terminal,
  type Owner,
  type Phase,
  type Snapshot,
} from './protocol';
import { TaskStore, type TaskRecord } from './store';
import type { ReportPeer } from './mcp-peer';

const publish = manualTool({
  name: 'publish_json',
  description: 'Ask the user before publishing a JSON presentation.',
  parameters: z.strictObject({ json: z.string().max(32_000) }),
  result: z.strictObject({ approved: z.boolean() }),
});
class TaskCancelled extends Error {}

const syntheticBytes = JSON.stringify({
  slides: [{ text: 'Synthetic quarterly report: revenue grew.' }],
});
export const scriptedPresentation = `${JSON.stringify(JSON.parse(syntheticBytes), null, 2)}\n`;

interface Job {
  record: TaskRecord;
  timer: ReturnType<typeof setTimeout>;
  wake: ReturnType<typeof Promise.withResolvers<void>>;
  stop?: 'stopped' | 'expired';
  decision?: boolean;
  approval?: { token: string; summary: string };
}
export interface WorkerOptions {
  deadlineMs?: number;
  queueCapacity?: number;
  /** Test a rejected candidate through the same real manual request. */
  candidate?: string;
}

/** One finite queue and one Session/Turn owner. HTTP only deposits commands. */
export class TaskWorker {
  private readonly queue: Job[] = [];
  private active?: Job;
  private draining?: Promise<void>;
  private closed = false;
  private restoring?: Promise<z.infer<typeof resultSchema>>;
  private readonly listeners = new Set<(receipt: string) => void>();
  private fatal?: unknown;
  private retryCleanup?: () => Promise<void>;
  private readonly failures = new Map<string, unknown>();
  /** Private application diagnostics; never serialized into HTTP snapshots. */
  diagnostic(owner: Owner, receipt: string): unknown {
    this.store.get(owner, receipt);
    return this.failures.get(receipt);
  }
  constructor(
    readonly store: TaskStore,
    private readonly peer: ReportPeer,
    private readonly options: WorkerOptions = {},
  ) {}
  subscribe(listener: (receipt: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(receipt: string): void {
    for (const listener of this.listeners) listener(receipt);
  }
  snapshot(owner: Owner, receipt: string): Snapshot {
    const snapshot = this.store.get(owner, receipt).snapshot;
    if (
      this.active?.record.snapshot.receipt === receipt &&
      this.active.approval
    )
      snapshot.approval = { ...this.active.approval };
    return snapshot;
  }
  private update(
    job: Job,
    change: Partial<Snapshot>,
    checkpoint?: string,
  ): void {
    job.record.snapshot = this.store.update(
      job.record.owner,
      job.record.snapshot.receipt,
      change,
      checkpoint,
    );
    this.changed(job.record.snapshot.receipt);
  }
  admit(
    owner: Owner,
    requestKey: string,
    task: string,
  ): { snapshot: Snapshot; recovered: boolean } {
    if (this.closed || this.restoring || this.fatal)
      throw new AppError(503, 'Worker unavailable.');
    const recovered = this.store.recover(owner, requestKey, task);
    if (recovered)
      return {
        snapshot: this.snapshot(owner, recovered.snapshot.receipt),
        recovered: true,
      };
    if (this.active && this.queue.length >= (this.options.queueCapacity ?? 3))
      throw new AppError(429, 'Task queue is full.');
    const deadlineAt = Date.now() + (this.options.deadlineMs ?? 30_000);
    const record = this.store.admit(owner, requestKey, task, deadlineAt);
    const job: Job = {
      record,
      wake: Promise.withResolvers<void>(),
      timer: setTimeout(
        () => this.requestStop(job, 'expired'),
        Math.max(0, deadlineAt - Date.now()),
      ),
    };
    this.queue.push(job);
    this.pump();
    return {
      snapshot: this.snapshot(owner, record.snapshot.receipt),
      recovered: false,
    };
  }
  approve(
    owner: Owner,
    receipt: string,
    token: string,
    approve: boolean,
  ): Snapshot {
    this.store.get(owner, receipt);
    const job = this.active;
    if (
      !job ||
      job.record.owner !== owner ||
      job.record.snapshot.receipt !== receipt ||
      job.stop ||
      !job.approval ||
      job.approval.token !== token ||
      Date.now() >= job.record.snapshot.deadlineAt
    )
      throw new AppError(409, 'Approval is expired, spent or unavailable.');
    delete job.approval; // Consume authority before returning, so concurrent replay fails.
    job.decision = approve;
    this.update(job, { phase: 'running' });
    job.wake.resolve();
    return this.snapshot(owner, receipt);
  }
  stop(owner: Owner, receipt: string): Snapshot {
    const record = this.store.get(owner, receipt);
    if (terminal(record.snapshot.phase)) return this.snapshot(owner, receipt);
    const job = [this.active, ...this.queue].find(
      (entry) => entry?.record.snapshot.receipt === receipt,
    );
    if (job) this.requestStop(job, 'stopped');
    else if (!terminal(record.snapshot.phase))
      throw new AppError(409, 'Task has no current worker.');
    return this.snapshot(owner, receipt);
  }
  private requestStop(job: Job, reason: 'stopped' | 'expired'): void {
    if (job.stop) return;
    job.stop = reason;
    delete job.approval;
    const index = this.queue.indexOf(job);
    if (index >= 0) {
      this.queue.splice(index, 1);
      clearTimeout(job.timer);
      this.update(job, { phase: reason });
    } else {
      this.update(job, { phase: 'stopping' });
      job.wake.resolve();
    }
  }
  private pump(): void {
    if (this.active || this.closed || this.fatal) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    this.draining = this.run(job)
      .catch((error: unknown) => {
        this.fatal = error;
      })
      .finally(() => {
        clearTimeout(job.timer);
        if (!this.fatal) {
          this.active = undefined;
          this.pump();
        }
      });
  }
  private async run(job: Job): Promise<void> {
    let phase: Phase = 'failed';
    let failure: unknown;
    let settled: z.infer<typeof resultSchema> | undefined;
    let checkpoint: string | undefined;
    this.update(job, { phase: 'running' });
    // These responses traverse the native loop, including the selected MCP tool.
    const responses: ScriptedResponse[] = [
      [toolCall('report', {}, { callId: 'report', namespace: 'reports' })],
      [toolCall('audience_note', {}, { callId: 'audience' })],
      [
        toolCall(
          'publish_json',
          { json: this.options.candidate ?? syntheticBytes },
          { callId: 'publication' },
        ),
      ],
      [text(JSON.stringify({ summary: 'Synthetic task settled.' }))],
    ];
    let callbackError: unknown;
    let borrowedProvider: NativeProvider | undefined;
    try {
      await withScriptedResponses(responses, async ({ provider }) => {
        borrowedProvider = provider;
        try {
          const result = await this.session(job, provider);
          phase = result.phase;
          settled = result.result;
          checkpoint = result.checkpoint;
        } catch (error) {
          callbackError = error;
          throw error;
        }
      });
    } catch (error) {
      if (!(error instanceof TaskCancelled)) {
        failure = error;
        this.failures.set(job.record.snapshot.receipt, error);
      }
      // The helper preserves callback error identity when its cleanup succeeds.
      // A distinct outer failure, or our retained disposal, is an owner failure.
      if (this.retryCleanup || error !== callbackError) {
        this.fatal = error;
        if (!this.retryCleanup && borrowedProvider) {
          const provider = borrowedProvider;
          this.retryCleanup = () => provider.close();
        }
      }
    }
    delete job.approval;
    // Cancellation can outlast the deadline. Only this point releases the slot.
    this.update(
      job,
      {
        phase: failure ? 'failed' : (job.stop ?? phase),
        ...(settled ? { result: settled } : {}),
        ...(failure
          ? {
              error:
                failure instanceof Error
                  ? failure.message.slice(0, 1000)
                  : 'Worker failed.',
            }
          : {}),
      },
      checkpoint,
    );
  }
  private async session(
    job: Job,
    provider: NativeProvider,
  ): Promise<{
    phase: Phase;
    result: z.infer<typeof resultSchema>;
    checkpoint: string;
  }> {
    const credential = this.peer.issue(job.record.owner);
    const reports = new MCPServerStreamableHttp({
      name: 'reports',
      url: this.peer.url,
      requestInit: { headers: { Authorization: `Bearer ${credential.token}` } },
    });
    let ownedSession:
      Session<z.infer<typeof resultSchema>, { owner: Owner }> | undefined;
    const cleanup = async () => {
      await ownedSession?.close();
      await reports.close();
      credential.revoke();
    };
    await using _ownedCleanup = {
      [Symbol.asyncDispose]: async () => {
        try {
          await cleanup();
        } catch (error) {
          this.retryCleanup = async () => {
            await cleanup();
            await provider.close();
          };
          throw error;
        }
      },
    };
    {
      await reports.connect();
      const context = { owner: job.record.owner };
      const tools = await selectMcpTools(
        { name: 'reports', server: reports },
        { context, toolNames: ['report'] },
      );
      const agent = new Agent<{ owner: Owner }, z.infer<typeof resultSchema>>({
        instructions:
          'Read the audience note. Ask publish_json for approval before publishing. Return a short summary.',
        model: 'gpt-5.5',
        provider,
        programmaticToolCalling: false,
        tools: [
          ...tools,
          publish,
          tool({
            name: 'audience_note',
            parameters: z.strictObject({}),
            execute: (_args, ctx: ToolContext<{ owner: Owner }>) =>
              `Synthetic audience for ${ctx.context.owner}.`,
          }),
        ],
        outputType: { mode: 'prompted', schema: resultSchema },
      });
      const session = (ownedSession = await agent.session({ context }));
      {
        if (Date.now() >= job.record.snapshot.deadlineAt)
          this.requestStop(job, 'expired');
        if (job.stop)
          throw new TaskCancelled('Task stopped before submission.');
        const turn = await session.submit(job.record.task);
        const reader = session.events();
        const completion = turn.wait();
        // Observe rejection immediately while the worker waits for user commands.
        const finished = completion.then(
          (value) => ({ kind: 'done' as const, value }),
          (error: unknown) => ({ kind: 'error' as const, error }),
        );
        let next = reader
          .next()
          .then((value) => ({ kind: 'event' as const, value }));
        let request: NonNullable<ReturnType<typeof publish.match>> | undefined;
        let bytes: string | undefined;
        let denied = false;
        try {
          for (;;) {
            if (job.stop) {
              await turn.cancel();
              await completion.catch(() => {});
              throw new TaskCancelled('Task cancelled.');
            }
            if (job.decision !== undefined && request) {
              const approved = job.decision;
              delete job.decision;
              // Native acceptance of the original issued reply precedes the effect.
              await session.respond(request.reply({ approved }));
              request = undefined;
              if (approved) {
                if (job.stop || Date.now() >= job.record.snapshot.deadlineAt) {
                  this.requestStop(job, 'expired');
                  continue;
                }
                job.record.snapshot = this.store.publish(
                  job.record.owner,
                  job.record.snapshot.receipt,
                  bytes!,
                );
                this.changed(job.record.snapshot.receipt);
              } else denied = true;
              bytes = undefined;
            }
            const wake = job.wake.promise.then(() => ({
              kind: 'command' as const,
            }));
            const item = await Promise.race([next, finished, wake]);
            if (item.kind === 'command') {
              job.wake = Promise.withResolvers<void>();
              continue;
            }
            if (item.kind === 'error') throw item.error;
            if (item.kind === 'done') {
              if (!denied && !job.record.snapshot.artifact)
                throw new Error('Turn settled without a committed artifact.');
              return {
                phase: denied ? 'denied' : 'completed',
                result: resultSchema.parse(item.value.finalOutput),
                checkpoint: JSON.stringify(await session.saveState()),
              };
            }
            if (item.value.done)
              throw new Error('Session reader ended before settlement.');
            const matched = publish.match(item.value.value);
            if (matched) {
              if (request || job.record.snapshot.artifact || denied)
                throw new Error('Only one publication request is supported.');
              const presentation = presentationSchema.parse(
                JSON.parse(matched.arguments.json),
              );
              bytes = `${JSON.stringify(presentation, null, 2)}\n`;
              request = matched;
              job.approval = {
                token: randomUUID(),
                summary: `Publish ${presentation.slides.length} validated slide(s)?`,
              };
              this.update(job, { phase: 'approval' });
            } else if (item.value.value.type === 'action_requested')
              throw new Error('Unexpected manual request.');
            next = reader
              .next()
              .then((value) => ({ kind: 'event' as const, value }));
          }
        } finally {
          await reader.return?.();
          // session.close below joins cancellation and callback cleanup.
          void completion.catch(() => {});
        }
      }
    }
  }
  /** Restore only a settled checkpoint with fresh context/tools/MCP credentials. */
  restore(
    owner: Owner,
    receipt: string,
  ): Promise<z.infer<typeof resultSchema>> {
    if (
      this.active ||
      this.queue.length ||
      this.closed ||
      this.restoring ||
      this.fatal
    )
      throw new AppError(409, 'Worker must be idle for restore.');
    const record = this.store.get(owner, receipt);
    if (!record.checkpoint || !record.snapshot.result)
      throw new AppError(409, 'No settled checkpoint.');
    this.restoring = this.restoreSession(owner, record.checkpoint)
      .catch((error: unknown) => {
        this.failures.set(receipt, error);
        if (this.retryCleanup) this.fatal = error;
        throw error;
      })
      .finally(() => {
        this.restoring = undefined;
      });
    return this.restoring;
  }
  private async restoreSession(
    owner: Owner,
    checkpoint: string,
  ): Promise<z.infer<typeof resultSchema>> {
    let callbackError: unknown;
    let borrowedProvider: NativeProvider | undefined;
    try {
      return await withScriptedResponses(
        [
          [toolCall('audience_note', {}, { callId: 'fresh-audience' })],
          [
            toolCall(
              'report',
              {},
              { callId: 'fresh-report', namespace: 'reports' },
            ),
          ],
          [text(JSON.stringify({ summary: `Restored for ${owner}.` }))],
        ],
        async ({ provider }) => {
          borrowedProvider = provider;
          try {
            const credential = this.peer.issue(owner);
            const reports = new MCPServerStreamableHttp({
              name: 'reports',
              url: this.peer.url,
              requestInit: {
                headers: { Authorization: `Bearer ${credential.token}` },
              },
            });
            let ownedSession:
              | Session<z.infer<typeof resultSchema>, { owner: Owner }>
              | undefined;
            const cleanup = async () => {
              await ownedSession?.close();
              await reports.close();
              credential.revoke();
            };
            await using _ownedCleanup = {
              [Symbol.asyncDispose]: async () => {
                try {
                  await cleanup();
                } catch (error) {
                  this.retryCleanup = async () => {
                    await cleanup();
                    await provider.close();
                  };
                  throw error;
                }
              },
            };
            await reports.connect();
            const context = { owner };
            const tools = await selectMcpTools(
              { name: 'reports', server: reports },
              { context, toolNames: ['report'] },
            );
            const agent = new Agent<
              { owner: Owner },
              z.infer<typeof resultSchema>
            >({
              model: 'gpt-5.5',
              provider,
              instructions:
                'Read the audience note. Ask publish_json for approval before publishing. Return a short summary.',
              programmaticToolCalling: false,
              tools: [
                ...tools,
                publish,
                tool({
                  name: 'audience_note',
                  parameters: z.strictObject({}),
                  execute: (_args, ctx: ToolContext<{ owner: Owner }>) =>
                    `Synthetic audience for ${ctx.context.owner}.`,
                }),
              ],
              outputType: { mode: 'prompted', schema: resultSchema },
            });
            const session = (ownedSession = await agent.session({
              context,
              state: parseSessionState(checkpoint),
            }));
            const turn = await session.submit(
              'Summarize the settled conversation for the current user.',
            );
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const deadline = new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error('Restore deadline exceeded.')),
                  this.options.deadlineMs ?? 30_000,
                );
              });
              return resultSchema.parse(
                (await Promise.race([turn.wait(), deadline])).finalOutput,
              );
            } finally {
              clearTimeout(timer);
            }
          } catch (error) {
            callbackError = error;
            throw error;
          }
        },
      );
    } catch (error) {
      if (this.retryCleanup || error !== callbackError) {
        this.fatal = error;
        if (!this.retryCleanup && borrowedProvider) {
          const provider = borrowedProvider;
          this.retryCleanup = () => provider.close();
        }
      }
      throw error;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const job of [...this.queue]) this.requestStop(job, 'stopped');
    if (this.active && !this.fatal) this.requestStop(this.active, 'stopped');
    await this.draining;
    let restoreFailure: unknown;
    try {
      await this.restoring;
    } catch (error) {
      restoreFailure = error;
    }
    if (this.retryCleanup) {
      try {
        await this.retryCleanup();
        this.retryCleanup = undefined;
      } catch (error) {
        throw new AggregateError(
          [this.fatal ?? restoreFailure, error],
          'Owned cleanup retry failed',
        );
      }
    }
    if (this.fatal) throw this.fatal;
    if (restoreFailure) throw restoreFailure;
  }
}
