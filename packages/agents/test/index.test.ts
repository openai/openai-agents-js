import * as Agents from '../src/index';
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
import { RealtimeAgent } from '../src/realtime';
import { isZodObject } from '../src/utils';
import { describe, test, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';

describe('Exports', () => {
  test('Agent is out there', () => {
    const agent = new Agents.Agent({ name: 'Test' });
    expect(agent.name).toBe('Test');
    expect(typeof Agents.setSensitiveDataLoggingEnabled).toBe('function');
  });

  test('lifecycle and agent tool types are out there', () => {
    const _parameters = z.object({ query: z.string() });
    type TestAgent = Agents.Agent<undefined>;
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
});

describe('RealtimeAgent', () => {
  test('should be available', () => {
    const agent = new RealtimeAgent({ name: 'Test' });
    expect(agent.name).toBe('Test');
  });
});

describe('isZodObject', () => {
  test('should be available', () => {
    expect(isZodObject({})).toBe(false);
  });
});

describe('Tool search exports', () => {
  test('toolNamespace and toolSearchTool should be available', () => {
    expect(typeof Agents.toolNamespace).toBe('function');
    expect(Agents.toolSearchTool()).toMatchObject({
      type: 'hosted_tool',
      name: 'tool_search',
      providerData: { type: 'tool_search' },
    });
    expect(
      Agents.toolSearchTool({
        execution: 'client',
      }),
    ).toMatchObject({
      providerData: {
        type: 'tool_search',
        execution: 'client',
      },
    });
  });
});

describe('Programmatic Tool Calling exports', () => {
  test('programmaticToolCallingTool should be available', () => {
    expect(Agents.programmaticToolCallingTool()).toEqual({
      type: 'hosted_tool',
      name: 'programmatic_tool_calling',
      providerData: { type: 'programmatic_tool_calling' },
    });
  });
});

describe('Sandbox exports', () => {
  test('are only available from the sandbox subpath', () => {
    expect('SandboxAgent' in Agents).toBe(false);
    expect('Manifest' in Agents).toBe(false);
    expect('Capabilities' in Agents).toBe(false);
    expect('filesystem' in Agents).toBe(false);

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
