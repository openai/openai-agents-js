import { fork, type ChildProcess } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { afterEach, expect, it, onTestFinished } from 'vitest';
import type { ReconciledCall } from '../../src';
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

async function findRollout(directory: string, id: string) {
  const paths = (await readdir(directory, { recursive: true })).filter((path) =>
    path.endsWith(`${id}.jsonl`),
  );
  expect(paths).toHaveLength(1);
  return paths[0]!;
}

async function readRollout(profile: string, id: string) {
  return parseRollout(
    await readFile(join(profile, await findRollout(profile, id)), 'utf8'),
  );
}

function parseRollout(contents: string) {
  return contents
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

async function aliasRollout(
  profile: string,
  id: string,
  directory: string,
  format: 'plain' | 'compressed' | 'materialized',
) {
  const original = await findRollout(profile, id);
  const plain = join(profile, original);
  const suffix = format === 'plain' ? '' : '.zst';
  const alias = plain + suffix;
  const plainTarget = join(directory, basename(original));
  const target = plainTarget + suffix;
  await mkdir(directory);
  if (format !== 'plain') {
    const audit = await readFile(plain);
    await writeFile(target, zstdCompressSync(audit));
    if (format === 'materialized') {
      await writeFile(plainTarget, audit);
    }
    await rm(plain);
  } else {
    await rename(plain, target);
  }
  await symlink(target, alias, 'file');
  return { alias, target, plainTarget };
}

it.each(['plain', 'compressed'] as const)(
  'persists a root receipt at the original owner selected through a rollout alias (%s)',
  recoverAliasedRoot,
  90_000,
);

async function recoverAliasedRoot(format: 'plain' | 'compressed') {
  const home = await mkdtemp(join(tmpdir(), 'native-relocated-rollout-'));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const server = new ModelServer([
    [call('record', { key: 'root' }, { callId: 'relocated-root-effect' })],
  ]);
  const nativeConfig = await server.config();
  const profile = join(home, 'profile');
  const effects = join(home, 'effects');
  const common = {
    profile,
    effects,
    url: (nativeConfig['model_providers.fixture'] as { base_url: string })
      .base_url,
    depth: 0,
    noChildren: true,
  };
  const source = start({ ...common, mode: 'unknown' });
  const rootId: string = (await source.wait('opened')).id;
  expect((await source.wait('effect')).key).toBe('root');
  source.child.kill('SIGKILL');
  await source.exited;

  const before = await readRollout(profile, rootId);
  const relocatedDirectory = join(home, 'relocated');
  const { alias, target } = await aliasRollout(
    profile,
    rootId,
    relocatedDirectory,
    format,
  );

  const turnId = before.findLast(
    (row) => row.type === 'event_msg' && row.payload.type === 'task_started',
  )?.payload.turn_id;
  expect(turnId).toBeTypeOf('string');
  const receipt: ReconciledCall = {
    threadId: rootId,
    turnId,
    callId: 'relocated-root-effect',
    outcome: 'applied',
    result: 'root effect confirmed',
  };
  const reopen = {
    ...common,
    mode: 'destination',
    resume: rootId,
    inspectOnly: true,
  };
  const recovered = start({ ...reopen, reconciledCalls: [receipt] });
  expect(await recovered.exited, recovered.rows[0]?.message).toBe(0);
  expect((await recovered.wait('opened')).id).toBe(rootId);

  const after = await readRollout(relocatedDirectory, rootId);
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.slice(before.length)).toContainEqual(
    expect.objectContaining({
      type: 'response_item',
      payload: expect.objectContaining({
        type: 'function_call_output',
        call_id: receipt.callId,
        output: receipt.result,
      }),
    }),
  );
  expect(await readlink(alias)).toBe(target);
  const settled = start(reopen);
  expect(await settled.exited, settled.rows[0]?.message).toBe(0);
  expect((await settled.wait('opened')).id).toBe(rootId);
  const settledHistory = await readRollout(relocatedDirectory, rootId);
  expect(settledHistory.slice(0, after.length)).toEqual(after);
  expect(settledHistory.slice(after.length)).not.toContainEqual(
    expect.objectContaining({
      type: 'response_item',
      payload: expect.objectContaining({
        type: 'function_call_output',
        call_id: receipt.callId,
      }),
    }),
  );
  expect(await readFile(effects, 'utf8')).toBe('source:root\n');
  server.assertExhausted();
}

it.each(['plain', 'compressed', 'materialized'] as const)(
  'recovers a later child after a root receipt on the same session (%s rollout)',
  recoverLaterChild,
  90_000,
);

async function recoverLaterChild(
  format: 'plain' | 'compressed' | 'materialized',
) {
  const home = await mkdtemp(join(tmpdir(), 'native-local-descendants-'));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const executor = await startPublicExecutor();
  onTestFinished(() => executor.close());
  const rootCall = call('record', { key: 'root' }, { callId: 'root-effect' });
  const childCall = call(
    'record',
    { key: 'child' },
    { callId: 'child-effect' },
  );
  const spawnCall = call(
    'spawn_agent',
    { task_name: 'alpha', message: 'Record child work.', fork_turns: 'none' },
    { namespace: 'collaboration', callId: 'spawn-after-root-receipt' },
  );
  let childId: string | undefined;
  const afterSpawn = (request: JsonObject) => {
    const metadata = request.client_metadata as JsonObject;
    const { thread_id: id } = JSON.parse(
      metadata['x-codex-turn-metadata'] as string,
    );
    if (id === rootId) return [message('Root spawned the child.')];
    expect(id).toBeTypeOf('string');
    childId = id;
    return [childCall];
  };
  const server = new ModelServer([
    [rootCall],
    [spawnCall],
    afterSpawn,
    afterSpawn,
  ]);
  const nativeConfig = await server.config();
  const profile = join(home, 'profile');
  const effects = join(home, 'effects');
  const common = {
    profile,
    effects,
    url: (nativeConfig['model_providers.fixture'] as { base_url: string })
      .base_url,
    executor: {
      url: executor.url,
      cwd: executor.cwd,
      headers: executor.headers,
    },
  };
  const first = start({ ...common, depth: 0, mode: 'unknown' });
  const rootId: string = (await first.wait('opened')).id;
  expect((await first.wait('effect')).key).toBe('root');
  first.child.kill('SIGKILL');
  await first.exited;

  const rootAudit = await readRollout(profile, rootId);
  const rootTurn = rootAudit.findLast(
    (row) => row.type === 'event_msg' && row.payload.type === 'task_started',
  )?.payload.turn_id;
  expect(rootTurn).toBeTypeOf('string');
  const rootReceipt: ReconciledCall = {
    threadId: rootId,
    turnId: rootTurn,
    callId: 'root-effect',
    outcome: 'applied',
    result: 'root effect confirmed',
  };
  const later = start({
    ...common,
    depth: 1,
    mode: 'unknown',
    resume: rootId,
    reconciledCalls: [rootReceipt],
  });
  expect((await later.wait('opened')).id).toBe(rootId);
  expect((await later.wait('effect')).key).toBe('child');
  expect((await later.wait('root-result')).output).toBe(
    'Root spawned the child.',
  );
  later.child.kill('SIGKILL');
  await later.exited;

  expect(server.requests[1]?.input).toContainEqual(
    expect.objectContaining({
      type: 'function_call_output',
      call_id: rootReceipt.callId,
      output: rootReceipt.result,
    }),
  );
  expect(childId).toBeTypeOf('string');
  const childAudit = await readRollout(profile, childId!);
  const childAlias =
    format === 'plain'
      ? undefined
      : await aliasRollout(profile, childId!, join(home, 'relocated'), format);
  const shadow =
    format === 'materialized' && childAlias
      ? await readFile(childAlias.alias)
      : undefined;
  const childTurn = childAudit.findLast(
    (row) => row.type === 'event_msg' && row.payload.type === 'task_started',
  )?.payload.turn_id;
  expect(childTurn).toBeTypeOf('string');
  const resume = (reconciledCalls?: ReconciledCall[]) =>
    start({
      ...common,
      mode: 'destination',
      resume: rootId,
      inspectOnly: true,
      ...(reconciledCalls ? { reconciledCalls } : {}),
    });
  const probe = resume();
  expect(await probe.exited).toBe(1);
  const hold = await probe.wait('failure');
  expect(hold.calls, hold.message).toEqual([
    {
      threadId: childId,
      turnId: childTurn,
      callId: childCall.call_id,
      name: childCall.name,
      namespace: null,
      arguments: childCall.arguments,
    },
  ]);
  const childReceipt: ReconciledCall = {
    threadId: childId!,
    turnId: childTurn,
    callId: 'child-effect',
    outcome: 'applied',
    result: 'child effect confirmed',
  };
  const recovered = resume([childReceipt]);
  expect(
    await recovered.exited,
    `${JSON.stringify(recovered.rows)}\n${recovered.stderr()}`,
  ).toBe(0);
  expect((await recovered.wait('opened')).id).toBe(rootId);
  const recoveredChildren = (await recovered.wait('history')).children;
  expect(recoveredChildren).toEqual([
    expect.objectContaining({
      id: childId,
      turns: [childTurn],
      reconciled: [
        expect.objectContaining({
          callId: childCall.call_id,
          turnId: childTurn,
          reconciliation: 'applied',
          output: 'child effect confirmed',
        }),
      ],
    }),
  ]);
  const rootAfter = await readRollout(profile, rootId);
  expect(rootAfter.slice(0, rootAudit.length)).toEqual(rootAudit);
  expect(
    rootAfter.filter(
      (row) =>
        row.type === 'event_msg' &&
        row.payload.type === 'turn_aborted' &&
        row.payload.turn_id === rootTurn,
    ),
  ).toHaveLength(0);
  if (childAlias) {
    expect(await readlink(childAlias.alias)).toBe(childAlias.target);
    const published = await readFile(childAlias.alias);
    if (shadow) expect(published).toEqual(shadow);
    const audit =
      format === 'materialized'
        ? await readFile(childAlias.plainTarget)
        : zstdDecompressSync(published);
    const decoded = parseRollout(audit.toString('utf8'));
    expect(decoded.slice(0, childAudit.length)).toEqual(childAudit);
    expect(
      decoded.filter(
        (row) =>
          row.type === 'response_item' &&
          row.payload.type === 'function_call_output' &&
          row.payload.call_id === childReceipt.callId,
      ),
    ).toHaveLength(1);
    for (const receipts of [[childReceipt], undefined]) {
      const retry = resume(receipts);
      expect(await retry.exited, retry.rows[0]?.message).toBe(0);
      expect((await retry.wait('opened')).id).toBe(rootId);
      expect((await retry.wait('history')).children).toEqual(recoveredChildren);
      expect(await readFile(childAlias.alias)).toEqual(published);
      if (format === 'materialized') {
        expect(await readFile(childAlias.plainTarget)).toEqual(audit);
      }
    }
  } else {
    expect(
      (await readRollout(profile, childId!)).slice(0, childAudit.length),
    ).toEqual(childAudit);
  }
  expect(await readFile(effects, 'utf8')).toBe('source:root\nsource:child\n');
  server.assertExhausted();
}

async function recoverCopiedLegacyCalls(
  profile: string,
  common: JsonObject,
  ids: [root: string, child: string, leaf: string],
) {
  const paths = await Promise.all(
    ids.map(async (id) => join(profile, await findRollout(profile, id))),
  );
  const readAudits = () =>
    Promise.all(paths.map((path) => readFile(path, 'utf8')));
  const [rootAudit, childAudit, leafAudit] = (await readAudits()).map(
    parseRollout,
  );
  const ownRows = (audit: ReturnType<typeof parseRollout>) =>
    audit
      .slice(1)
      .filter(
        (row) => row.ordinal >= audit[0].payload.subagent_history_start_ordinal,
      );
  const legacyHeader = (audit: ReturnType<typeof parseRollout>) => {
    const header = structuredClone(audit[0]);
    header.payload.history_mode = 'legacy';
    delete header.payload.history_base;
    delete header.payload.subagent_history_start_ordinal;
    delete header.payload.forked_from_ordinal_exclusive;
    return header;
  };
  const turnStart = (row: (typeof rootAudit)[number]) =>
    row.type === 'event_msg' && row.payload.type === 'task_started';
  const [rootStart, leafStart] = [rootAudit, ownRows(leafAudit)].map((audit) =>
    audit.find(turnStart),
  );
  const spawnIndex = rootAudit.findIndex(
    (row) =>
      row.type === 'response_item' &&
      row.payload.type === 'function_call' &&
      row.payload.call_id === 'spawn-0',
  );
  const context = rootAudit
    .slice(0, spawnIndex)
    .findLast(
      (row) =>
        row.type === 'turn_context' &&
        row.payload.turn_id === rootStart.payload.turn_id,
    );
  const callId = 'source-effect';
  const leafCall = ownRows(leafAudit).find(
    (row) =>
      row.type === 'response_item' &&
      row.payload.type === 'function_call' &&
      row.payload.call_id === callId,
  );
  expect(leafCall.payload.arguments).toBe('{"key":"level-2"}');
  const rootCall = structuredClone(leafCall);
  rootCall.timestamp = context.timestamp;
  rootCall.payload.arguments = '{"key":"root"}';
  const metadata = rootCall.payload.internal_chat_message_metadata_passthrough;
  if (metadata?.turn_id !== undefined) {
    metadata.turn_id = rootStart.payload.turn_id;
  }

  // Model a persisted Legacy fork that copied a pending root call, keeping
  // the real spawn edges and original owner turns from the crash fixture.
  const contextIndex = rootAudit.indexOf(context);
  const fixtures = [
    [
      legacyHeader(rootAudit),
      ...rootAudit.slice(1, contextIndex + 1),
      rootCall,
      ...rootAudit.slice(contextIndex + 1),
    ],
    [
      legacyHeader(childAudit),
      rootStart,
      context,
      rootCall,
      ...ownRows(childAudit),
    ],
    [legacyHeader(leafAudit), ...ownRows(leafAudit)],
  ].map(
    (audit) =>
      audit
        .map((row, ordinal) => JSON.stringify({ ...row, ordinal }))
        .join('\n') + '\n',
  );
  await Promise.all(
    paths.map((path, index) => writeFile(path, fixtures[index]!)),
  );

  const reopen = (reconciledCalls?: ReconciledCall[]) =>
    start({
      ...common,
      mode: 'destination',
      resume: ids[0],
      inspectOnly: true,
      ...(reconciledCalls && { reconciledCalls }),
    });
  const pending = [
    { threadId: ids[0], turnId: rootStart.payload.turn_id, call: rootCall },
    { threadId: ids[2], turnId: leafStart.payload.turn_id, call: leafCall },
  ];
  const hold = reopen();
  expect(await hold.exited).toBe(1);
  expect(hold.rows.find((row) => row.type === 'failure')?.calls).toEqual(
    pending.map(({ threadId, turnId, call: { payload } }) => ({
      threadId,
      turnId,
      callId,
      name: 'record',
      namespace: payload.namespace ?? null,
      arguments: payload.arguments,
    })),
  );
  expect(await readAudits()).toEqual(fixtures);

  const receipts: ReconciledCall[] = [
    {
      threadId: ids[0],
      turnId: rootStart.payload.turn_id,
      callId,
      outcome: 'not_applied',
      result: 'no root effect in the application record',
    },
    {
      threadId: ids[2],
      turnId: leafStart.payload.turn_id,
      callId,
      outcome: 'applied',
      result: 'confirmed grandchild effect from the application record',
    },
  ];
  for (const supplied of [receipts, receipts, undefined]) {
    const opened = reopen(supplied);
    expect(
      await opened.exited,
      `${JSON.stringify(opened.rows)}\n${opened.stderr()}`,
    ).toBe(0);
    expect(opened.rows.find((row) => row.type === 'opened')).toMatchObject({
      id: ids[0],
    });
    const audit = await readAudits();
    for (const [index, contents] of audit.entries()) {
      expect(contents.startsWith(fixtures[index]!)).toBe(true);
      const results = parseRollout(contents).filter(
        (row) =>
          row.type === 'response_item' &&
          row.payload.type === 'function_call_output' &&
          row.payload.call_id === callId,
      );
      const receipt = receipts.find(({ threadId }) => threadId === ids[index]);
      expect(results.map(({ payload }) => payload)).toEqual(
        receipt
          ? [
              expect.objectContaining({
                output: receipt.result,
                internal_chat_message_metadata_passthrough:
                  expect.objectContaining({
                    turn_id: receipt.turnId,
                    content_item_kinds: [
                      `sdk_reconciliation.${receipt.outcome}`,
                    ],
                  }),
              }),
            ]
          : [],
      );
    }
  }
}

for (const depth of [1, 2]) {
  for (const noChildren of [false, true]) {
    const cases = ['settled', 'unknown', 'active'] as const;
    const variants =
      depth === 2 && !noChildren
        ? ([...cases, 'copied Legacy'] as const)
        : cases;
    for (const variant of variants) {
      const mode = variant === 'copied Legacy' ? 'unknown' : variant;
      it(`cold ${depth}-level ${variant} history with destination children ${!noChildren}`, async () => {
        const home = await mkdtemp(join(tmpdir(), 'native-local-descendants-'));
        const executor = await startPublicExecutor();
        const depths = new Map<string, number>();
        const counts = new Map<string, number>();
        let root: string | undefined;
        const active = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const holdAncestors = mode === 'unknown' && depth === 2 && !noChildren;
        const ancestorFollowups = Array.from({ length: depth }, () =>
          Promise.withResolvers<void>(),
        );
        // Call IDs belong to the source thread. A new root call can reuse one.
        const freshCallId =
          mode === 'unknown' ? 'source-effect' : 'fresh-current';
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
            return input.some((item) => item.call_id === freshCallId)
              ? [message('destination finished')]
              : [
                  call(
                    'record_current',
                    { key: 'fresh' },
                    { callId: freshCallId },
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
                    fork_turns: holdAncestors ? 'all' : 'none',
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
            return [
              {
                ...message('source parent finished'),
                id: `source-parent-${level}`,
              },
            ];
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
            if (holdAncestors && typeof item.id === 'string') {
              const level = /^source-parent-(\d+)$/.exec(item.id)?.[1];
              if (level !== undefined) {
                ancestorFollowups[Number(level)]!.resolve();
                await release.promise;
              }
            }
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
            const rows = await readRollout(common.profile, opened.id);
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
          if (holdAncestors)
            await Promise.all(ancestorFollowups.map(({ promise }) => promise));
          else
            expect((await source.wait('root-result')).output).toBe(
              'source parent finished',
            );
          if (mode === 'unknown' && depth === 1 && noChildren) {
            const before = server.requests.length;
            const competing = start({
              ...common,
              mode: 'destination',
              resume: opened.id,
              noChildren,
              inspectOnly: true,
            });
            expect(await competing.exited).not.toBe(0);
            expect(
              competing.rows.find((row) => row.type === 'failure')?.message,
            ).toMatch(/active writer/);
            expect(server.requests).toHaveLength(before);
          }
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
          if (variant === 'copied Legacy') {
            const ids = [...depths.keys()];
            expect(ids).toHaveLength(3);
            await recoverCopiedLegacyCalls(common.profile, common, [
              opened.id,
              ids[1]!,
              ids[2]!,
            ]);
            expect(server.requests).toHaveLength(before);
            expect(await readFile(common.effects, 'utf8')).toBe(expectedEffect);
            expect(
              executor.requests.filter(
                ({ method }) => method === 'process/start',
              ),
            ).toEqual([]);
            return;
          }
          if (mode === 'active') {
            const leaf = [...depths].find(([, level]) => level === depth)![0];
            const originalLeaf = await readRollout(common.profile, leaf);
            const leafTurn = originalLeaf.findLast(
              (row) =>
                row.type === 'event_msg' && row.payload.type === 'task_started',
            )?.payload.turn_id;
            expect(leafTurn).toBeTypeOf('string');
            for (const inspectOnly of [true, true, false]) {
              const destination = start({
                ...common,
                mode: 'destination',
                resume: opened.id,
                noChildren,
                inspectOnly,
              });
              expect(
                await destination.exited,
                `${JSON.stringify(destination.rows)}\n${destination.stderr()}`,
              ).toBe(0);
              expect(
                destination.rows.find((row) => row.type === 'opened')?.id,
              ).toBe(opened.id);
              const children = destination.rows.find(
                (row) => row.type === 'history',
              )?.children as Array<{ id: string }>;
              expect(children.map(({ id }) => id).sort()).toEqual(
                [...depths.keys()].filter((id) => id !== opened.id).sort(),
              );
              const recovered = await readRollout(common.profile, leaf);
              expect(recovered.slice(0, originalLeaf.length)).toEqual(
                originalLeaf,
              );
              expect(
                recovered.filter(
                  (row) =>
                    row.type === 'event_msg' &&
                    row.payload.type === 'turn_aborted' &&
                    row.payload.turn_id === leafTurn &&
                    row.payload.reason === 'interrupted',
                ),
              ).toHaveLength(1);
              expect(server.requests).toHaveLength(
                before + (inspectOnly ? 0 : 2),
              );
              if (inspectOnly)
                await expect(
                  readFile(common.effects, 'utf8'),
                ).rejects.toMatchObject({ code: 'ENOENT' });
              else {
                expect(
                  destination.rows.find((row) => row.type === 'root-result')
                    ?.output,
                ).toBe('destination finished');
                expect(await readFile(common.effects, 'utf8')).toBe(
                  'destination:fresh\n',
                );
              }
            }
            return;
          }
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
              ).toMatch(/unknown tool (effects|outcome)/);
              expect(server.requests).toHaveLength(before);
              if (mode === 'unknown') {
                const hold = destination.rows.find(
                  (row) => row.type === 'failure',
                );
                const leaf = [...depths].find(
                  ([, level]) => level === depth,
                )![0];
                const audit = await readRollout(common.profile, leaf);
                const turnId = audit.findLast(
                  (row) =>
                    row.type === 'event_msg' &&
                    row.payload.type === 'task_started',
                )?.payload.turn_id;
                const invocation = audit.findLast(
                  (row) =>
                    row.type === 'response_item' &&
                    row.payload.type === 'function_call' &&
                    row.payload.call_id === 'source-effect',
                )?.payload;
                expect(turnId).toBeTypeOf('string');
                expect(invocation?.arguments).toBe(
                  JSON.stringify({ key: `level-${depth}` }),
                );
                expect(hold?.calls).toEqual([
                  {
                    threadId: leaf,
                    turnId,
                    callId: 'source-effect',
                    name: 'record',
                    namespace: invocation.namespace ?? null,
                    arguments: invocation.arguments,
                  },
                ]);
                expect(hold?.turns).toContainEqual({
                  id: turnId,
                  status: 'interrupted',
                  subagentId: leaf,
                });
                expect(await readFile(common.effects, 'utf8')).toBe(effects);
              }
            }
          }
          if (mode === 'unknown') {
            const leaf = [...depths].find(([, level]) => level === depth)![0];
            const beforeReceipt = await readRollout(common.profile, leaf);
            const ancestors = holdAncestors
              ? await Promise.all(
                  [...depths]
                    .filter(([, level]) => level < depth)
                    .map(async ([id]) => ({
                      id,
                      rows: await readRollout(common.profile, id),
                    })),
                )
              : [];
            const turn = beforeReceipt.findLast(
              (row) =>
                row.type === 'event_msg' && row.payload.type === 'task_started',
            );
            expect(turn?.payload.turn_id).toBeTypeOf('string');
            const receipt: ReconciledCall = {
              threadId: leaf,
              turnId: turn.payload.turn_id,
              callId: 'source-effect',
              outcome: 'applied',
              result: 'confirmed from the application record',
            };
            const wrongOwner = start({
              ...common,
              mode: 'destination',
              resume: opened.id,
              noChildren,
              reconciledCalls: [{ ...receipt, threadId: opened.id }],
            });
            expect(await wrongOwner.exited).not.toBe(0);
            expect(wrongOwner.rows.some((row) => row.type === 'opened')).toBe(
              false,
            );
            expect(await readRollout(common.profile, leaf)).toEqual(
              beforeReceipt,
            );
            for (const { id, rows } of ancestors)
              expect(await readRollout(common.profile, id)).toEqual(rows);
            expect(server.requests).toHaveLength(before);
            for (const inspectOnly of [true, false]) {
              const destination = start({
                ...common,
                mode: 'destination',
                resume: opened.id,
                noChildren,
                reconciledCalls: [receipt],
                inspectOnly,
              });
              expect(
                await destination.exited,
                `${JSON.stringify(destination.rows)}\n${destination.stderr()}`,
              ).toBe(0);
              expect(
                destination.rows.find((row) => row.type === 'opened'),
              ).toMatchObject({ id: opened.id });
              const children = destination.rows.find(
                (row) => row.type === 'history',
              )?.children;
              expect(children).toHaveLength(depth);
              expect(children).toContainEqual(
                expect.objectContaining({
                  id: leaf,
                  turns: expect.arrayContaining([receipt.turnId]),
                  reconciled: [
                    expect.objectContaining({
                      callId: receipt.callId,
                      turnId: receipt.turnId,
                      reconciliation: 'applied',
                      output: receipt.result,
                    }),
                  ],
                }),
              );
              const afterReceipt = await readRollout(common.profile, leaf);
              expect(afterReceipt.slice(0, beforeReceipt.length)).toEqual(
                beforeReceipt,
              );
              for (const { id, rows } of ancestors) {
                const originalTurn = rows.findLast(
                  (row) =>
                    row.type === 'event_msg' &&
                    row.payload.type === 'task_started',
                )?.payload.turn_id;
                expect(originalTurn).toBeTypeOf('string');
                const after = await readRollout(common.profile, id);
                expect(after.slice(0, rows.length)).toEqual(rows);
                expect(
                  after.filter(
                    (row) =>
                      row.type === 'event_msg' &&
                      row.payload.type === 'turn_aborted' &&
                      row.payload.turn_id === originalTurn &&
                      row.payload.reason === 'interrupted',
                  ),
                ).toHaveLength(1);
              }
              expect(server.requests).toHaveLength(
                before + (inspectOnly ? 0 : 2),
              );
              expect(await readFile(common.effects, 'utf8')).toBe(
                expectedEffect + (inspectOnly ? '' : 'destination:fresh\n'),
              );
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
