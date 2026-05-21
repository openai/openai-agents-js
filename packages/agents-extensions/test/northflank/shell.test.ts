import type { ShellAction } from '@openai/agents';
import { describe, expect, it, vi } from 'vitest';

import { NorthflankShell } from '../../src/northflank/shell';

function makeClient(overrides: Partial<Record<string, any>> = {}) {
  // Type the mock signatures with `(...args: any[])` so vitest's call
  // recording surfaces typed tuples on `.mock.calls`; the default
  // `vi.fn(async () => ...)` infers a zero-arg signature.
  const execServiceCommand = vi.fn(async (..._args: any[]) => ({
    commandResult: { exitCode: 0, status: 'Success' as const },
    stdOut: 'hello',
    stdErr: '',
  }));
  const execJobCommand = vi.fn(async (..._args: any[]) => ({
    commandResult: { exitCode: 0, status: 'Success' as const },
    stdOut: 'job-out',
    stdErr: '',
  }));
  const execAddonCommand = vi.fn(async (..._args: any[]) => ({
    commandResult: { exitCode: 0, status: 'Success' as const },
    stdOut: 'addon-out',
    stdErr: '',
  }));
  const client: any = {
    exec: {
      execServiceCommand,
      execJobCommand,
      execAddonCommand,
      ...overrides,
    },
  };
  return { client, execServiceCommand, execJobCommand, execAddonCommand };
}

function action(
  commands: string[],
  rest: Partial<ShellAction> = {},
): ShellAction {
  return { commands, ...rest };
}

describe('NorthflankShell — service target', () => {
  it('runs each command sequentially and returns one output per command', async () => {
    const { client, execServiceCommand } = makeClient();
    const shell = new NorthflankShell({
      client,
      target: { type: 'service', projectId: 'p', serviceId: 's' },
    });

    const result = await shell.run(action(['ls', 'pwd']));

    expect(execServiceCommand).toHaveBeenCalledTimes(2);
    // Commands are wrapped as argv `[sh, -c, <user>]` so Northflank's exec
    // API actually runs them through a shell instead of treating the whole
    // string as a binary name. We default to `sh -c` because many minimal
    // `/bin/sh` builds don't accept `-l`.
    expect(execServiceCommand.mock.calls[0]![1].command).toEqual([
      'sh',
      '-c',
      'ls',
    ]);
    expect(execServiceCommand.mock.calls[0]![1].shell).toBe('none');
    expect(execServiceCommand.mock.calls[1]![1].command).toEqual([
      'sh',
      '-c',
      'pwd',
    ]);

    expect(result.output).toHaveLength(2);
    expect(result.output[0]).toMatchObject({
      command: 'ls',
      stdout: 'hello',
      stderr: '',
      outcome: { type: 'exit', exitCode: 0 },
    });
  });

  it('forwards instanceName, containerName, shell, teamId when configured', async () => {
    const { client, execServiceCommand } = makeClient();
    const shell = new NorthflankShell({
      client,
      target: {
        type: 'service',
        projectId: 'p',
        serviceId: 's',
        teamId: 't',
        instanceName: 'pod-0',
        containerName: 'main',
        shell: 'bash -lc',
      },
    });
    await shell.run(action(['echo hi']));

    const [params, data] = execServiceCommand.mock.calls[0]!;
    expect(params).toMatchObject({
      projectId: 'p',
      serviceId: 's',
      teamId: 't',
    });
    // `target.shell: 'bash -lc'` is parsed as a full invocation — we don't
    // append another `-lc`. `shell: 'none'` tells Northflank not to wrap
    // again (we did our own wrapping).
    expect(data).toMatchObject({
      command: ['bash', '-lc', 'echo hi'],
      shell: 'none',
      instanceName: 'pod-0',
      containerName: 'main',
    });
  });

  it('omits target fields that were not configured', async () => {
    const { client, execServiceCommand } = makeClient();
    const shell = new NorthflankShell({
      client,
      target: { type: 'service', projectId: 'p', serviceId: 's' },
    });
    await shell.run(action(['echo hi']));

    const data = execServiceCommand.mock.calls[0]![1];
    expect(data).not.toHaveProperty('instanceName');
    expect(data).not.toHaveProperty('containerName');
    expect(data).not.toHaveProperty('teamId');
    // We always set shell: 'none' to opt out of Northflank's own wrapping.
    expect(data.shell).toBe('none');
  });
});

describe('NorthflankShell — job + addon targets', () => {
  it('dispatches job commands via execJobCommand', async () => {
    const { client, execJobCommand, execServiceCommand } = makeClient();
    const shell = new NorthflankShell({
      client,
      target: { type: 'job', projectId: 'p', jobId: 'j' },
    });
    const result = await shell.run(action(['ls']));

    expect(execJobCommand).toHaveBeenCalledTimes(1);
    expect(execServiceCommand).not.toHaveBeenCalled();
    expect(result.output[0].stdout).toBe('job-out');
  });

  it('dispatches addon commands via execAddonCommand with required instanceName', async () => {
    const { client, execAddonCommand } = makeClient();
    const shell = new NorthflankShell({
      client,
      target: {
        type: 'addon',
        projectId: 'p',
        addonId: 'a',
        instanceName: 'replica-0',
      },
    });
    await shell.run(action(['psql -c "select 1"']));

    expect(execAddonCommand).toHaveBeenCalledTimes(1);
    const data = execAddonCommand.mock.calls[0]![1];
    expect(data.instanceName).toBe('replica-0');
  });
});

describe('NorthflankShell — outcomes', () => {
  it('reports non-zero exit codes as exit/exitCode outcomes', async () => {
    const { client } = makeClient({
      execServiceCommand: vi.fn(async () => ({
        commandResult: {
          exitCode: 7,
          status: 'Failure' as const,
          message: 'no',
        },
        stdOut: 'partial',
        stdErr: 'boom',
      })),
    });
    const shell = new NorthflankShell({
      client,
      target: { type: 'service', projectId: 'p', serviceId: 's' },
    });
    const result = await shell.run(action(['fail']));
    expect(result.output[0].outcome).toEqual({ type: 'exit', exitCode: 7 });
    expect(result.output[0].stdout).toBe('partial');
    expect(result.output[0].stderr).toBe('boom');
  });

  it('thrown exec errors produce a null exitCode outcome with stderr=error message', async () => {
    const { client } = makeClient({
      execServiceCommand: vi.fn(async () => {
        throw new Error('connection lost');
      }),
    });
    const shell = new NorthflankShell({
      client,
      target: { type: 'service', projectId: 'p', serviceId: 's' },
    });
    const result = await shell.run(action(['echo hi']));
    expect(result.output[0].outcome).toEqual({ type: 'exit', exitCode: null });
    expect(result.output[0].stderr).toContain('connection lost');
  });

  it('honors timeoutMs and stops processing further commands', async () => {
    const { client } = makeClient({
      execServiceCommand: vi.fn(
        () => new Promise(() => undefined), // never resolves
      ),
    });
    const shell = new NorthflankShell({
      client,
      target: { type: 'service', projectId: 'p', serviceId: 's' },
    });
    const result = await shell.run(
      action(['sleep 999', 'should-not-run'], { timeoutMs: 25 }),
    );
    expect(result.output).toHaveLength(1);
    expect(result.output[0].outcome).toEqual({ type: 'timeout' });
  });

  it('truncates stdout/stderr per stream so total stays under maxOutputLength', async () => {
    const { client } = makeClient({
      execServiceCommand: vi.fn(async () => ({
        commandResult: { exitCode: 0, status: 'Success' as const },
        stdOut: 'o'.repeat(1000),
        stdErr: 'e'.repeat(1000),
      })),
    });
    const shell = new NorthflankShell({
      client,
      target: { type: 'service', projectId: 'p', serviceId: 's' },
    });
    const result = await shell.run(action(['big'], { maxOutputLength: 100 }));
    const item = result.output[0];
    // The leading run of the original character is bounded by half the budget.
    // (Anything past that is the "[truncated N chars]" marker.)
    expect(item.stdout.match(/^o+/)?.[0].length).toBeLessThanOrEqual(50);
    expect(item.stderr.match(/^e+/)?.[0].length).toBeLessThanOrEqual(50);
    expect(item.stdout).toMatch(/truncated/);
    expect(item.stderr).toMatch(/truncated/);
    expect(result.maxOutputLength).toBe(100);
  });

  it('includes providerData for downstream telemetry', async () => {
    const { client } = makeClient();
    const shell = new NorthflankShell({
      client,
      target: { type: 'service', projectId: 'p-1', serviceId: 's' },
    });
    const result = await shell.run(action(['echo hi']));
    expect(result.providerData).toMatchObject({
      target: 'service',
      projectId: 'p-1',
    });
  });
});
