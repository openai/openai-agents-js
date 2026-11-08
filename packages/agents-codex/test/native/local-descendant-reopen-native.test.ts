import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

function wireTools(request: JsonObject) {
  const selected: Array<{ namespace: string | undefined; name: string }> = [];
  function add(value: unknown, namespace?: string) {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (entry.type === 'namespace') add(entry.tools, entry.name);
      else if (entry.type === 'function' || entry.type === 'custom')
        selected.push({ namespace, name: entry.name });
    }
  }
  add(request.tools);
  if (Array.isArray(request.input))
    for (const item of request.input)
      if (
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        item.type === 'additional_tools' &&
        item.role === 'developer' &&
        Array.isArray(item.tools)
      )
        add(item.tools);
  return selected;
}

const workers: ChildProcess[] = [];
afterEach(async () => {
  for (const child of workers.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  }
  await ModelServer.closeAll();
});

function start(config: JsonObject) {
  const child = fork(
    fileURLToPath(
      new URL('./fixtures/local-descendant-worker.ts', import.meta.url),
    ),
    [JSON.stringify(config)],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  workers.push(child);
  const rows: Array<Record<string, any>> = [];
  let stderr = '';
  child.stderr!.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.on('message', (row) => rows.push(row as Record<string, any>));
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', resolve),
  );
  const wait = (type: string): Promise<Record<string, any>> => {
    const found = rows.find((row) => row.type === type);
    if (found) return Promise.resolve(found);
    const failure = rows.find((row) => row.type === 'failure');
    if (failure)
      return Promise.reject(new Error(`${failure.message}\n${stderr}`));
    return new Promise((resolve, reject) => {
      const onMessage = (row: any) => {
        if (row.type !== type && row.type !== 'failure') return;
        cleanup();
        if (row.type === 'failure')
          reject(new Error(`${row.message}\n${stderr}`));
        else resolve(row);
      };
      const onExit = () => {
        cleanup();
        reject(
          new Error(
            `Worker exited waiting for ${type}: ${JSON.stringify(rows)}\n${stderr}`,
          ),
        );
      };
      const cleanup = () => {
        child.off('message', onMessage);
        child.off('exit', onExit);
      };
      child.on('message', onMessage);
      child.once('exit', onExit);
      if (child.exitCode !== null || child.signalCode !== null) onExit();
    });
  };
  return { child, rows, wait, exited, stderr: () => stderr };
}

for (const depth of [1, 2]) {
  for (const noChildren of [false, true]) {
    for (const mode of ['settled', 'unknown', 'active'] as const) {
      it(`cold ${depth}-level ${mode} history with destination children ${!noChildren}`, async () => {
        const home = await mkdtemp(join(tmpdir(), 'native-local-descendants-'));
        const executor = await startPublicExecutor();
        const depths = new Map<string, number>();
        const counts = new Map<string, number>();
        let root: string | undefined;
        const active = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const respond = (request: JsonObject) => {
          const metadata = request.client_metadata as JsonObject | undefined;
          const encoded = metadata?.['x-codex-turn-metadata'];
          if (typeof encoded !== 'string')
            throw new Error('Native request omitted its turn metadata');
          const id = JSON.parse(encoded)?.thread_id;
          if (typeof id !== 'string' || !id)
            throw new Error('Native request omitted its thread identity');
          const tools = wireTools(request);
          const destination =
            server.requestHeaders.at(-1)!.authorization ===
            'Bearer synthetic-destination';
          if (destination) {
            expect(id).toBe(root);
            expect(tools).toContainEqual({
              namespace: 'functions',
              name: 'record_current',
            });
            expect(tools).not.toContainEqual({
              namespace: 'functions',
              name: 'record',
            });
            const input = request.input as Array<{ call_id?: string }>;
            return input.some((item) => item.call_id === 'fresh-current')
              ? [message('destination finished')]
              : [
                  call(
                    'record_current',
                    { key: 'fresh' },
                    { callId: 'fresh-current' },
                  ),
                ];
          }
          root ??= id;
          if (!depths.has(id)) depths.set(id, depths.size);
          const level = depths.get(id)!;
          const count = (counts.get(id) ?? 0) + 1;
          counts.set(id, count);
          if (level < depth) {
            if (count === 1) {
              expect(tools).toContainEqual({
                namespace: 'collaboration',
                name: 'spawn_agent',
              });
              return [
                call(
                  'spawn_agent',
                  {
                    task_name: level === 0 ? 'alpha' : 'grandchild',
                    message: 'Record the requested work.',
                    fork_turns: 'none',
                  },
                  { namespace: 'collaboration', callId: `spawn-${level}` },
                ),
              ];
            }
            const result = (request.input as JsonObject[]).find(
              (item) =>
                item.type === 'function_call_output' &&
                item.call_id === `spawn-${level}`,
            );
            expect(result, JSON.stringify(request.input)).toBeDefined();
            expect(typeof result!.output).toBe('string');
            expect(JSON.parse(result!.output as string)).toMatchObject({
              task_name: expect.stringMatching(
                level === 0 ? /\/alpha$/ : /\/alpha\/grandchild$/,
              ),
            });
            return [message('source parent finished')];
          }
          if (mode === 'active')
            return [{ ...message('held leaf'), id: 'held-leaf-without-tool' }];
          return count === 1
            ? [
                call(
                  'record',
                  { key: `level-${level}` },
                  { callId: 'source-effect' },
                ),
              ]
            : [message('leaf finished')];
        };
        const server = new ModelServer(
          Array.from({ length: 30 }, () => respond),
          [],
          async (item) => {
            if (mode === 'active' && item.id === 'held-leaf-without-tool') {
              active.resolve();
              await release.promise;
            }
          },
        );
        try {
          const nativeConfig = await server.config();
          const url = (
            nativeConfig['model_providers.fixture'] as { base_url: string }
          ).base_url;
          const common = {
            profile: join(home, 'profile'),
            effects: join(home, 'effects'),
            url,
            executor: {
              url: executor.url,
              cwd: executor.cwd,
              headers: executor.headers,
            },
            depth,
            // These destinations intentionally reopen without an Environment.
            ...(noChildren ? { writePolicy: 'legacy' } : {}),
          };
          const source = start({ ...common, mode });
          const opened = await source.wait('opened');
          const canonicalCompleted = async () => {
            const directChild = [...depths].find(
              ([, level]) => level === 1,
            )?.[0];
            expect(directChild).toBeTypeOf('string');
            const rollouts = (
              await readdir(common.profile, { recursive: true })
            ).filter((path) => path.endsWith(`${opened.id}.jsonl`));
            expect(rollouts).toHaveLength(1);
            const rows = (
              await readFile(join(common.profile, rollouts[0]!), 'utf8')
            )
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line));
            return rows.filter(
              (row) =>
                row.type === 'event_msg' &&
                row.payload?.type === 'item_completed' &&
                row.payload.item?.type === 'SubAgentActivity' &&
                row.payload.item.kind === 'completed' &&
                row.payload.item.agent_thread_id === directChild,
            );
          };
          if (mode === 'active')
            await Promise.race([
              active.promise,
              source.wait('failure').then((row) => {
                throw new Error(String(row.message));
              }),
            ]);
          else await source.wait('effect');
          expect((await source.wait('root-result')).output).toBe(
            'source parent finished',
          );
          if (mode === 'settled') {
            await source.wait('done');
            expect(await source.exited, source.stderr()).toBe(0);
            expect(await canonicalCompleted()).toHaveLength(1);
          } else {
            source.child.kill('SIGKILL');
            await source.exited;
            release.resolve();
          }
          const before = server.requests.length;
          const effects =
            mode === 'active' ? '' : await readFile(common.effects, 'utf8');
          const expectedEffect =
            mode === 'active' ? '' : `source:level-${depth}\n`;
          expect(effects).toBe(expectedEffect);
          for (
            let attempt = 0;
            attempt < (mode === 'settled' ? 1 : 2);
            attempt++
          ) {
            const destination = start({
              ...common,
              mode: 'destination',
              resume: opened.id,
              noChildren,
            });
            const code = await destination.exited;
            if (mode === 'settled') {
              expect(
                code,
                `${JSON.stringify(destination.rows)}\n${destination.stderr()}`,
              ).toBe(0);
              expect(
                destination.rows.find((row) => row.type === 'opened')?.pid,
              ).not.toBe(opened.pid);
              expect(
                destination.rows.find((row) => row.type === 'history')
                  ?.children,
              ).toHaveLength(depth);
              if (depth === 1 && noChildren) {
                expect(
                  destination.rows.find((row) => row.type === 'history')
                    ?.children,
                ).toEqual([
                  expect.objectContaining({
                    id: [...depths].find(([, level]) => level === 1)?.[0],
                    turns: [expect.any(String)],
                    completedText: expect.stringContaining('leaf finished'),
                  }),
                ]);
              }
              expect(await canonicalCompleted()).toHaveLength(1);
              expect(server.requests).toHaveLength(before + 2);
              expect(await readFile(common.effects, 'utf8')).toBe(
                expectedEffect + 'destination:fresh\n',
              );
              if (depth === 2 && noChildren) {
                const descendants = destination.rows.find(
                  (row) => row.type === 'history',
                )!.children as Array<{ id: string }>;
                for (const descendant of descendants) {
                  const childRoot = start({
                    ...common,
                    mode: 'destination',
                    resume: descendant.id,
                    noChildren: true,
                  });
                  expect(await childRoot.exited, childRoot.stderr()).not.toBe(
                    0,
                  );
                  expect(
                    childRoot.rows.some((row) => row.type === 'opened'),
                  ).toBe(false);
                  expect(
                    childRoot.rows.find((row) => row.type === 'failure')
                      ?.message,
                  ).toContain('root header identity');
                  expect(server.requests).toHaveLength(before + 2);
                  expect(await readFile(common.effects, 'utf8')).toBe(
                    expectedEffect + 'destination:fresh\n',
                  );
                }
              }
            } else {
              expect(code).not.toBe(0);
              expect(
                destination.rows.some((row) => row.type === 'opened'),
              ).toBe(false);
              expect(
                destination.rows.find((row) => row.type === 'failure')?.message,
              ).toMatch(
                mode === 'unknown'
                  ? /unknown tool (effects|outcome)/
                  : /active descendant/,
              );
              expect(server.requests).toHaveLength(before);
              if (mode === 'unknown')
                expect(await readFile(common.effects, 'utf8')).toBe(effects);
              else
                await expect(
                  readFile(common.effects, 'utf8'),
                ).rejects.toMatchObject({ code: 'ENOENT' });
            }
          }
        } finally {
          release.resolve();
          for (const child of workers) {
            if (child.exitCode === null && child.signalCode === null) {
              const exited = new Promise((resolve) =>
                child.once('exit', resolve),
              );
              child.kill('SIGKILL');
              await exited;
            }
          }
          await executor.close();
          await rm(home, { recursive: true, force: true });
        }
      }, 90_000);
    }
  }
}
