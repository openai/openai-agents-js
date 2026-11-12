import * as ClassicSandbox from '../src/classic/sandbox';
import * as Agents from '../src/classic';
import * as Sandbox from '../src/sandbox';
import * as LocalSandbox from '../src/sandbox/local';
import { RealtimeAgent } from '../src/realtime';
import { isZodObject } from '../src/utils';
import { describe, test, expect } from 'vitest';

describe('Exports', () => {
  test('Agent is out there', () => {
    const agent = new Agents.Agent({ name: 'Test' });
    expect(agent.name).toBe('Test');
    expect(typeof Agents.setSensitiveDataLoggingEnabled).toBe('function');
    expect(typeof Agents.RunCompactionItem).toBe('function');
    expect(typeof Agents.RunInputItem).toBe('function');
    expect(typeof Agents.isSessionHistoryTransactionAwareSession).toBe(
      'function',
    );
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

describe('Image generation exports', () => {
  test('imageGenerationTool accepts the action option', () => {
    expect(Agents.imageGenerationTool({ action: 'edit' })).toMatchObject({
      type: 'hosted_tool',
      name: 'image_generation',
      providerData: { type: 'image_generation', action: 'edit' },
    });
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

    expect(typeof Sandbox.sandboxEnvironment).toBe('function');
    expect(typeof Sandbox.renderStorageLayout).toBe('function');
    expect(ClassicSandbox.Manifest).toBe(Sandbox.Manifest);
    expect('sandboxEnvironment' in ClassicSandbox).toBe(false);
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
