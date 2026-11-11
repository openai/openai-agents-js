import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelServer, call, message } from './fixtures/model-server';
const children: ChildProcess[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exit = new Promise<void>((resolve) =>
      child.once('exit', () => resolve()),
    );
    child.kill('SIGKILL');
    await exit;
  }
  await ModelServer.closeAll();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
// The existing custom-storage worker protocol, with no SDK imports in the parent process.
function worker(config: Record<string, unknown>) {
  const child = fork(
    fileURLToPath(
      new URL('./fixtures/terminal-receipt-worker.ts', import.meta.url),
    ),
    [JSON.stringify(config)],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  children.push(child);
  const messages: Record<string, unknown>[] = [];
  let stderr = '';
  child.stderr?.on('data', (data) => {
    stderr += String(data);
  });
  child.on('message', (value) =>
    messages.push(value as Record<string, unknown>),
  );
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  async function wait(type: string): Promise<Record<string, unknown>> {
    const found = messages.find((m) => m.type === type);
    if (found) return found;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off('message', receive);
        child.off('exit', fail);
        child.off('error', reject);
      };
      const receive = (raw: unknown) => {
        const value = raw as Record<string, unknown>;
        if (value.type === type) {
          cleanup();
          resolve(value);
        }
      };
      const fail = () => {
        cleanup();
        reject(
          new Error(
            `Receipt worker exited before ${type}: ${stderr} ${JSON.stringify(messages)}`,
          ),
        );
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Receipt worker timed out before ${type}`));
      }, 30_000);
      child.on('message', receive);
      child.once('exit', fail);
      child.once('error', reject);
      if (child.exitCode !== null || child.signalCode !== null) fail();
    });
  }
  return { child, exited, wait, messages };
}
describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'terminal receipt recovery',
  () => {
    it('T02/T15 does not turn a saved accepted result into fresh terminal authority after process loss', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'terminal-receipt-'));
      directories.push(directory);
      const effects = join(directory, 'effects');
      const server = new ModelServer([
        [call('finish', {}, { callId: 'accepted-before-crash' })],
        [message(JSON.stringify('ordinary after reopen'))],
      ]);
      const config = await server.config();
      const url = (config['model_providers.fixture'] as { base_url: string })
        .base_url;
      const first = worker({ directory, effects, url, holdReceipt: true });
      const opened = await first.wait('opened');
      await first.wait('durable-receipt');
      // Durable tool outcome only; application completion still pending at this barrier.
      expect(first.messages.filter((m) => m.type === 'result')).toEqual([]);
      first.child.kill('SIGKILL');
      expect((await first.exited).signal).toBe('SIGKILL');
      // The sole prior writer has exited. This is the same explicit stale-lease cleanup used by custom-storage-durability-native.test.ts.
      await rm(join(directory, `${opened.id}.lock`), { recursive: true });
      const next = worker({
        directory,
        effects,
        url,
        holdReceipt: false,
        resume: opened.id,
      });
      expect((await next.wait('opened')).restoredTurn).toBe(false);
      const result = await next.wait('result');
      expect(result.value).toBe('ordinary after reopen');
      expect(result.terminal).toBe(false);
      expect((await next.exited).code).toBe(0);
      expect(next.messages.filter((m) => m.type === 'validated')).toEqual([
        { type: 'validated', value: 'ordinary after reopen' },
      ]);
      expect(await readFile(effects, 'utf8')).toBe('effect\n');
      expect(server.requests).toHaveLength(2);
      expect(JSON.stringify(server.requests[1].input)).toContain(
        'accepted once',
      );
      server.assertExhausted();
    }, 90_000);
  },
);
