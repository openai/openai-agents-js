/** Render a thumbnail in a separate worker, then resume the original tool call. */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  Agent,
  NativeProvider,
  parseSessionState,
  type Session,
} from '@openai/agents';
import {
  DeferredTools,
  deferredTool,
  type AdvanceOutcome,
  type JobClaim,
  type JobContext,
  type JobProvider,
  type JobUpdate,
} from '@openai/agents/experimental/deferred';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { Journal } from './external-job-journal';
import { Busy, ThumbnailStore } from './external-job-store';

interface Thumbnail {
  color: 'red' | 'blue';
}

export const render = deferredTool({
  name: 'render_thumbnail',
  description: 'Render one thumbnail.',
  schemas: (builder) => ({
    parameters: builder.strictObject({ color: builder.enum(['red', 'blue']) }),
    result: builder.strictObject({
      byteCount: builder.number().int().positive().max(65_536),
    }),
  }),
});

/** Only this approved projection crosses the model boundary. */
export function publicSize(value: unknown): { byteCount: number } {
  if (
    !value ||
    typeof value !== 'object' ||
    !('byteCount' in value) ||
    typeof value.byteCount !== 'number' ||
    !Number.isSafeInteger(value.byteCount) ||
    value.byteCount <= 0 ||
    value.byteCount > 65_536
  )
    throw new TypeError('No verified thumbnail size.');
  return { byteCount: value.byteCount };
}

export class ThumbnailProvider implements JobProvider<Thumbnail> {
  constructor(readonly journal: Journal) {}

  async start(
    claim: JobClaim,
    input: Thumbnail,
    context: JobContext,
  ): Promise<JobUpdate> {
    return this.journal.authorized(
      claim,
      (db) => {
        db.prepare(
          `INSERT INTO thumbnails (tenant,order_id,color,receipt) VALUES (?,?,?,?)
          ON CONFLICT (tenant,order_id) DO NOTHING`,
        ).run(...this.journal.scope, input.color, randomUUID());
        const row = db
          .prepare(
            'SELECT color,receipt FROM thumbnails WHERE tenant=? AND order_id=?',
          )
          .get(...this.journal.scope)!;
        if (row.color !== input.color || typeof row.receipt !== 'string')
          throw new Error('This order already names a different thumbnail.');
        return { status: 'pending', receipt: row.receipt };
      },
      context,
    );
  }

  // Creation and reconciliation share one atomic immutable order/input binding.
  async reconcileCreation(
    claim: JobClaim,
    input: Thumbnail,
    context: JobContext,
  ): Promise<JobUpdate> {
    return this.start(claim, input, context);
  }

  async observe(claim: JobClaim, context: JobContext): Promise<JobUpdate> {
    return this.journal.authorized(
      claim,
      (db) => {
        const receipt = claim.update?.receipt;
        const row = db
          .prepare(
            `SELECT length(image) AS byteCount FROM thumbnails
            WHERE tenant=? AND order_id=? AND receipt=?`,
          )
          .get(...this.journal.scope, receipt ?? '');
        if (!row) return { status: 'unknown' };
        if (row.byteCount === null)
          return { status: 'pending', receipt: receipt! };
        return {
          status: 'completed',
          receipt,
          value: { byteCount: row.byteCount },
        };
      },
      context,
    );
  }
}

async function requestFrom(session: Session) {
  for await (const event of session.events()) {
    const request = render.match(event);
    if (request) return request;
    if (event.type === 'action_requested')
      throw new Error('The model requested an unexpected interaction.');
    if (event.type === 'turn_finished') {
      await session.wait();
      throw new Error('The model finished without requesting a thumbnail.');
    }
  }
  throw new Error('The Session closed before requesting a thumbnail.');
}

async function continueOrder(
  journal: Journal,
  checkpoint: string | null,
  model: NativeProvider,
): Promise<string> {
  const jobs = new DeferredTools({
    journal,
    tenant: journal.store.tenant,
    runId: journal.order,
  });
  jobs.register(render, {
    providerId: 'sqlite-thumbnail-v1',
    provider: new ThumbnailProvider(journal),
    project: publicSize,
    maxOutputBytes: 64,
    requireReconciliation: true,
  });
  const agent = new Agent({
    instructions: 'Request one thumbnail. Then report its verified byte count.',
    tools: [render],
    provider: model,
  });
  const session = await agent.session({
    ...(checkpoint === null ? {} : { state: parseSessionState(checkpoint) }),
  });
  try {
    if (checkpoint === null) await session.submit('Render a blue thumbnail.');
    const current = await requestFrom(session);
    const finish = async (
      opened: Session<unknown>,
      outcome: AdvanceOutcome,
    ) => {
      if (outcome.status !== 'continued') return outcome.status;
      // A public reply is durable before delivery; publish completion only after settlement.
      await outcome.turn.wait();
      journal.finish(JSON.stringify(await opened.saveState()));
      return 'completed';
    };
    if (checkpoint === null)
      return await jobs.start(
        session,
        current,
        {},
        ({ session: opened, outcome }) => finish(opened, outcome),
      );
    return await finish(session, await jobs.advance(session, current));
  } finally {
    await session.close();
  }
}

/** The application locks one authorized tenant/order across all host awaits. */
export async function runOrder(
  journal: Journal,
  options: { mock?: boolean; modelPort?: number },
): Promise<string> {
  return journal.owner(async () => {
    const { checkpoint, finished } = journal.load();
    if (finished) return 'completed';
    if (options.mock) {
      // Choose the deterministic model script under the same order ownership.
      const ready = journal.store.transaction((db) =>
        db
          .prepare(
            `SELECT 1 FROM orders LEFT JOIN thumbnails USING (tenant,order_id)
            WHERE tenant=? AND order_id=? AND (image IS NOT NULL OR result IS NOT NULL)`,
          )
          .get(...journal.scope),
      );
      const script =
        checkpoint === null
          ? [
              [
                toolCall(
                  render.name,
                  { color: 'blue' },
                  { callId: 'thumbnail-call' },
                ),
              ],
            ]
          : ready
            ? [[text('The thumbnail contains 3085 bytes.')]]
            : [];
      return withScriptedResponses(script, async (peer) => {
        const status = await continueOrder(journal, checkpoint, peer.provider);
        if (
          status === 'completed' &&
          peer.toolOutput('thumbnail-call') !== '{"byteCount":3085}'
        )
          throw new Error('The model did not receive the approved byte count.');
        return status;
      });
    }
    await using model = new NativeProvider({
      baseUrl: `http://127.0.0.1:${options.modelPort}/v1`,
      apiKey: 'local-only',
      supportsWebsockets: false,
    });
    return await continueOrder(journal, checkpoint, model);
  });
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      directory: { type: 'string' },
      mock: { type: 'boolean' },
      'model-port': { type: 'string' },
    },
  });
  const [command, order] = positionals;
  const modelPort = Number(values['model-port']);
  if (
    positionals.length !== 2 ||
    !['run', 'worker'].includes(command) ||
    !values.directory ||
    (command === 'run' &&
      (values.mock
        ? values['model-port'] !== undefined
        : !Number.isInteger(modelPort) || modelPort < 1 || modelPort > 65535))
  )
    throw new Error(
      'Usage: external-job.ts run ORDER --directory /private/state (--mock | --model-port PORT), or worker ORDER --directory /private/state.',
    );
  const store = new ThumbnailStore(values.directory, 'local-studio');
  const journal = new Journal(store, order);
  if (command === 'worker') {
    console.log(store.work(order) ? 'Rendered.' : 'No queued thumbnail.');
    return;
  }
  try {
    console.log(await runOrder(journal, { mock: values.mock, modelPort }));
  } catch (error) {
    if (error instanceof Busy) console.log(error.message);
    else throw error;
  }
}

// tsx runs these source examples as CommonJS in this checkout.
if (typeof require !== 'undefined' && require.main === module) {
  main().catch(() => {
    // Keep private state paths, provider receipts and native failures off stdout.
    console.error('The thumbnail order could not be advanced.');
    process.exitCode = 1;
  });
}
