import process from 'node:process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Interface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Runner, type ShellAction } from '@openai/agents';
import { ScriptedModel, assistantMessage } from '@openai/agents/testing';
import { createShellAgent } from './local-shell';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  interfaces: [] as Interface[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return {
    ...actual,
    exec: Object.assign(vi.fn(), { [promisify.custom]: mocks.exec }),
  };
});

vi.mock('node:readline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:readline')>();
  return {
    ...actual,
    createInterface: (
      options: Parameters<typeof actual.createInterface>[0],
    ) => {
      // Exercise real line/EOF handling without terminal escape sequences from
      // readline itself or access to the operator's actual terminal.
      const rl = actual.createInterface({ ...options, terminal: false });
      mocks.interfaces.push(rl);
      return rl;
    },
  };
});

describe('interactive host shell example', () => {
  let input: PassThrough & { isTTY: boolean };
  let output: PassThrough & { isTTY: boolean };
  let answers: Array<string | 'eof' | 'interrupt'>;
  let questions: number;
  let endStdin: ReturnType<typeof vi.fn>;
  let display: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    input = Object.assign(new PassThrough(), { isTTY: true });
    output = Object.assign(new PassThrough(), { isTTY: true });
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(
      input as unknown as typeof process.stdin,
    );
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(
      output as unknown as typeof process.stdout,
    );
    vi.stubEnv('EXAMPLES_INTERACTIVE_MODE', 'prompt');
    vi.stubEnv('SHELL_AUTO_APPROVE', '1');
    vi.stubEnv('AUTO_APPROVE_HITL', '1');
    display = vi.spyOn(console, 'log').mockImplementation(() => {});
    questions = 0;
    answers = ['yes'];
    output.on('data', (data: Buffer) => {
      if (!data.toString().includes('Proceed?')) return;
      questions++;
      queueMicrotask(() => {
        const answer = answers.shift();
        if (answer === 'eof' || answer === undefined) input.end();
        else if (answer === 'interrupt')
          mocks.interfaces.at(-1)!.emit('SIGINT');
        else input.write(`${answer}\n`);
      });
    });
    endStdin = vi.fn();
    mocks.exec.mockReset().mockImplementation(() =>
      Object.assign(
        Promise.resolve({ stdout: 'approved output', stderr: '' }),
        {
          child: { stdin: { end: endStdin } },
        },
      ),
    );
    mocks.interfaces.length = 0;
  });

  afterEach(() => {
    for (const rl of mocks.interfaces) {
      expect(rl.listenerCount('close')).toBe(0);
      expect(rl.listenerCount('SIGINT')).toBe(0);
      rl.close();
    }
    expect(input.listenerCount('data')).toBe(0);
    input.destroy();
    output.destroy();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function runBatches(
    actions: ShellAction[] = [{ commands: ['printf first'] }],
  ) {
    const model = new ScriptedModel([
      ...actions.map((action, index) => [
        {
          type: 'shell_call' as const,
          callId: `shell-${index}`,
          status: 'completed' as const,
          action,
        },
      ]),
      [assistantMessage('Done')],
    ]);
    const agent = createShellAgent().clone({ model });
    const result = await new Runner({ tracingDisabled: true }).run(
      agent,
      'Run the requested commands',
    );
    expect(result.finalOutput).toBe('Done');
    expect(result.interruptions).toHaveLength(0);
    model.assertComplete();
    return result;
  }

  it.each(['y', 'yes', ' YES '])(
    'runs an explicitly approved batch for %j',
    async (answer) => {
      answers = [answer];
      const result = await runBatches([
        {
          commands: ['printf first', 'printf second'],
          timeoutMs: 50,
          maxOutputLength: 256,
        },
      ]);
      expect(questions).toBe(1);
      expect(mocks.exec.mock.calls.map(([command]) => command)).toEqual([
        'printf first',
        'printf second',
      ]);
      expect(mocks.exec.mock.calls[0][1]).toMatchObject({
        cwd: process.cwd(),
        timeout: 50,
        maxBuffer: 256,
      });
      expect(endStdin).toHaveBeenCalledTimes(2);
      const shellOutput = result.newItems.find(
        (item) => item.rawItem.type === 'shell_call_output',
      )?.rawItem;
      expect(shellOutput).toMatchObject({
        output: [
          {
            stdout: 'approved output',
            stderr: '',
            outcome: { type: 'exit', exitCode: 0 },
          },
          {
            stdout: 'approved output',
            stderr: '',
            outcome: { type: 'exit', exitCode: 0 },
          },
        ],
      });
    },
  );

  it.each(['no', '', 'eof', 'interrupt'])(
    'denies %j despite legacy autoapproval settings',
    async (answer) => {
      answers = [answer];
      await runBatches();
      expect(questions).toBe(1);
      expect(mocks.exec).not.toHaveBeenCalled();
    },
  );

  it.each(['stdin', 'stdout', 'auto', 'already-ended', 'empty-batch'])(
    'denies %s without prompting',
    async (mode) => {
      if (mode === 'stdin') input.isTTY = false;
      if (mode === 'stdout') output.isTTY = false;
      if (mode === 'auto') vi.stubEnv('EXAMPLES_INTERACTIVE_MODE', 'AUTO');
      if (mode === 'already-ended') input.destroy();
      await runBatches([
        { commands: mode === 'empty-batch' ? [] : ['printf first'] },
      ]);
      expect(questions).toBe(0);
      expect(mocks.exec).not.toHaveBeenCalled();
    },
  );

  it('denies input that has already reached EOF', async () => {
    input.resume();
    input.end();
    await once(input, 'end');
    await runBatches();
    expect(questions).toBe(0);
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it('requires a fresh decision for the next batch', async () => {
    answers = ['yes', 'no'];
    await runBatches([
      { commands: ['printf first'] },
      { commands: ['printf second'] },
    ]);
    expect(questions).toBe(2);
    expect(mocks.exec.mock.calls.map(([command]) => command)).toEqual([
      'printf first',
    ]);
  });

  it('displays escaped commands but passes the original string to the approved child', async () => {
    const command = 'printf safe\r\x1b[2K\n\x9b\u202eprintf second';
    await runBatches([{ commands: [command] }]);
    const shown = display.mock.calls.flat().join('\n');
    expect(shown).toContain('without sandbox isolation');
    expect(shown).toContain('container-shell');
    expect(shown).toContain(
      '"printf safe\\r\\u001b[2K\\n\\u009b\\u202eprintf second"',
    );
    for (const control of ['\r', '\x1b', '\x9b', '\u202e']) {
      expect(shown).not.toContain(control);
    }
    expect(mocks.exec.mock.calls[0][0]).toBe(command);
  });

  it.each(['darwin', 'win32'] as const)(
    'limits the %s child environment and closes stdin',
    async (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
      const fixture = {
        [platform === 'win32' ? 'Path' : 'PATH']: '/synthetic/bin',
        SystemRoot: 'C:\\SyntheticWindows',
        OPENAI_API_KEY: 'synthetic-api-key',
        SHELL_EXAMPLE_TEST_SECRET: 'synthetic-secret',
        BASH_ENV: '/synthetic/startup',
        ENV: '/synthetic/startup',
        NODE_OPTIONS: '--require=/synthetic/startup',
        HOME: '/synthetic/home',
      };
      vi.spyOn(process, 'env', 'get').mockReturnValue(fixture);
      await runBatches();
      expect(mocks.exec.mock.calls[0][1].env).toEqual(
        platform === 'win32'
          ? { Path: '/synthetic/bin', SystemRoot: 'C:\\SyntheticWindows' }
          : { PATH: '/synthetic/bin' },
      );
      expect(endStdin).toHaveBeenCalledOnce();
    },
  );

  it('does not let Node restore the parent coverage environment', async () => {
    const actual =
      await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
    const { promisify } = await import('node:util');
    vi.stubEnv('NODE_V8_COVERAGE', '/synthetic/coverage');
    const environments: string[][] = [];
    // Intercept the final native spawn boundary: exercise Node's actual env
    // normalization but never create a process or run the supplied command.
    const prototype = actual.ChildProcess.prototype as unknown as {
      spawn(options: { envPairs: string[] }): number;
    };
    vi.spyOn(prototype, 'spawn').mockImplementation((options) => {
      environments.push(options.envPairs);
      throw new Error('Synthetic stop before process creation');
    });
    mocks.exec.mockImplementation(promisify(actual.exec));
    await runBatches();
    expect(environments).toHaveLength(1);
    expect(
      environments[0].some((entry) => entry.startsWith('NODE_V8_COVERAGE=')),
    ).toBe(false);
  });

  it('preserves timeout output and stops the remaining commands', async () => {
    mocks.exec.mockImplementationOnce(() =>
      Object.assign(
        Promise.reject({
          killed: true,
          stdout: 'partial',
          stderr: 'timed out',
        }),
        { child: { stdin: { end: endStdin } } },
      ),
    );
    const result = await runBatches([
      { commands: ['printf first', 'printf second'] },
    ]);
    expect(mocks.exec).toHaveBeenCalledOnce();
    expect(
      result.newItems.find((item) => item.rawItem.type === 'shell_call_output')
        ?.rawItem,
    ).toMatchObject({
      output: [
        {
          stdout: 'partial',
          stderr: 'timed out',
          outcome: { type: 'timeout' },
        },
      ],
    });
  });
});
