import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  createServer,
  request,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Agent,
  NativeProvider,
  TurnAborted,
  manualTool,
  type Turn,
} from '@openai/agents';
import { z } from 'zod';

const askSupervisor = manualTool({
  name: 'ask_supervisor',
  description: 'Ask the supervisor for information needed to finish the task.',
  parameters: z.object({ question: z.string().min(1).max(2000) }),
  result: z.string().min(1).max(8000),
});
const text = z.string().min(1).max(8000);
const identity = z.string().min(1).max(256);
const steering = z.strictObject({ text, expectedTurnId: identity });
const answer = z.strictObject({ text, turnId: identity, callId: identity });

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value) + '\n');
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new HttpError(413, 'body_too_large');
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

async function observe(turn: Turn, response: ServerResponse, after: number) {
  const reader = turn.events({ after });
  const disconnected = new AbortController();
  const close = () => {
    disconnected.abort();
    void reader.return?.();
  };
  response.once('close', close);
  response.writeHead(200, {
    'content-type': 'application/x-ndjson',
    'cache-control': 'no-store',
  });
  response.flushHeaders();
  try {
    for await (const event of reader) {
      if (disconnected.signal.aborted) break;
      const line = JSON.stringify(event, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
      if (!response.write(line + '\n'))
        await once(response, 'drain', { signal: disconnected.signal });
    }
    response.end();
  } finally {
    response.off('close', close);
    await reader.return?.();
  }
}

// The operator's local temporary directory setting is trusted configuration.
// The owner and supervisors must use the same root.
async function temporaryRoot() {
  if (!process.getuid) throw new Error('POSIX host required');
  const root = await realpath(tmpdir());
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    (info.uid !== 0 && info.uid !== process.getuid()) ||
    ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)
  )
    throw new Error('Untrusted temporary root');
  return root;
}

async function serve(prompt: string) {
  const directory = await mkdtemp(join(await temporaryRoot(), 'agents-live-'));
  await chmod(directory, 0o700);
  const token = randomBytes(32).toString('hex');
  const socketPath = join(directory, 'control.sock');
  const stopping = new AbortController();
  const stop = () => stopping.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const server = createServer();
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  try {
    await writeFile(join(directory, 'token'), token, {
      mode: 0o600,
      flag: 'wx',
    });
    await using provider = new NativeProvider({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL,
      supportsWebsockets: false,
    });
    await using session = await new Agent({
      provider,
      model: process.env.OPENAI_MODEL ?? 'gpt-5',
      instructions:
        'Complete the task. Ask ask_supervisor when you need a decision or missing information. Use its answer to finish.',
      tools: [askSupervisor],
    }).session({ projectGuidance: false, signal: stopping.signal });
    const turn = await session.submit(prompt);
    let state = 'running';
    let result: string | undefined;
    const completion = turn.wait().then(
      (completed) => {
        result = completed.finalOutput;
        state = 'completed';
      },
      (error: unknown) => {
        state = error instanceof TurnAborted ? 'cancelled' : 'failed';
      },
    );
    let cancellation: Promise<void> | undefined;
    function cancel() {
      if (!cancellation) {
        if (state === 'running') state = 'cancelling';
        cancellation = turn.cancel().then(() => completion);
      }
      return cancellation;
    }
    async function questions() {
      const pending = await session.pendingInteractions();
      return pending.flatMap((interaction) => {
        const question = askSupervisor.match(interaction);
        return question ? [question] : [];
      });
    }
    async function status() {
      const pending = await questions();
      return {
        sessionId: session.id,
        submissionId: turn.submissionId,
        turnId: turn.turnId,
        state,
        result,
        questions: pending.map((question) => ({
          turnId: question.turnId,
          callId: question.callId,
          question: question.arguments.question,
        })),
      };
    }
    server.on('request', (request, response) => {
      void (async () => {
        const supplied = Buffer.from(request.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${token}`);
        if (
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        )
          throw new HttpError(401, 'unauthorized');
        const url = new URL(request.url ?? '/', 'http://local');
        if (request.method === 'GET' && url.pathname === '/status') {
          json(response, 200, await status());
        } else if (request.method === 'GET' && url.pathname === '/events') {
          const cursor = url.searchParams.get('after') ?? '0';
          if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
            throw new HttpError(400, 'invalid_cursor');
          await observe(turn, response, Number(cursor));
        } else if (request.method === 'POST' && url.pathname === '/steer') {
          const value = steering.safeParse(await body(request));
          if (!value.success) throw new HttpError(400, 'invalid_steering');
          const receipt = await turn
            .steerExact(value.data.text, value.data.expectedTurnId)
            .catch(() => {
              throw new HttpError(409, 'steering_rejected');
            });
          json(response, 200, receipt);
        } else if (request.method === 'POST' && url.pathname === '/answer') {
          const value = answer.safeParse(await body(request));
          if (!value.success) throw new HttpError(400, 'invalid_answer');
          const question = (await questions()).find(
            (candidate) =>
              candidate.turnId === value.data.turnId &&
              candidate.callId === value.data.callId,
          );
          if (!question) throw new HttpError(409, 'stale_question');
          // SDK request authority claims delivery. A second client cannot replay it.
          try {
            await session.respond(question.reply(value.data.text));
          } catch {
            throw new HttpError(409, 'answer_rejected');
          }
          json(response, 200, { delivered: true });
        } else if (request.method === 'POST' && url.pathname === '/cancel') {
          if (!z.strictObject({}).safeParse(await body(request)).success)
            throw new HttpError(400, 'invalid_cancel');
          await cancel();
          json(response, 200, await status());
        } else throw new HttpError(404, 'not_found');
      })().catch((error: unknown) => {
        if (response.destroyed) return;
        if (response.headersSent) {
          response.destroy();
          return;
        }
        // Provider diagnostics can contain secrets or model content.
        json(response, error instanceof HttpError ? error.status : 500, {
          error:
            error instanceof HttpError ? error.message : 'operation_failed',
        });
      });
    });
    try {
      server.listen(socketPath);
      await once(server, 'listening');
      await chmod(socketPath, 0o600);
      process.stdout.write(
        JSON.stringify({
          directory,
          sessionId: session.id,
          turnId: turn.turnId,
          submissionId: turn.submissionId,
        }) + '\n',
      );
      if (!stopping.signal.aborted) await once(stopping.signal, 'abort');
    } finally {
      if (server.listening) {
        const closed = new Promise<void>((done) => server.close(() => done()));
        server.closeAllConnections();
        await closed;
      }
      await cancel();
      await completion;
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    // Only this run's freshly created directory belongs to this cleanup.
    await rm(directory, { recursive: true, force: true });
  }
}

async function connect(directory: string, path: string, payload?: unknown) {
  directory = resolve(directory);
  if (
    dirname(directory) !== (await temporaryRoot()) ||
    !basename(directory).startsWith('agents-live-')
  )
    throw new Error('Expected a live worker directory');
  const owner = process.getuid!();
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.uid !== owner ||
    (info.mode & 0o777) !== 0o700
  )
    throw new Error('Worker directory must be private and owned by this user');
  const tokenPath = join(directory, 'token');
  const tokenInfo = await lstat(tokenPath);
  const socketPath = join(directory, 'control.sock');
  const socketInfo = await lstat(socketPath);
  if (
    !tokenInfo.isFile() ||
    tokenInfo.uid !== owner ||
    tokenInfo.nlink !== 1 ||
    (tokenInfo.mode & 0o777) !== 0o600 ||
    tokenInfo.size !== 64 ||
    !socketInfo.isSocket() ||
    socketInfo.uid !== owner ||
    (socketInfo.mode & 0o777) !== 0o600
  )
    throw new Error('Invalid worker endpoint or credential permissions');
  const token = await readFile(tokenPath, 'utf8');
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new Error('Invalid worker credential');
  const outgoing = request({
    socketPath,
    path,
    method: payload === undefined ? 'GET' : 'POST',
    agent: false,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });
  const received = once(outgoing, 'response');
  outgoing.end(payload === undefined ? undefined : JSON.stringify(payload));
  const [response] = (await received) as [IncomingMessage];
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`Worker rejected request (HTTP ${response.statusCode})`);
  }
  for await (const chunk of response) {
    if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
  }
}

async function main(args: string[]) {
  const [command, directory, ...rest] = args;
  if (command === 'serve' && directory && rest.length === 0)
    return serve(directory);
  if (directory) {
    if (command === 'status' && rest.length === 0)
      return connect(directory, '/status');
    if (command === 'observe' && rest.length <= 1)
      return connect(
        directory,
        `/events?after=${encodeURIComponent(rest[0] ?? '0')}`,
      );
    if (command === 'steer' && rest.length === 2)
      return connect(directory, '/steer', {
        expectedTurnId: rest[0],
        text: rest[1],
      });
    if (command === 'answer' && rest.length === 3)
      return connect(directory, '/answer', {
        turnId: rest[0],
        callId: rest[1],
        text: rest[2],
      });
    if (command === 'cancel' && rest.length === 0)
      return connect(directory, '/cancel', {});
  }
  throw new Error(
    'Usage: live.ts serve PROMPT | status DIR | observe DIR [AFTER] | steer DIR TURN_ID TEXT | answer DIR TURN_ID CALL_ID TEXT | cancel DIR',
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Do not print thrown provider errors, request bodies, or credentials.
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message =
      error instanceof Error &&
      error.message.startsWith('Worker rejected request')
        ? error.message
        : 'Live worker command failed; check arguments, credentials, and native build.';
    process.stderr.write(message + '\n');
    process.exitCode = 1;
  });
}
