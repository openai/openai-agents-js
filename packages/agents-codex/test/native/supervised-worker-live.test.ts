import { fork } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { call, message, ModelServer } from './fixtures/model-server';

const script = fileURLToPath(
  new URL(
    '../../../../examples/codex/supervised-worker/live.ts',
    import.meta.url,
  ),
);
const syntheticKey = 'synthetic-live-worker-only';
const largeUsage =
  '{"input_tokens":9007199254740993,"input_tokens_details":{"cached_tokens":9007199254740990},"output_tokens":7,"output_tokens_details":{"reasoning_tokens":2},"total_tokens":9007199254741000}';
type RecordValue = Record<string, unknown>;
const cleanups: Array<() => Promise<unknown>> = [];

function launch(args: string[], baseUrl?: string) {
  const child = fork(script, args, {
    execArgv: ['--import', 'tsx'],
    env: {
      ...process.env,
      OPENAI_API_KEY: syntheticKey,
      OPENAI_BASE_URL: baseUrl,
      OPENAI_MODEL: 'gpt-5',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '';
  let stderr = '';
  const records: RecordValue[] = [];
  child.stdout!.on('data', (chunk) => {
    stdout += String(chunk);
    for (;;) {
      const newline = stdout.indexOf('\n');
      if (newline < 0) break;
      records.push(JSON.parse(stdout.slice(0, newline)) as RecordValue);
      stdout = stdout.slice(newline + 1);
    }
  });
  child.stderr!.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const done = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    },
  );
  const processHandle = {
    child,
    records,
    done,
    async finish(code = 0) {
      expect(await done, stderr.replaceAll(syntheticKey, '[redacted]')).toEqual(
        { code, signal: null },
      );
      expect(stderr).not.toContain(syntheticKey);
      return records;
    },
    async kill(signal: NodeJS.Signals = 'SIGKILL') {
      if (child.exitCode === null && child.signalCode === null)
        child.kill(signal);
      return done;
    },
  };
  cleanups.push(() => processHandle.kill());
  return processHandle;
}

async function owner(model: ModelServer) {
  const config = await model.config();
  const worker = launch(
    ['serve', 'Prepare a short report; ask for the missing date.'],
    (config['model_providers.fixture'] as { base_url: string }).base_url,
  );
  await expect
    .poll(() => worker.records[0], { timeout: 20_000 })
    .toMatchObject({ directory: expect.any(String) });
  return {
    worker,
    directory: worker.records[0].directory as string,
    identity: worker.records[0],
  };
}

async function command(...args: string[]) {
  return (await launch(args).finish())[0];
}

async function unauthorized(directory: string, path: string, payload?: object) {
  return new Promise<{ status?: number; body: string }>((resolve, reject) => {
    const outgoing = request(
      {
        socketPath: join(directory, 'control.sock'),
        path,
        method: payload ? 'POST' : 'GET',
        headers: { authorization: 'Bearer wrong' },
        agent: false,
      },
      (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += String(chunk);
        });
        response.on('end', () =>
          resolve({ status: response.statusCode, body }),
        );
      },
    );
    outgoing.once('error', reject);
    outgoing.end(payload ? JSON.stringify(payload) : undefined);
  });
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await ModelServer.closeAll();
});

it.skipIf(process.platform === 'win32')(
  'attaches, detaches, reconnects, steers exactly, and answers on the same live root',
  async () => {
    const releaseQuestion = Promise.withResolvers<void>();
    const releaseFinal = Promise.withResolvers<void>();
    const model = new ModelServer(
      [
        async () => {
          await releaseQuestion.promise;
          return [
            call(
              'ask_supervisor',
              { question: 'Which date?' },
              { callId: 'live-date' },
            ),
          ];
        },
        async (request) => {
          const input = JSON.stringify(request.input);
          expect(input).toContain('Keep the report short.');
          expect(input).toContain('Tuesday');
          expect(input).not.toContain('wrong identity');
          await releaseFinal.promise;
          return [message('Short report for Tuesday.')];
        },
      ],
      [() => undefined, largeUsage],
    );
    try {
      const { worker, directory, identity } = await owner(model);
      const firstReader = launch(['observe', directory]);
      await expect
        .poll(
          () =>
            firstReader.records.find((event) => event.type === 'turn_started'),
          { timeout: 10_000 },
        )
        .toMatchObject({
          turnId: identity.turnId,
          submissionId: identity.submissionId,
        });
      await expect.poll(() => model.requests.length).toBe(1);
      expect(await unauthorized(directory, '/status')).toEqual({
        status: 401,
        body: '{"error":"unauthorized"}\n',
      });
      expect(
        (
          await unauthorized(directory, '/steer', {
            expectedTurnId: identity.turnId,
            text: 'wrong identity',
          })
        ).status,
      ).toBe(401);
      await launch([
        'steer',
        directory,
        'wrong-turn-id',
        'wrong identity',
      ]).finish(1);
      expect(
        await command(
          'steer',
          directory,
          identity.turnId as string,
          'Keep the report short.',
        ),
      ).toMatchObject({
        turnId: identity.turnId,
        submissionId: identity.submissionId,
        inputId: expect.any(String),
      });
      const cursor = firstReader.records.at(-1)!.sequence as number;
      await firstReader.kill('SIGTERM');
      releaseQuestion.resolve();
      let status: RecordValue | undefined;
      await expect
        .poll(
          async () => {
            status = await command('status', directory);
            return status.questions;
          },
          { timeout: 10_000 },
        )
        .toEqual([
          {
            turnId: identity.turnId,
            callId: 'live-date',
            question: 'Which date?',
          },
        ]);
      expect(status).toMatchObject({
        state: 'running',
        sessionId: identity.sessionId,
        submissionId: identity.submissionId,
      });
      expect(model.requests).toHaveLength(1);
      expect(worker.child.exitCode).toBeNull();
      const secondReader = launch(['observe', directory, String(cursor)]);
      await expect
        .poll(() => secondReader.records.length, { timeout: 10_000 })
        .toBeGreaterThan(0);
      expect(
        secondReader.records.every(
          (event) => (event.sequence as number) > cursor,
        ),
      ).toBe(true);
      await launch([
        'answer',
        directory,
        'wrong-turn-id',
        'live-date',
        'Tuesday',
      ]).finish(1);
      expect(
        await command(
          'answer',
          directory,
          identity.turnId as string,
          'live-date',
          'Tuesday',
        ),
      ).toEqual({ delivered: true });
      await launch([
        'answer',
        directory,
        identity.turnId as string,
        'live-date',
        'Tuesday',
      ]).finish(1);
      await expect.poll(() => model.requests.length).toBe(2);
      expect(await command('status', directory)).toMatchObject({
        state: 'running',
        questions: [],
        submissionId: identity.submissionId,
      });
      releaseFinal.resolve();
      await expect
        .poll(async () => (await command('status', directory)).state, {
          timeout: 10_000,
        })
        .toBe('completed');
      expect(await command('status', directory)).toMatchObject({
        state: 'completed',
        result: 'Short report for Tuesday.',
        sessionId: identity.sessionId,
        submissionId: identity.submissionId,
        turnId: identity.turnId,
        questions: [],
      });
      const completed = expect.objectContaining({
        type: 'turn_finished',
        status: 'completed',
      });
      expect(await secondReader.finish()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'usage_updated',
            usage: expect.objectContaining({
              lastTokenUsage: expect.objectContaining({
                inputTokens: '9007199254740993',
                cachedInputTokens: 9007199254740990,
                outputTokens: 7,
                totalTokens: '9007199254741000',
              }),
            }),
          }),
          completed,
        ]),
      );
      const finalEvents = await launch([
        'observe',
        directory,
        String(cursor),
      ]).finish();
      expect(finalEvents).toContainEqual(completed);
      expect(
        finalEvents.every(
          (event) =>
            event.type !== 'turn_started' ||
            event.submissionId === identity.submissionId ||
            event.parentSubmissionId === identity.submissionId,
        ),
      ).toBe(true);
      model.assertExhausted();
      await worker.kill('SIGTERM');
      await worker.finish();
    } finally {
      releaseQuestion.resolve();
      releaseFinal.resolve();
    }
  },
  60_000,
);

it.skipIf(process.platform === 'win32')(
  'cancels a pending live question and rejects an exposed client directory',
  async () => {
    const model = new ModelServer([
      [
        call(
          'ask_supervisor',
          { question: 'Which date?' },
          { callId: 'cancel-date' },
        ),
      ],
    ]);
    const { worker, directory, identity } = await owner(model);
    await expect
      .poll(async () => (await command('status', directory)).questions, {
        timeout: 10_000,
      })
      .toEqual([
        {
          turnId: identity.turnId,
          callId: 'cancel-date',
          question: 'Which date?',
        },
      ]);
    await chmod(directory, 0o755);
    await launch(['status', directory]).finish(1);
    await chmod(directory, 0o700);
    expect(await command('cancel', directory)).toMatchObject({
      state: 'cancelled',
      questions: [],
    });
    await launch([
      'answer',
      directory,
      identity.turnId as string,
      'cancel-date',
      'Tuesday',
    ]).finish(1);
    expect(await command('cancel', directory)).toMatchObject({
      state: 'cancelled',
    });
    expect(model.requests).toHaveLength(1);
    model.assertExhausted();
    await worker.kill('SIGTERM');
    await worker.finish();
  },
  45_000,
);

it.skipIf(process.platform === 'win32')(
  'retains a provider failure without exposing provider diagnostics',
  async () => {
    const model = new ModelServer([
      {
        status: 400,
        body: JSON.stringify({
          error: {
            type: 'invalid_request_error',
            code: 'invalid_request_error',
            message: `Synthetic diagnostic containing ${syntheticKey}`,
          },
        }),
      },
    ]);
    const { worker, directory } = await owner(model);
    await expect
      .poll(async () => (await command('status', directory)).state, {
        timeout: 10_000,
      })
      .toBe('failed');
    const status = await command('cancel', directory);
    expect(status).toMatchObject({ state: 'failed', questions: [] });
    expect(JSON.stringify(status)).not.toContain(syntheticKey);
    model.assertExhausted();
    await worker.kill('SIGTERM');
    await worker.finish();
  },
  30_000,
);
