import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

it('reuses selected executor workspace files across turns and a fresh host with current grants', async () => {
  const executor = await startPublicExecutor();
  const controller = await mkdtemp(
    join(tmpdir(), 'agents-workspace-controller-'),
  );
  try {
    const selected = {
      'scripts/report.sh': `set -eu
input=$(cat "$2")
memory=$(cat "$3")
expected=$(printf 'report:%s:%s' "$input" "$memory")
case "$1" in
  produce)
    printf '%s\\n' "$expected" > "$4"
    printf 'written\\n' >> "$4.runs"
    cat "$4"
    ;;
  consume)
    test "$(cat "$4")" = "$expected"
    printf 'reuse:'
    cat "$4"
    ;;
  *) exit 64 ;;
esac
`,
      'inputs/request.txt': 'SELECTED_INPUT_CORAL',
      'memory/notes.txt': 'SELECTED_MEMORY_JADE',
    };
    // Provisioned by the application before any Session; never model-generated.
    for (const [path, body] of Object.entries(selected)) {
      await mkdir(join(executor.cwd, path, '..'), { recursive: true });
      await writeFile(join(executor.cwd, path), body);
    }
    await mkdir(join(executor.cwd, 'outputs'));
    const report = 'report:SELECTED_INPUT_CORAL:SELECTED_MEMORY_JADE\n';
    const output = join(executor.cwd, 'outputs/report.txt');
    const ledger = output + '.runs';
    const produce =
      '/bin/sh scripts/report.sh produce inputs/request.txt memory/notes.txt outputs/report.txt';
    const consume =
      '/bin/sh scripts/report.sh consume inputs/request.txt memory/notes.txt outputs/report.txt';
    const starts = () =>
      executor.requests.filter((r) => r.method === 'process/start');
    const checkedOutput = (
      request: Record<string, unknown>,
      id: string,
      text: string,
    ) => {
      expect(Array.isArray(request.input)).toBe(true);
      const outputs = (request.input as Array<Record<string, unknown>>).filter(
        (item) => item.type === 'function_call_output' && item.call_id === id,
      );
      expect(outputs).toHaveLength(1);
      expect(JSON.stringify(outputs[0])).toContain(
        text.replaceAll('\n', '\\n'),
      );
    };
    let startsBeforeRestartRead: number | undefined;
    const server = new ModelServer([
      [call('exec_command', { cmd: produce }, { callId: 'produce' })],
      [message('produced')],
      [call('exec_command', { cmd: consume }, { callId: 'reuse' })],
      [message('reused')],
      [
        call(
          'exec_command',
          { cmd: produce },
          { callId: 'denied-former-write' },
        ),
      ],
      () => {
        startsBeforeRestartRead = starts().length;
        return [
          call('exec_command', { cmd: consume }, { callId: 'restart-reuse' }),
        ];
      },
      [message('reused after restart')],
    ]);
    const config = await server.config();
    const options = {
      url: executor.url,
      cwd: executor.cwd,
      headers: executor.headers,
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      checkpoint: join(controller, 'conversation.json'),
      produce,
      consume,
    };
    const run = async (phase: string) => {
      const result = await promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(
            new URL('./fixtures/workspace-reuse-process.mjs', import.meta.url),
          ),
          phase,
          JSON.stringify(options),
        ],
        { cwd: controller, env: process.env, timeout: 30_000 },
      );
      return JSON.parse(result.stdout.trim()) as {
        pid: number;
        decisions: Array<{ args: { cmd: string }; allowed: boolean }>;
      };
    };
    const initial = await run('initial');
    // A failed assertion must not become a provider 500 retry that consumes
    // another prescribed tool call. Inspect actual results outside handlers.
    expect(server.requests).toHaveLength(4);
    checkedOutput(server.requests[1]!, 'produce', report);
    checkedOutput(server.requests[3]!, 'reuse', 'reuse:' + report);
    expect(await readFile(output, 'utf8')).toBe(report);
    expect(starts()).toHaveLength(2);
    expect(initial.decisions).toEqual([
      { args: { cmd: produce }, allowed: true },
      { args: { cmd: consume }, allowed: true },
    ]);
    // The application retains the executor/workspace after the first host exits.
    // Conversation state does not provision these files or recreate permissions.
    for (const [path, body] of Object.entries(selected))
      expect(await readFile(join(executor.cwd, path), 'utf8')).toBe(body);
    const restarted = await run('restarted');
    expect(server.requests).toHaveLength(7);
    checkedOutput(server.requests[6]!, 'restart-reuse', 'reuse:' + report);
    expect(startsBeforeRestartRead).toBe(2);
    expect(new Set([process.pid, initial.pid, restarted.pid]).size).toBe(3);
    expect(restarted.decisions).toEqual([
      { args: { cmd: produce }, allowed: false },
      { args: { cmd: consume }, allowed: true },
    ]);
    expect(starts()).toHaveLength(3);
    expect(JSON.stringify(starts())).toContain('scripts/report.sh');
    expect(await readFile(output, 'utf8')).toBe(report);
    expect(await readFile(ledger, 'utf8')).toBe('written\n');
    await expect(
      access(join(controller, 'scripts/report.sh')),
    ).rejects.toThrow();
    await expect(
      access(join(controller, 'outputs/report.txt')),
    ).rejects.toThrow();
    server.assertExhausted();
  } finally {
    try {
      await executor.close();
    } finally {
      await rm(controller, { recursive: true, force: true });
    }
  }
}, 90_000);
