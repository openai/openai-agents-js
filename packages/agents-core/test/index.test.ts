import { describe, test, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';

import * as AgentsCore from '../src/index';
import type {
  AgentHookEvents,
  AgentTool,
  AgentToolOptions,
  AgentToolOptionsWithDefault,
  AgentToolOptionsWithParameters,
  RunHookEvents,
  ToolNameCollisionPolicy,
} from '../src/index';
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
    expect(typeof AgentsCore.setSensitiveDataLoggingEnabled).toBe('function');
    expect(typeof AgentsCore.RunCompactionItem).toBe('function');
  });

  test('exposes public lifecycle and agent tool types', () => {
    const _parameters = z.object({ query: z.string() });
    type TestAgent = AgentsCore.Agent<undefined>;
    type PublicTypes = [
      AgentHookEvents<undefined>,
      RunHookEvents<undefined>,
      AgentToolOptions<undefined, TestAgent, typeof _parameters>,
      AgentToolOptionsWithDefault<undefined, TestAgent>,
      AgentToolOptionsWithParameters<undefined, TestAgent, typeof _parameters>,
      AgentTool<undefined, TestAgent, typeof _parameters>,
      ToolNameCollisionPolicy,
    ];

    expectTypeOf<PublicTypes>().not.toBeNever();
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
