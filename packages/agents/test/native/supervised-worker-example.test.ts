import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, type TestContext } from 'vitest';
import {
  publishAcceptedDraft,
  readWorkerSnapshot,
} from '../../examples/supervised-worker/worker';
import {
  startReportPeer,
  type StoredReport,
} from '../../examples/web-starter/mcp-peer';
import { call, message, ModelServer } from './fixtures/model-server';

const script = fileURLToPath(
  new URL('./fixtures/supervised-worker.ts', import.meta.url),
);
const sandboxRequired = process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX === '1';
const sandboxTest = it.skipIf(process.platform !== 'linux' && !sandboxRequired);

function launch(
  options: object,
  startupContext?: TestContext,
  watchdogMs = 45_000,
) {
  expect(process.platform, 'Sandbox qualification requires Linux.').toBe(
    'linux',
  );
  const child = fork(script, [JSON.stringify(options)], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', (data) => {
    stderr += String(data);
  });
  const effect = Promise.withResolvers<string>();
  const timer = setTimeout(() => child.kill('SIGKILL'), watchdogMs);
  timer.unref();
  const done = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('message', (value: { type?: string; callId?: string }) => {
        if (value.type === 'effect' && value.callId)
          effect.resolve(value.callId);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    },
  );
  void done.catch(() => {});
  return {
    async applied() {
      return Promise.race([
        effect.promise,
        done.then(() => {
          throw new Error('Worker exited before the effect: ' + stderr);
        }),
      ]);
    },
    async finish(code = 0) {
      const outcome = await done;
      if (
        startupContext &&
        !sandboxRequired &&
        outcome.code === 1 &&
        stderr.includes(
          '[Error: local executor could not establish the platform sandbox]',
        )
      ) {
        startupContext.skip(
          'This host could not establish the platform sandbox.',
        );
      }
      expect(outcome, stderr).toEqual({ code, signal: null });
      return stderr;
    },
    async kill() {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      return await done;
    },
  };
}

function draft(callId: string, text: string) {
  return call(
    'exec_command',
    {
      cmd: `printf '%s\\n' '# Release note' '${text}' > draft.md && sha256sum draft.md`,
    },
    { callId },
  );
}

function claim(summary: string, question: string | null) {
  return message(JSON.stringify({ summary, question }));
}

async function modelUrl(model: ModelServer) {
  const config = await model.config();
  return (config['model_providers.fixture'] as { base_url: string }).base_url;
}

sandboxTest(
  'steers and reconnects two worker processes, then revises and reconciles the original conversations',
  async (context) => {
    const directory = await mkdtemp(
      join(tmpdir(), 'supervised-native-workers-'),
    );
    const workers: ReturnType<typeof launch>[] = [];
    const steer = Promise.withResolvers<void>();
    const reports: StoredReport[] = [];
    const peer = await startReportPeer({
      storeReport(report) {
        reports.push(report);
      },
    });
    try {
      const alice = new ModelServer([
        async () => {
          await steer.promise;
          return [
            call(
              'report',
              {},
              { namespace: 'reports', callId: 'alice-report' },
            ),
          ];
        },
        [draft('alice-draft', 'Alice finished after a restart.')],
        [claim('Alice finished.', null)],
      ]);
      const bob = new ModelServer([
        [call('report', {}, { namespace: 'reports', callId: 'bob-report' })],
        [claim('Bob has a question.', 'What date should I use?')],
        [draft('bob-draft', 'Bob used the supplied date.')],
        [claim('Bob revised the note.', null)],
      ]);
      const aliceConfig = {
        directory: join(directory, 'alice'),
        modelUrl: await modelUrl(alice),
        reportsUrl: peer.url,
        reportsToken: peer.issue('alice').token,
        task: 'Draft a release note.',
      };
      const bobConfig = {
        directory: join(directory, 'bob'),
        modelUrl: await modelUrl(bob),
        reportsUrl: peer.url,
        reportsToken: peer.issue('bob').token,
        task: 'Ask if you need the date.',
      };
      function start(config: object, startupContext?: TestContext) {
        const worker = launch(config, startupContext);
        workers.push(worker);
        return worker;
      }
      const firstAlice = start({
        ...aliceConfig,
        steer: 'Keep it brief.',
        stopAfterEffect: true,
      });
      const firstBob = start(bobConfig, context);
      await firstBob.finish();
      await expect
        .poll(
          async () =>
            (await readWorkerSnapshot(aliceConfig.directory))?.steering,
          { timeout: 20_000 },
        )
        .toMatchObject({
          turnId: expect.any(String),
          inputId: expect.any(String),
        });
      const aliceLive = await readWorkerSnapshot(aliceConfig.directory);
      const bobQuestion = await readWorkerSnapshot(bobConfig.directory);
      expect(aliceLive?.state).toBe('working');
      expect(bobQuestion).toMatchObject({
        state: 'needs_review',
        claim: { question: 'What date should I use?' },
        timings: { firstToolMs: expect.any(Number) },
      });
      expect(aliceLive?.threadId).not.toBe(bobQuestion?.threadId);

      steer.resolve();
      const confirmedCallId = await firstAlice.applied();
      expect(confirmedCallId).toBe('alice-report');
      expect(reports.map((report) => report.owner).sort()).toEqual([
        'alice',
        'bob',
      ]);
      expect((await firstAlice.kill()).signal).toBe('SIGKILL');

      const revisedBob = start({
        ...bobConfig,
        task: 'Use November 4 and revise the draft.',
      });
      const recoveredAlice = start({
        ...aliceConfig,
        task: 'Continue with the confirmed report.',
        confirmedCallId,
      });
      await Promise.all([revisedBob.finish(), recoveredAlice.finish()]);
      expect(reports).toHaveLength(2);
      expect(JSON.stringify(alice.requests[1].input)).toContain(
        'The application confirmed that this synthetic report was recorded.',
      );
      expect(JSON.stringify(bob.requests[2].input)).toContain(
        'What date should I use?',
      );
      for (const [config, prior] of [
        [aliceConfig, aliceLive],
        [bobConfig, bobQuestion],
      ] as const) {
        const accepted = await readWorkerSnapshot(config.directory);
        expect(accepted).toMatchObject({
          threadId: prior?.threadId,
          state: 'accepted',
          evidence: expect.any(String),
          timings: {
            startupMs: expect.any(Number),
            followUpSubmissionMs: expect.any(Number),
            completionMs: expect.any(Number),
          },
        });
        const published = await publishAcceptedDraft(config.directory);
        expect(await publishAcceptedDraft(config.directory)).toBe(published);
        expect(await readFile(published, 'utf8')).toMatch(/^# Release note\n/);
      }
      await writeFile(
        join(bobConfig.directory, 'workspace', 'draft.md'),
        'changed',
      );
      await expect(publishAcceptedDraft(bobConfig.directory)).rejects.toThrow(
        'Draft changed after acceptance',
      );
      alice.assertExhausted();
      bob.assertExhausted();
    } finally {
      steer.resolve();
      await Promise.all(workers.map((worker) => worker.kill()));
      await peer.close();
      await ModelServer.closeAll();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);

sandboxTest(
  'records a terminal review status when the completed turn leaves an oversized draft',
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'invalid-native-draft-'));
    const peer = await startReportPeer({ storeReport: () => undefined });
    let worker: ReturnType<typeof launch> | undefined;
    try {
      const workspace = join(directory, 'workspace');
      await mkdir(workspace);
      await writeFile(join(workspace, 'draft.md'), Buffer.alloc(4097));
      const model = new ModelServer([[claim('Draft ready.', null)]]);
      worker = launch(
        {
          directory,
          modelUrl: await modelUrl(model),
          reportsUrl: peer.url,
          reportsToken: peer.issue('alice').token,
          task: 'Review the existing draft.',
        },
        context,
      );

      expect(await worker.finish(1)).toContain(
        'Draft must be a private regular file of at most 4 KiB.',
      );
      expect(await readWorkerSnapshot(directory)).toMatchObject({
        state: 'needs_review',
        claim: { summary: 'Draft ready.', question: null },
      });
      await expect(publishAcceptedDraft(directory)).rejects.toThrow(
        'Publication requires an accepted draft.',
      );
      model.assertExhausted();
    } finally {
      await worker?.kill();
      await peer.close();
      await ModelServer.closeAll();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

sandboxTest(
  'records that the worker needs attention when the model rejects authentication',
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'native-worker-auth-'));
    const peer = await startReportPeer({ storeReport: () => undefined });
    let rejectedRequests = 0;
    await using model = createServer((request, response) => {
      request.resume();
      rejectedRequests++;
      response.writeHead(401, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          error: {
            message: 'Synthetic authentication rejection.',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        }),
      );
    }).listen(0, '127.0.0.1');
    let worker: ReturnType<typeof launch> | undefined;
    try {
      await once(model, 'listening');
      const address = model.address();
      if (!address || typeof address === 'string')
        throw new Error('Expected TCP model listener.');
      worker = launch(
        {
          directory,
          modelUrl: `http://127.0.0.1:${address.port}/v1`,
          reportsUrl: peer.url,
          reportsToken: peer.issue('alice').token,
          task: 'Draft a release note.',
          turnMs: 60_000,
        },
        context,
        90_000,
      );
      expect(await worker.finish(1)).toContain(
        'Synthetic authentication rejection.',
      );
      expect(rejectedRequests).toBeGreaterThan(0);
      expect(await readWorkerSnapshot(directory)).toMatchObject({
        threadId: expect.any(String),
        state: 'needs_attention',
      });
    } finally {
      await worker?.kill();
      await peer.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);

sandboxTest(
  'joins a timed-out turn and reopens the same local worker',
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'timed-native-worker-'));
    const workers: ReturnType<typeof launch>[] = [];
    const release = Promise.withResolvers<void>();
    const peer = await startReportPeer({ storeReport: () => undefined });
    try {
      const model = new ModelServer([
        async () => {
          await release.promise;
          return [claim('Too late.', null)];
        },
        [draft('restarted-draft', 'The next turn finished.')],
        [claim('Recovered after the deadline.', null)],
      ]);
      const config = {
        directory,
        modelUrl: await modelUrl(model),
        reportsUrl: peer.url,
        reportsToken: peer.issue('alice').token,
        task: 'Draft a release note.',
      };
      const timed = launch({ ...config, turnMs: 1_000 }, context);
      workers.push(timed);
      expect(await timed.finish(1)).toMatch(/TimeoutError|aborted|deadline/i);
      const before = await readWorkerSnapshot(directory);
      expect(before).toMatchObject({
        state: 'needs_attention',
        attention: 'deadline',
      });
      expect(model.requests).toHaveLength(1);
      release.resolve();
      const next = launch(config);
      workers.push(next);
      await next.finish();
      expect(await readWorkerSnapshot(directory)).toMatchObject({
        threadId: before?.threadId,
        state: 'accepted',
      });
      model.assertExhausted();
    } finally {
      release.resolve();
      await Promise.all(workers.map((worker) => worker.kill()));
      await peer.close();
      await ModelServer.closeAll();
      await rm(directory, { recursive: true, force: true });
    }
  },
  80_000,
);
