import { describe, test, expect } from 'vitest';

import * as AgentsCore from '../src/index';
import * as Sandbox from '../src/sandbox';
import * as LocalSandbox from '../src/sandbox/local';

describe('index.ts', () => {
  test('has expected exports', () => {
    const agent = new AgentsCore.Agent({
      name: 'TestAgent',
      outputType: 'text',
    });
    expect(agent).toBeDefined();
    expect(agent.name).toEqual('TestAgent');
  });

  test('does not expose sandbox exports from the top-level entry', () => {
    expect('SandboxAgent' in AgentsCore).toBe(false);
    expect('Manifest' in AgentsCore).toBe(false);
    expect('Capabilities' in AgentsCore).toBe(false);
    expect('filesystem' in AgentsCore).toBe(false);

    expect(typeof Sandbox.SandboxAgent).toBe('function');
    expect(typeof Sandbox.Manifest).toBe('function');
    expect(typeof Sandbox.Capabilities.default).toBe('function');
    expect(typeof Sandbox.filesystem).toBe('function');
    expect(typeof Sandbox.shell).toBe('function');
    expect('UnixLocalSandboxClient' in Sandbox).toBe(false);
    expect('DockerSandboxClient' in Sandbox).toBe(false);
    expect(typeof LocalSandbox.UnixLocalSandboxClient).toBe('function');
    expect(typeof LocalSandbox.DockerSandboxClient).toBe('function');
  });
});
