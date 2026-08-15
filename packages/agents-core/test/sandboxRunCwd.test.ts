import { describe, expect, it } from 'vitest';
import { RunContext } from '../src';
import {
  Manifest,
  memory,
  SandboxAgent,
  SandboxRuntimeManager,
  SandboxWorkspaceScope,
  skills,
} from '../src/sandbox';
import { scriptedSandboxSession } from '../src/testing';

describe('sandbox run cwd', () => {
  it('keeps concurrent run scopes independent on a shared session', async () => {
    const probedPaths: string[] = [];
    const session = {
      state: { manifest: new Manifest({ root: '/workspace' }) },
      directoryExists: async (path: string) => {
        await Promise.resolve();
        probedPaths.push(path);
        return true;
      },
    } as any;
    const agents = ['sandbox-a', 'sandbox-b'].map(
      (name) => new SandboxAgent({ name, capabilities: [] }),
    );
    const managers = ['tasks/a', 'tasks/b'].map(
      (cwd, index) =>
        new SandboxRuntimeManager({
          startingAgent: agents[index] as any,
          sandboxConfig: { session, cwd },
        }),
    );

    const preparedAgents = await Promise.all(
      managers.map((manager, index) =>
        manager.prepareAgent({
          currentAgent: agents[index] as any,
          turnInput: [],
        }),
      ),
    );
    const prompts = await Promise.all(
      preparedAgents.map(({ executionAgent }) =>
        executionAgent.getSystemPrompt(new RunContext()),
      ),
    );

    expect(probedPaths.sort()).toEqual(['tasks/a', 'tasks/b']);
    expect(prompts[0]).toContain('/workspace/tasks/a');
    expect(prompts[1]).toContain('/workspace/tasks/b');
  });

  it('validates a provided session cwd before preparing the agent', async () => {
    const session = scriptedSandboxSession([
      { method: 'directoryExists', result: true },
    ]);
    session.state.manifest = new Manifest({ root: '/workspace' });
    const agent = new SandboxAgent({ name: 'sandbox', capabilities: [] });
    const manager = new SandboxRuntimeManager({
      startingAgent: agent as any,
      sandboxConfig: { session, cwd: 'tasks/a' },
    });

    const prepared = await manager.prepareAgent({
      currentAgent: agent as any,
      turnInput: [],
    });
    const prompt = await prepared.executionAgent.getSystemPrompt(
      new RunContext(),
    );

    expect(session.calls[0]).toMatchObject({
      method: 'directoryExists',
      args: ['tasks/a', undefined],
    });
    expect(prompt).toContain(
      'For this run, the working directory is `/workspace/tasks/a`.',
    );
    expect(prompt).toContain(
      'The working directory changes path resolution; it does not isolate this run',
    );
    session.assertComplete();
  });

  it('rejects an inaccessible cwd before agent preparation', async () => {
    const session = {
      state: { manifest: new Manifest({ root: '/workspace' }) },
      directoryExists: async () => false,
    } as any;
    const agent = new SandboxAgent({ name: 'sandbox', capabilities: [] });
    const manager = new SandboxRuntimeManager({
      startingAgent: agent as any,
      sandboxConfig: { session, cwd: 'tasks/missing' },
    });

    await expect(
      manager.prepareAgent({ currentAgent: agent as any, turnInput: [] }),
    ).rejects.toThrow(
      'Sandbox working directory "tasks/missing" does not exist or is not accessible.',
    );
  });

  it('rejects sessions without completed path probe APIs', async () => {
    let execCommandCalls = 0;
    const session = {
      state: { manifest: new Manifest({ root: '/workspace' }) },
      execCommand: async () => {
        execCommandCalls += 1;
        return 'Process running with session ID 1';
      },
    } as any;
    const agent = new SandboxAgent({ name: 'sandbox', capabilities: [] });
    const manager = new SandboxRuntimeManager({
      startingAgent: agent as any,
      sandboxConfig: { session, cwd: 'tasks/a' },
    });

    await expect(
      manager.prepareAgent({ currentAgent: agent as any, turnInput: [] }),
    ).rejects.toThrow(
      'Sandbox sessions used with sandbox.cwd must provide directoryExists().',
    );
    expect(execCommandCalls).toBe(0);
  });

  it('preserves path probe errors and does not cache failures', async () => {
    const providerError = Object.assign(new Error('credentials expired'), {
      code: 'SANDBOX_AUTH_EXPIRED',
      retryable: true,
    });
    let attempts = 0;
    const session = {
      state: { manifest: new Manifest({ root: '/workspace' }) },
      directoryExists: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw providerError;
        }
        return true;
      },
    } as any;
    const agent = new SandboxAgent({ name: 'sandbox', capabilities: [] });
    const manager = new SandboxRuntimeManager({
      startingAgent: agent as any,
      sandboxConfig: { session, cwd: 'tasks/a' },
    });

    await expect(
      manager.prepareAgent({ currentAgent: agent as any, turnInput: [] }),
    ).rejects.toBe(providerError);
    await manager.prepareAgent({ currentAgent: agent as any, turnInput: [] });

    expect(attempts).toBe(2);
  });

  it('preserves directory probe errors', async () => {
    const providerError = Object.assign(new Error('backend timed out'), {
      code: 'SANDBOX_TIMEOUT',
      retryable: true,
    });
    const session = scriptedSandboxSession([
      { method: 'directoryExists', error: providerError },
    ]);
    session.state.manifest = new Manifest({ root: '/workspace' });
    const agent = new SandboxAgent({ name: 'sandbox', capabilities: [] });
    const manager = new SandboxRuntimeManager({
      startingAgent: agent as any,
      sandboxConfig: { session, cwd: 'tasks/a' },
    });

    await expect(
      manager.prepareAgent({ currentAgent: agent as any, turnInput: [] }),
    ).rejects.toBe(providerError);
    session.assertComplete();
  });

  it('revalidates cwd before a later model turn', async () => {
    let attempts = 0;
    const session = {
      state: { manifest: new Manifest({ root: '/workspace' }) },
      directoryExists: async () => {
        attempts += 1;
        return attempts === 1;
      },
    } as any;
    const agent = new SandboxAgent({ name: 'sandbox', capabilities: [] });
    const manager = new SandboxRuntimeManager({
      startingAgent: agent as any,
      sandboxConfig: { session, cwd: 'tasks/a' },
    });

    await manager.prepareAgent({ currentAgent: agent as any, turnInput: [] });
    await expect(
      manager.prepareAgent({ currentAgent: agent as any, turnInput: [] }),
    ).rejects.toThrow(
      'Sandbox working directory "tasks/a" does not exist or is not accessible.',
    );
    expect(attempts).toBe(2);
  });

  it('keeps Memory and Skills session-owned while rendering stable model paths', async () => {
    const scope = SandboxWorkspaceScope.fromCwd('tasks/a');
    const manifest = new Manifest({ root: '/workspace' });
    const memorySession = scriptedSandboxSession([
      { method: 'readFile', result: 'remember this' },
    ]);
    memorySession.state.manifest = manifest;
    const memoryCapability = memory({ read: { liveUpdate: false } })
      .bind(memorySession)
      .bindWorkspaceScope(scope);
    const skillsCapability = skills({
      skills: [
        {
          name: 'reviewer',
          description: 'Review code.',
          content: '# Reviewer',
        },
      ],
    }).bindWorkspaceScope(scope);

    const memoryInstructions = await memoryCapability.instructions(manifest);
    const skillsInstructions = await skillsCapability.instructions(manifest);

    expect(memorySession.calls[0]).toMatchObject({
      method: 'readFile',
      args: [{ path: 'memories/memory_summary.md' }],
    });
    expect(memoryInstructions).toContain(
      '/workspace/memories/memory_summary.md',
    );
    expect(skillsInstructions).toContain('(file: /workspace/.agents/reviewer)');
    memorySession.assertComplete();
  });
});
