import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { run, setTracingDisabled } from '@openai/agents/classic';
import { Manifest, SandboxAgent, shell } from '@openai/agents/classic/sandbox';
import {
  assistantMessage,
  functionCall,
  modelResponse,
  ScriptedModel,
} from '@openai/agents/classic/testing';
import {
  borrowSelectedModalProbe,
  ownSelectedModalProbe,
} from '../../../../examples/codex/selected-modal-sandbox';

beforeAll(() => setTracingDisabled(true));
afterAll(() => setTracingDisabled(false));

const args = { cmd: 'python -V', login: false };

function fixture(wait: () => Promise<number> = async () => 17) {
  const proxy = { identity: {}, route: 'synthetic-private-proxy' };
  const calls: unknown[] = [];
  const events: string[] = [];
  const forbidden = vi.fn(() => {
    throw new Error(
      'Provider creation, lookup or reconfiguration is forbidden.',
    );
  });
  const selected = {
    proxy,
    create: forbidden,
    fromId: forbidden,
    updateProxy: forbidden,
    terminate: vi.fn(async () => {
      events.push('dispose');
    }),
    async exec(command: string[], options: unknown) {
      calls.push({ receiver: this, command, options, proxy: this.proxy });
      events.push('exec');
      return {
        async wait() {
          events.push('wait');
          const code = await wait();
          events.push('settled');
          return code;
        },
      };
    },
  };
  const dispose = vi.fn(async () => {
    await selected.terminate();
  });
  return { selected, proxy, calls, events, forbidden, dispose };
}

function agent(command: Record<string, unknown> = args) {
  const model = new ScriptedModel([
    modelResponse([functionCall('exec_command', command, { callId: 'probe' })]),
    modelResponse([assistantMessage('done')]),
  ]);
  return {
    model,
    agent: new SandboxAgent({
      name: 'SelectedProbe',
      instructions: 'Use the selected version probe.',
      capabilities: [shell()],
      model,
    }),
  };
}

function assertSelection(f: ReturnType<typeof fixture>) {
  expect(f.calls).toEqual([
    {
      receiver: f.selected,
      command: ['python', '-V'],
      options: { timeoutMs: 5_000, stdout: 'ignore', stderr: 'ignore' },
      proxy: f.proxy,
    },
  ]);
  const call = f.calls[0] as { receiver: unknown; proxy: unknown };
  expect(call.receiver).toBe(f.selected);
  expect(call.proxy).toBe(f.proxy);
  expect(f.selected.proxy).toBe(f.proxy);
  expect(f.forbidden).not.toHaveBeenCalled();
}

describe('application-selected Modal sandbox probe', () => {
  it('creates only the binding, dispatches on the selected object and shuts down once', async () => {
    const f = fixture();
    const client = ownSelectedModalProbe(f.selected, f.dispose);
    const session = await client.create!(new Manifest());
    expect(await session.exec!(args)).toMatchObject({
      exitCode: 17,
      stdout: '',
      stderr: '',
    });
    expect(f.dispose).not.toHaveBeenCalled();
    await Promise.all([session.shutdown!(), session.shutdown!()]);
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(f.selected.terminate).toHaveBeenCalledTimes(1);
    await expect(session.exec!(args)).rejects.toThrow('single-use');
    await expect(client.create!()).rejects.toThrow('binds once');
    assertSelection(f);
  });

  it('runs the public SDK shell path and disposes its owned session after admitted work', async () => {
    let resolve!: (value: number) => void;
    const waiting = new Promise<number>((done) => {
      resolve = done;
    });
    const f = fixture(() => waiting);
    const client = ownSelectedModalProbe(f.selected, f.dispose);
    const create = vi.spyOn(client, 'create');
    const a = agent();
    const running = run(a.agent, 'Probe', { sandbox: { client } });
    try {
      await vi.waitFor(() => expect(f.events).toEqual(['exec', 'wait']));
      expect(f.dispose).not.toHaveBeenCalled();
    } finally {
      resolve(17);
    }
    const result = await running;
    expect(result.finalOutput).toBe('done');
    expect(create).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(['exec', 'wait', 'settled', 'dispose']);
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(f.selected.terminate).toHaveBeenCalledTimes(1);
    const input = a.model.calls[1].request.input;
    if (!Array.isArray(input))
      throw new Error('Expected structured model input.');
    const reply = input.find((item) => item.type === 'function_call_result');
    expect(reply).toMatchObject({
      output: { type: 'text', text: expect.stringContaining('"exitCode":17') },
    });
    expect(JSON.stringify(a.model.calls)).not.toContain(f.proxy.route);
    expect(a.model.remainingSteps).toBe(0);
    assertSelection(f);
  });

  it('retains a borrowed supplied session until the application disposes its resource', async () => {
    const f = fixture();
    const session = borrowSelectedModalProbe(f.selected);
    const a = agent();
    expect(
      (await run(a.agent, 'Probe', { sandbox: { session } })).finalOutput,
    ).toBe('done');
    expect(session.shutdown).toBeUndefined();
    expect(session.stop).toBeUndefined();
    expect(session.close).toBeUndefined();
    expect(f.dispose).not.toHaveBeenCalled();
    expect(f.selected.terminate).not.toHaveBeenCalled();
    expect(JSON.stringify(session.state)).not.toContain(f.proxy.route);
    assertSelection(f);
    await f.dispose();
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(f.selected.terminate).toHaveBeenCalledTimes(1);
  });

  it('fences new execution and joins admitted work when shutdown starts early', async () => {
    let resolve!: (value: number) => void;
    const waiting = new Promise<number>((done) => {
      resolve = done;
    });
    const f = fixture(() => waiting);
    const session = await ownSelectedModalProbe(f.selected, f.dispose)
      .create!();
    const active = session.exec!(args);
    await vi.waitFor(() => expect(f.events).toEqual(['exec', 'wait']));
    const closing = session.shutdown!();
    try {
      await expect(session.exec!(args)).rejects.toThrow('single-use');
      expect(f.dispose).not.toHaveBeenCalled();
    } finally {
      resolve(17);
    }
    await active;
    await closing;
    expect(f.events).toEqual(['exec', 'wait', 'settled', 'dispose']);
    expect(f.dispose).toHaveBeenCalledTimes(1);
  });

  it('preserves a disposal failure and does not dispose twice', async () => {
    const failure = new Error('synthetic disposal failure');
    const f = fixture();
    const dispose = vi.fn(async () => {
      throw failure;
    });
    const session = await ownSelectedModalProbe(f.selected, dispose).create!();
    const first = session.shutdown!();
    await expect(first).rejects.toBe(failure);
    expect(session.shutdown!()).toBe(first);
    await expect(session.shutdown!()).rejects.toBe(failure);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('joins failed work before owned cleanup without replacing the selected sandbox', async () => {
    const failure = new Error('synthetic provider failure');
    const f = fixture(async () => {
      throw failure;
    });
    const client = ownSelectedModalProbe(f.selected, f.dispose);
    const session = await client.create!();
    await expect(session.exec!(args)).rejects.toBe(failure);
    await session.shutdown!();
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(['exec', 'wait', 'dispose']);
    assertSelection(f);
  });

  it('cleans the owned public-runner session after a provider failure', async () => {
    const f = fixture(async () => {
      throw new Error('synthetic failure');
    });
    const a = agent();
    await run(a.agent, 'Probe', {
      sandbox: { client: ownSelectedModalProbe(f.selected, f.dispose) },
    });
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(['exec', 'wait', 'dispose']);
    expect(JSON.stringify(a.model.calls[1].request.input)).toContain('error');
    assertSelection(f);
  });

  it.each([
    { cmd: 'other', login: false },
    { ...args, login: true },
    { ...args, tty: true },
    { ...args, workdir: '/other' },
    { ...args, shell: '/bin/bash' },
    { ...args, runAs: 'root' },
    { ...args, maxOutputTokens: 10 },
    { ...args, yieldTimeMs: 0 },
  ])(
    'rejects unsupported execution before provider effects (%j)',
    async (request) => {
      const f = fixture();
      const session = borrowSelectedModalProbe(f.selected);
      await expect(session.exec!(request)).rejects.toThrow('only the blocking');
      expect(f.calls).toHaveLength(0);
      expect(f.dispose).not.toHaveBeenCalled();
      expect(f.forbidden).not.toHaveBeenCalled();
    },
  );

  it('rejects unsupported public shell input before provider effects', async () => {
    const f = fixture();
    const a = agent({ ...args, tty: true });
    await run(a.agent, 'Probe', {
      sandbox: { session: borrowSelectedModalProbe(f.selected) },
    });
    expect(f.calls).toHaveLength(0);
    expect(f.dispose).not.toHaveBeenCalled();
    expect(f.forbidden).not.toHaveBeenCalled();
  });

  it.each([
    { manifest: new Manifest({ root: '/other' }) },
    { options: {} },
    { snapshot: { type: 'local' as const } },
    { archiveLimits: null },
    { concurrencyLimits: {} },
  ])('rejects unsupported binding configuration (%j)', async (request) => {
    const f = fixture();
    await expect(
      ownSelectedModalProbe(f.selected, f.dispose).create!(request),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
    expect(f.dispose).not.toHaveBeenCalled();
    expect(f.forbidden).not.toHaveBeenCalled();
  });
});
