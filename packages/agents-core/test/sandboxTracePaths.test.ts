import { afterEach, describe, expect, it } from 'vitest';
import { RunContext } from '../src';
import {
  addSandboxEventSink,
  clearSandboxEventSinks,
  SandboxWorkspaceScope,
  shell,
  type SandboxEvent,
} from '../src/sandbox';
import { scriptedSandboxSession } from '../src/testing';

describe('sandbox trace paths', () => {
  afterEach(() => {
    clearSandboxEventSinks();
  });

  it('records the effective run-scoped exec workdir', async () => {
    const events: SandboxEvent[] = [];
    addSandboxEventSink((event) => {
      events.push(event);
    });

    const session = scriptedSandboxSession([
      { method: 'execCommand', result: 'default cwd' },
      { method: 'execCommand', result: 'nested cwd' },
    ]);
    const capability = shell();
    capability
      .bind(session)
      .bindWorkspaceScope(SandboxWorkspaceScope.fromCwd('tasks/a'));
    const execCommand = capability.tools()[0] as any;

    await execCommand.invoke(new RunContext(), JSON.stringify({ cmd: 'pwd' }));
    await execCommand.invoke(
      new RunContext(),
      JSON.stringify({ cmd: 'pwd', workdir: 'reports' }),
    );

    const starts = events.filter(
      (event) =>
        event.type === 'sandbox_operation' &&
        event.name === 'sandbox.exec' &&
        event.phase === 'start',
    );
    expect(starts.map((event) => event.data?.workdir)).toEqual([
      'tasks/a',
      'tasks/a/reports',
    ]);
    expect(session.calls.map((call) => (call.args[0] as any).workdir)).toEqual([
      'tasks/a',
      'tasks/a/reports',
    ]);
    session.assertComplete();
  });
});
