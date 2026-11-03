import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

const fixture = fileURLToPath(
  new URL('./fixtures/static-selection-process.mjs', import.meta.url),
);
const cell = (input: string, callId: string): JsonObject => ({
  type: 'custom_tool_call',
  name: 'exec',
  call_id: callId,
  input,
});
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

function names(request: JsonObject) {
  const result: string[] = [];
  const add = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (entry.type === 'namespace') add(entry.tools);
      else if (entry.type === 'function' || entry.type === 'custom')
        result.push(entry.name);
    }
  };
  add(request.tools);
  if (Array.isArray(request.input))
    for (const item of request.input as JsonObject[])
      if (item.type === 'additional_tools') add(item.tools);
  return result.sort();
}

function launch(config: object) {
  const child = spawn(process.execPath, [fixture, JSON.stringify(config)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on('data', (data: Buffer) => {
    output += data.toString();
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 40_000);
  const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    output: string;
  }>((resolve, reject) => {
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
  });
  void done.catch(() => {});
  return {
    child,
    done,
    async close() {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      try {
        await done;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'static selection fresh-process recovery',
  () => {
    it('restores checked native output, settled VM values and a typed manual subset across processes', async () => {
      const directory = await mkdtemp(
        join(tmpdir(), 'agents-static-selection-'),
      );
      const children: ReturnType<typeof launch>[] = [];
      let executor: Awaited<ReturnType<typeof startPublicExecutor>> | undefined;
      // Encode only the synthetic output marker so its raw bytes cannot appear in saved code.
      const encoded = Buffer.from('raw-native').toString('base64');
      const command = `printf effect >> effect.txt; printf '%s' '${encoded}' | base64 -d`;
      const model = new ModelServer([
        [
          cell(
            `store('accepted',await tools.exec_command(${JSON.stringify({ cmd: command })})); store('structured',{n:7,a:[null,true,'雪']}); text('seed-cell-settled');`,
            'seed-cell',
          ),
        ],
        [message('{"answer":"seeded"}')],
        [
          call('lookup', { key: 'A' }, { callId: 'manual-A' }),
          call('lookup', { key: 'B' }, { callId: 'manual-B' }),
        ],
        [
          cell(
            "const value=load('structured'); const accepted=load('accepted'); if(Object.keys(value).sort().join(',')!=='a,n' || value.n!==7 || JSON.stringify(value.a)!==JSON.stringify([null,true,'雪']) || JSON.stringify(accepted)!==JSON.stringify({output:'checked-native-text'})) throw new Error('Stored values changed'); text(JSON.stringify([accepted,value]));",
            'read-stored',
          ),
        ],
        [
          call(
            'exec_command',
            { cmd: 'printf forbidden >> forbidden.txt' },
            { callId: 'excluded-attempt' },
          ),
        ],
        [message('{"answer":"done"}')],
      ]);
      const failures: unknown[] = [];
      try {
        executor = await startPublicExecutor();
        const config = await model.config();
        const modelUrl = (
          config['model_providers.fixture'] as { base_url: string }
        ).base_url;
        const run = (mode: string) => {
          const worker = launch({
            directory,
            modelUrl,
            mode,
            executor: {
              url: executor!.url,
              cwd: executor!.cwd,
              headers: executor!.headers,
            },
          });
          children.push(worker);
          return worker;
        };
        const source = run('prepare');
        const prepared = await source.done;
        expect(prepared, prepared.output).toMatchObject({
          code: 0,
          signal: null,
        });
        const originalBytes = await readFile(
          join(directory, 'original.json'),
          'utf8',
        );
        const original = JSON.parse(originalBytes);
        const saved = JSON.parse(original.checkpoint);
        expect(original.pid).toBe(source.child.pid);
        expect(original.transforms).toBe(1);
        expect(original.nativeTransforms).toBe(1);
        expect(originalBytes).toContain('checked-native-text');
        expect(originalBytes).not.toContain('raw-native');
        expect(saved.kind).toBe('manual');
        expect(saved.operation_tools).toEqual([
          { name: 'lookup', namespace: 'functions' },
          { name: 'exec', namespace: 'functions' },
          { name: 'wait', namespace: 'functions' },
        ]);
        expect(saved.manual_continuation.turn_id).toBe(original.turnId);
        expect(saved.manual_continuation.reply_order).toEqual([
          'manual-A',
          'manual-B',
        ]);
        expect(
          saved.manual_continuation.pending_manual.map(
            (item: { call_id: string }) => item.call_id,
          ),
        ).toEqual(['manual-B']);
        expect(Object.keys(saved.manual_continuation.accepted_replies)).toEqual(
          ['manual-A'],
        );
        expect(model.requests).toHaveLength(3);
        expect(await readFile(join(executor.cwd, 'effect.txt'), 'utf8')).toBe(
          'effect',
        );

        // Source has exited naturally before the destination is even spawned.
        const destination = run('recover');
        const completed = await destination.done;
        expect(completed, completed.output).toMatchObject({
          code: 0,
          signal: null,
        });
        const recovered = await json(join(directory, 'recovered.json'));
        expect(recovered.pid).toBe(destination.child.pid);
        expect(recovered.pid).not.toBe(original.pid);
        expect(recovered.sessionId).not.toBe(original.sessionId);
        expect(recovered.fresh).toMatchObject({
          sessionId: recovered.sessionId,
          turnId: original.turnId,
          callId: 'manual-B',
        });
        expect(recovered.fresh.submissionId).not.toBe(original.submissionId);
        expect(recovered.transforms).toBe(1);
        expect(recovered.nativeTransforms).toBe(0);
        expect(recovered.finalOutput).toEqual({ answer: 'done' });
        expect(recovered.state.native.root_code_mode.stored_values).toEqual(
          saved.native.root_code_mode.stored_values,
        );
        expect(
          BigInt(recovered.state.native.root_code_mode.next_cell_id),
        ).toBeGreaterThan(BigInt(saved.native.root_code_mode.next_cell_id));
        expect(await readFile(join(executor.cwd, 'effect.txt'), 'utf8')).toBe(
          'effect',
        );
        await expect(
          readFile(join(executor.cwd, 'forbidden.txt')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        expect(
          executor.requests.filter(
            (request) => request.method === 'process/start',
          ),
        ).toHaveLength(1);
        expect(
          JSON.stringify({ recovered, requests: model.requests }),
        ).not.toContain('raw-native');
        expect(await readFile(join(directory, 'original.json'), 'utf8')).toBe(
          originalBytes,
        );

        const format = (model.requests[0].text as JsonObject).format;
        expect(format).toMatchObject({ type: 'json_schema', strict: true });
        for (const request of model.requests)
          expect((request.text as JsonObject).format).toEqual(format);
        for (const request of model.requests.slice(2))
          expect(names(request)).toEqual(['exec', 'lookup', 'wait']);
        for (const headers of model.requestHeaders.slice(3))
          expect(headers.authorization).toBe(
            'Bearer synthetic-static-selection-recover',
          );
        const input = model.requests[5].input as JsonObject[];
        const refused = input.filter(
          (item) =>
            item.type === 'function_call_output' &&
            item.call_id === 'excluded-attempt',
        );
        expect(refused).toHaveLength(1);
        expect(JSON.stringify(refused[0].output)).toContain(
          'unsupported call:',
        );
        expect(JSON.stringify(refused[0].output)).toContain('exec_command');
        const pairs = [
          ['custom_tool_call', 'seed-cell'],
          ['custom_tool_call_output', 'seed-cell'],
          ['function_call', 'manual-A'],
          ['function_call', 'manual-B'],
          ['function_call_output', 'manual-A'],
          ['function_call_output', 'manual-B'],
          ['custom_tool_call', 'read-stored'],
          ['custom_tool_call_output', 'read-stored'],
          ['function_call', 'excluded-attempt'],
          ['function_call_output', 'excluded-attempt'],
        ];
        const indices = pairs.map(([type, id]) => {
          const matches = input.flatMap((item, index) =>
            item.type === type && item.call_id === id ? [index] : [],
          );
          expect(matches).toHaveLength(1);
          return matches[0];
        });
        expect(indices).toEqual([...indices].sort((a, b) => a - b));
        for (const [id, output] of [
          ['manual-A', '10'],
          ['manual-B', '20'],
        ])
          expect(
            input.find(
              (item) =>
                item.type === 'function_call_output' && item.call_id === id,
            )?.output,
          ).toBe(output);
        const stored = JSON.stringify(
          input.find(
            (item) =>
              item.type === 'custom_tool_call_output' &&
              item.call_id === 'read-stored',
          ),
        );
        expect(stored).toContain('checked-native-text');
        expect(stored).toContain('雪');
        model.assertExhausted();
      } catch (error) {
        failures.push(error);
      } finally {
        // Join both processes before closing their server or removing application files.
        const joined = await Promise.allSettled(
          children.map((child) => child.close()),
        );
        for (const result of joined)
          if (result.status === 'rejected') failures.push(result.reason);
        const cleanup = await Promise.allSettled([
          ModelServer.closeAll(),
          executor?.close(),
          rm(directory, { recursive: true, force: true }),
        ]);
        for (const result of cleanup)
          if (result.status === 'rejected') failures.push(result.reason);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, 'Process recovery harness failed');
    }, 100_000);
  },
);
