import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

type WorkerMessage = { type: string; [key: string]: unknown };
const homes: string[] = [];
const workers: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(
    workers.splice(0).map(async (child) => {
      if (
        child.pid === undefined ||
        child.exitCode !== null ||
        child.signalCode !== null
      )
        return;
      const exited = new Promise<void>((resolve) =>
        child.once('exit', () => resolve()),
      );
      child.kill('SIGKILL');
      await exited;
    }),
  );
  await ModelServer.closeAll();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

async function journal(path: string): Promise<unknown[]> {
  try {
    const text = await readFile(path, 'utf8');
    return text.trim()
      ? text
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function toolText(request: JsonObject, callId: string): string {
  const result = (request.input as JsonObject[]).find(
    (item) => item.type === 'function_call_output' && item.call_id === callId,
  );
  expect(result, `Missing tool result: ${callId}`).toBeDefined();
  return typeof result!.output === 'string'
    ? result!.output
    : (result!.output as JsonObject[]).map((part) => part.text ?? '').join('');
}

async function worker(
  server: ModelServer,
  settings: {
    profile: string;
    effects: string;
    resume?: string;
  },
) {
  const config = await server.config();
  const child = fork(
    fileURLToPath(
      new URL('./fixtures/retained-approval-worker.ts', import.meta.url),
    ),
    [
      JSON.stringify({
        ...settings,
        url: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
      }),
    ],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  workers.push(child);
  const messages: WorkerMessage[] = [];
  let stdout = '';
  let stderr = '';
  let spawnError: Error | undefined;
  let closed = false;
  child.stdout?.on('data', (data) => {
    stdout += String(data);
  });
  child.stderr?.on('data', (data) => {
    stderr += String(data);
  });
  child.on('error', (error) => {
    spawnError = error;
  });
  child.on('message', (message) => messages.push(message as WorkerMessage));
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      // close follows process exit and drains both captured streams.
      child.once('close', (code, signal) => {
        closed = true;
        resolve({ code, signal });
      });
    },
  );
  const failure = () =>
    new Error(
      `Worker exited or failed: ${spawnError ?? ''} ${stderr} ${JSON.stringify(messages)}`,
    );
  async function wait(type: string): Promise<WorkerMessage> {
    const found = messages.find((message) => message.type === type);
    if (found) return found;
    if (
      spawnError ||
      messages.some((message) => message.type === 'failure') ||
      closed
    )
      throw failure();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        child.off('message', receive);
        child.off('close', fail);
        child.off('error', fail);
      };
      const fail = () => {
        cleanup();
        reject(failure());
      };
      const receive = (value: unknown) => {
        const message = value as WorkerMessage;
        if (message.type === 'failure') {
          fail();
          return;
        }
        if (message.type !== type) return;
        cleanup();
        resolve(message);
      };
      child.on('message', receive);
      child.once('close', fail);
      child.once('error', fail);
    });
  }
  const send = (message: WorkerMessage) =>
    new Promise<void>((resolve, reject) => {
      child.send(message, (error) => (error ? reject(error) : resolve()));
    });
  return { wait, send, exited, messages, stdio: () => ({ stdout, stderr }) };
}

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'retained application approval and restart',
  () => {
    it.each([true, false])(
      'keeps the allowed=%s action count unchanged after a fresh-process restart',
      async (allow) => {
        const home = await mkdtemp(join(tmpdir(), 'retained-approval-'));
        homes.push(home);
        const effects = join(home, 'effects.jsonl');
        const profile = join(home, 'profile');
        const expected = allow ? [{ id: 'case-42', receipt: 'effect-1' }] : [];
        const final = allow
          ? 'Action recorded with receipt effect-1.'
          : 'The application denied the action.';
        const source = new ModelServer([
          [
            call(
              'read_memory',
              { key: 'selected-action' },
              { callId: 'lookup-action' },
            ),
          ],
          (request) => {
            const selected = JSON.parse(toolText(request, 'lookup-action'));
            expect(selected).toEqual({
              id: 'case-42',
              description: 'Record the selected application action',
            });
            return [
              call(
                'execute_action',
                { id: selected.id },
                { callId: 'requested-action' },
              ),
            ];
          },
          (request) => {
            const result = toolText(request, 'requested-action');
            if (allow) expect(JSON.parse(result)).toEqual(expected[0]);
            else expect(result).toBe('Application denied action case-42');
            return [message(final)];
          },
        ]);
        const first = await worker(source, { profile, effects });
        const opened = await first.wait('opened');
        expect(source.requests).toHaveLength(0);
        await first.send({ type: 'continue' });
        const approval = await first.wait('approval');
        expect(approval.action).toEqual({
          id: 'case-42',
          description: 'Record the selected application action',
        });
        expect(approval.stages).toEqual(['lookup', 'approval']);
        expect(source.requests).toHaveLength(2);
        expect(
          first.messages.some((message) => message.type === 'effect'),
        ).toBe(false);
        expect(await journal(effects)).toEqual([]);
        await first.send({ type: 'decision', allow });
        const result = await first.wait('result');
        expect(result.output).toBe(final);
        expect(result.stages).toEqual(
          allow ? ['lookup', 'approval', 'execute'] : ['lookup', 'approval'],
        );
        await first.wait('done');
        expect(await first.exited).toEqual({ code: 0, signal: null });
        expect(first.stdio()).toEqual({ stdout: '', stderr: '' });
        expect(await journal(effects)).toEqual(expected);
        source.assertExhausted();
        const destination = new ModelServer([
          (request) => {
            expect(JSON.stringify(request.input)).toContain(final);
            return [
              message(
                'The previous result is preserved. No new action was requested.',
              ),
            ];
          },
        ]);
        expect(typeof opened.id).toBe('string');
        const second = await worker(destination, {
          profile,
          effects,
          resume: opened.id as string,
        });
        const reopened = await second.wait('opened');
        expect(reopened.id).toBe(opened.id);
        expect(JSON.stringify(reopened.history)).toContain(final);
        expect(destination.requests).toHaveLength(0);
        expect(await journal(effects)).toEqual(expected);
        await second.send({ type: 'continue' });
        expect((await second.wait('result')).stages).toEqual([]);
        await second.wait('done');
        expect(await second.exited).toEqual({ code: 0, signal: null });
        expect(second.stdio()).toEqual({ stdout: '', stderr: '' });
        expect(
          second.messages.some(
            (message) =>
              message.type === 'effect' || message.type === 'approval',
          ),
        ).toBe(false);
        expect(await journal(effects)).toEqual(expected);
        destination.assertExhausted();
        const evidence = process.env.RETAINED_WORKFLOW_EVIDENCE_DIR;
        if (evidence)
          await writeFile(
            join(evidence, `approval-${allow ? 'allowed' : 'denied'}.json`),
            JSON.stringify({
              allow,
              sessionId: opened.id,
              effects: await journal(effects),
              sourceRequests: source.requests.length,
              destinationRequests: destination.requests.length,
            }),
            { flag: 'wx' },
          );
      },
    );
  },
);
