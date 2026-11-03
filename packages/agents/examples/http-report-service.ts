import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { join } from 'node:path';
import {
  Agent,
  NativeProvider,
  OutputValidationError,
  manualTool,
  type Session,
  type Turn,
} from '@openai/agents';
import { z } from 'zod';

const reportSchema = z.strictObject({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(12_000),
});
const decisionSchema = z.strictObject({
  audience: z.enum(['general', 'technical']),
});
const chooseAudience = manualTool({
  name: 'choose_audience',
  description: 'Ask the user which audience the report should address.',
  parameters: z.strictObject({ prompt: z.string().min(1).max(240) }),
  result: decisionSchema,
});
type Report = z.infer<typeof reportSchema>;
type Status =
  'opening' | 'running' | 'stopping' | 'completed' | 'failed' | 'stopped';
type Grant = {
  prompt: string;
  request: NonNullable<ReturnType<typeof chooseAudience.match>>;
  delivered: ReturnType<typeof Promise.withResolvers<void>>;
};
type Job = {
  id: string;
  revision: number;
  owner: string;
  status: Status;
  changes: EventEmitter;
  grants: Map<string, Grant>;
  deliveries: Set<Promise<void>>;
  readers: Set<() => void>;
  worker: Promise<void>;
  session?: Session;
  turn?: Turn<Report>;
  cancellation?: Promise<void>;
  settled?: boolean;
  requestCount: number;
  result?: Report;
  artifact?: string;
  error?: string;
  // Retain failures internally; HTTP responses never serialize provider errors.
  failures: unknown[];
};
const stopping = (job: Job) => job.status === 'stopping';
const terminal = (job: Job) =>
  ['completed', 'failed', 'stopped'].includes(job.status);
const snapshot = (job: Job) => ({
  id: job.id,
  // HTTP replies and event streams can arrive out of order at the browser.
  revision: ++job.revision,
  status: job.status,
  pending: Array.from(job.grants, ([id, grant]) => ({
    id,
    prompt: grant.prompt,
  })),
  ...(job.result ? { result: job.result } : {}),
  ...(job.error ? { error: job.error } : {}),
  artifactAvailable: job.artifact !== undefined,
});
const notify = (job: Job) => job.changes.emit('change');
function revoke(job: Job) {
  for (const grant of job.grants.values()) grant.delivered.resolve();
  job.grants.clear();
}
function cancel(job: Job): Promise<void> {
  return (job.cancellation ??= job
    .turn!.cancel()
    .catch(async (error: unknown) => {
      job.failures.push(error);
      job.error = 'cleanup_failed';
      // A rejected native stop may leave work alive. This job owns the Session,
      // so close it to unblock the worker and join its remaining native work.
      try {
        await job.session!.close();
      } catch (cleanup) {
        job.failures.push(cleanup);
      }
      throw error;
    }));
}
async function stop(job: Job): Promise<void> {
  if (!terminal(job) && !job.settled) {
    job.status = 'stopping';
    revoke(job);
    notify(job);
    // The worker also checks this intent after opening and submit admission.
    if (job.turn) await cancel(job).catch(() => {});
  }
  await job.worker;
}
async function runJob(job: Job, provider: NativeProvider, prompt: string) {
  let result: Report | undefined;
  let cleanupFailed = false;
  try {
    job.session = await new Agent({
      instructions:
        'Write a short report. First call choose_audience to ask which audience to address. ' +
        'Use its answer to write the report as the requested JSON output.',
      tools: [chooseAudience],
      provider,
    }).session();
    notify(job);
    if (stopping(job)) return;
    job.turn = await job.session.submitWithOutput(prompt, reportSchema);
    const completion = job.turn.wait().then(
      (completed) => {
        job.settled = true;
        return completed;
      },
      (error: unknown) => {
        job.settled = true;
        throw error;
      },
    );
    // Observe rejection immediately, including while a manual batch is displayed.
    completion.catch(() => {});
    if (stopping(job)) await cancel(job);
    else {
      job.status = 'running';
      notify(job);
    }
    while (job.status === 'running') {
      const waiting = await job.turn.wait({ until: 'request' });
      if (!('requests' in waiting)) break;
      // Stop may have revoked a batch while the request wait was resolving.
      if (job.status !== 'running') break;
      job.requestCount += waiting.requests.length;
      if (job.requestCount > 4) throw new Error('Manual request limit');
      for (const action of waiting.requests) {
        const request = chooseAudience.match(action);
        if (!request) throw new Error('Unexpected manual request');
        job.grants.set(randomUUID(), {
          prompt: request.arguments.prompt,
          request,
          delivered: Promise.withResolvers<void>(),
        });
      }
      notify(job);
      await Promise.race([
        Promise.all(
          Array.from(job.grants.values(), (grant) => grant.delivered.promise),
        ),
        completion,
      ]);
      revoke(job);
    }
    result = (await completion).finalOutput;
  } catch (error) {
    job.failures.push(error);
    job.error ??=
      error instanceof OutputValidationError ? 'output_invalid' : 'run_failed';
  } finally {
    revoke(job);
    // Replies claim before awaiting; join every entered delivery before Session close.
    const deliveries = await Promise.allSettled(job.deliveries);
    for (const delivery of deliveries)
      if (delivery.status === 'rejected') job.failures.push(delivery.reason);
    try {
      await job.session?.close();
    } catch (error) {
      job.failures.push(error);
      cleanupFailed = true;
      job.error ??= 'cleanup_failed';
    }
    if (job.status === 'stopping')
      job.status =
        cleanupFailed || job.error === 'cleanup_failed' ? 'failed' : 'stopped';
    else if (job.failures.length) {
      job.status = 'failed';
      job.error ??= 'reply_failed';
    } else {
      job.status = 'completed';
      job.result = result!;
      job.artifact = `${JSON.stringify(result, null, 2)}\n`;
    }
    notify(job);
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly category: string,
  ) {
    super(category);
  }
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new HttpError(413, 'body_too_large');
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_body');
  }
}

/** A reader owns only its observation iterator and HTTP connection. */
async function stream(job: Job, response: ServerResponse, after: number) {
  if (job.readers.size >= 2) throw new HttpError(429, 'reader_limit');
  let changed = Promise.withResolvers<void>();
  let closed = false;
  let eventsEnded = false;
  let iterator: ReturnType<Session['events']> | undefined;
  let next: ReturnType<NonNullable<typeof iterator>['next']> | undefined;
  const wake = () => changed.resolve();
  const detach = () => {
    closed = true;
    response.destroy();
    wake();
  };
  job.readers.add(detach);
  job.changes.on('change', wake);
  response.on('close', detach);
  const send = (event: string, data: unknown, sequence?: number) => {
    const frame = `${sequence === undefined ? '' : `id: ${sequence}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    // Do not accumulate a second event queue behind a slow browser.
    if (Buffer.byteLength(frame) > 65_536 || !response.write(frame)) detach();
  };
  try {
    // Validate the SDK cursor before sending HTTP headers when a Session is open.
    if (!terminal(job) && job.session) iterator = job.session.events({ after });
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
    });
    send('snapshot', snapshot(job));
    while (!closed && !terminal(job)) {
      const signal = changed.promise;
      if (!iterator && job.session) iterator = job.session.events({ after });
      if (iterator && !eventsEnded) next ??= iterator.next();
      const event = await Promise.race([
        signal.then(() => null),
        ...(next ? [next] : []),
      ]);
      if (closed) break;
      if (event === null) {
        changed = Promise.withResolvers<void>();
        send('snapshot', snapshot(job));
      } else {
        next = undefined;
        if (event.done) {
          eventsEnded = true;
          continue;
        }
        const value = event.value;
        if (value.type === 'gap') {
          send('reset', {});
          send('snapshot', snapshot(job));
        } else if (
          value.type === 'output_text_delta' &&
          value.submissionId === job.turn?.submissionId
        ) {
          send('text', { text: value.delta }, value.sequence);
        }
      }
    }
    if (!closed && terminal(job)) send('snapshot', snapshot(job));
  } finally {
    job.readers.delete(detach);
    job.changes.off('change', wake);
    response.off('close', detach);
    await iterator?.return?.();
    // Observe a pending next() even when terminal application state won the race.
    await next;
    response.end();
  }
}

/** Borrow the provider; close this service before closing that provider. */
export async function startReportService({
  provider,
  authenticate,
  port = 0,
}: {
  provider: NativeProvider;
  authenticate(request: IncomingMessage): string | undefined;
  port?: number;
}): Promise<{ url: string; close(): Promise<void> }> {
  const jobs = new Map<string, Job>();
  let closing = false;
  const html = await readFile(join(__dirname, 'http-report-service.html'));
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/') {
        response
          .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          .end(html);
        return;
      }
      const owner = authenticate(request);
      if (!owner) throw new HttpError(401, 'unauthorized');
      if (closing) throw new HttpError(503, 'closing');
      const route =
        /^\/jobs\/([0-9a-f-]{36})(?:\/(events|stop|artifact)|\/replies\/([0-9a-f-]{36}))?$/.exec(
          url.pathname,
        );
      if (!route || !z.uuid().safeParse(route[1]).success)
        throw new HttpError(404, 'not_found');
      const [, id, action, replyId] = route;
      if (request.method === 'PUT' && !action && !replyId) {
        const parsed = z
          .strictObject({ prompt: z.string().trim().min(1).max(4_000) })
          .safeParse(await body(request));
        if (!parsed.success) throw new HttpError(400, 'invalid_body');
        // Recheck after reading the body: parallel creates cannot share an ID.
        if (closing) throw new HttpError(503, 'closing');
        if (jobs.has(id)) throw new HttpError(409, 'duplicate_job');
        if (jobs.size >= 4) throw new HttpError(429, 'job_limit');
        const job: Job = {
          id,
          revision: 0,
          owner,
          status: 'opening',
          changes: new EventEmitter(),
          grants: new Map(),
          deliveries: new Set(),
          readers: new Set(),
          failures: [],
          requestCount: 0,
          worker: Promise.resolve(),
        };
        jobs.set(id, job);
        job.worker = runJob(job, provider, parsed.data.prompt);
        json(response, 202, snapshot(job));
        return;
      }
      const job = jobs.get(id);
      if (!job || job.owner !== owner) throw new HttpError(404, 'not_found');
      if (request.method === 'GET' && !action && !replyId)
        json(response, 200, snapshot(job));
      else if (request.method === 'GET' && action === 'events') {
        const cursor = url.searchParams.get('after') ?? '0';
        if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
          throw new HttpError(400, 'invalid_cursor');
        await stream(job, response, Number(cursor));
      } else if (request.method === 'POST' && action === 'stop') {
        await stop(job);
        json(response, 200, snapshot(job));
      } else if (request.method === 'POST' && replyId) {
        const decision = decisionSchema.safeParse(await body(request));
        if (!decision.success) throw new HttpError(400, 'invalid_body');
        const grant = job.grants.get(replyId);
        if (job.status !== 'running' || !grant)
          throw new HttpError(409, 'stale_reply');
        job.grants.delete(replyId); // Claim synchronously before the first await.
        const delivery = job.session!.respond(
          grant.request.reply(decision.data),
        );
        job.deliveries.add(delivery);
        notify(job);
        try {
          await delivery;
          grant.delivered.resolve();
        } catch (error) {
          grant.delivered.reject(error);
          throw error;
        }
        json(response, 200, snapshot(job));
      } else if (request.method === 'GET' && action === 'artifact') {
        if (!job.artifact) throw new HttpError(409, 'artifact_unavailable');
        response
          .writeHead(200, {
            'content-type': 'application/json',
            'content-disposition': 'attachment; filename="report.json"',
            'cache-control': 'no-store',
          })
          .end(job.artifact);
      } else throw new HttpError(404, 'not_found');
    })().catch((error: unknown) => {
      if (response.headersSent) response.destroy();
      else
        json(
          response,
          error instanceof HttpError
            ? error.status
            : error instanceof RangeError
              ? 400
              : 500,
          {
            error:
              error instanceof HttpError
                ? error.category
                : error instanceof RangeError
                  ? 'invalid_cursor'
                  : 'request_failed',
          },
        );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP address');
  let closed: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close() {
      return (closed ??= (async () => {
        closing = true;
        const listenerClosed = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        for (const job of jobs.values())
          for (const detach of job.readers) detach();
        await Promise.all(Array.from(jobs.values(), stop));
        await listenerClosed;
      })());
    },
  };
}
async function main() {
  const token = process.env.REPORT_SERVICE_TOKEN;
  if (!token)
    throw new Error('Set REPORT_SERVICE_TOKEN before starting the example.');
  await using provider = new NativeProvider({
    baseUrl: process.env.OPENAI_BASE_URL,
  });
  const service = await startReportService({
    provider,
    port: 3000,
    authenticate: (request) =>
      request.headers.authorization === `Bearer ${token}`
        ? 'demo-user'
        : undefined,
  });
  console.log(service.url);
  const stopped = Promise.withResolvers<void>();
  const shutdown = () => stopped.resolve();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await stopped.promise;
  } finally {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await service.close();
  }
}
if (typeof require !== 'undefined' && require.main === module) {
  main().catch(() => {
    console.error('Report service failed.');
    process.exitCode = 1;
  });
}
