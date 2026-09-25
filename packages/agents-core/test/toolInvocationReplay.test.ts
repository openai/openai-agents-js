import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent } from '../src/agent';
import { ModelBehaviorError, UserError } from '../src/errors';
import { handoff } from '../src/handoff';
import {
  RunToolApprovalItem,
  RunToolCallItem,
  RunToolCallOutputItem,
} from '../src/items';
import type { ModelResponse } from '../src/model';
import { Runner } from '../src/run';
import { RunContext } from '../src/runContext';
import { CURRENT_SCHEMA_VERSION, RunState } from '../src/runState';
import {
  applyPatchTool,
  attachClientToolSearchExecutor,
  computerTool,
  shellTool,
  tool,
} from '../src/tool';
import {
  getToolInvocationApproval,
  getToolInvocationFingerprint,
} from '../src/toolInvocation';
import { getFunctionToolStateKey } from '../src/toolIdentity';
import type * as protocol from '../src/types/protocol';
import { Usage } from '../src/usage';
import { FakeComputer, FakeEditor, FakeShell, fakeModelMessage } from './stubs';
import { ScriptedModel, modelResponse } from '../src/testing';

function response(output: protocol.ModelItem[]): ModelResponse {
  return { output, usage: new Usage() };
}

function functionCall(
  callId: string,
  name: string,
  args: Record<string, unknown>,
): protocol.FunctionCallItem {
  return {
    type: 'function_call',
    callId,
    name,
    status: 'completed',
    arguments: JSON.stringify(args),
  };
}

function shellCall(callId: string, commands: string[]): protocol.ShellCallItem {
  return {
    type: 'shell_call',
    callId,
    status: 'completed',
    action: { commands },
  };
}

function computerCall(callId: string): protocol.ComputerUseCallItem {
  return {
    type: 'computer_call',
    id: callId,
    callId,
    status: 'completed',
    action: { type: 'screenshot' },
  };
}

function applyPatchCall(callId: string): protocol.ApplyPatchCallItem {
  return {
    type: 'apply_patch_call',
    callId,
    status: 'completed',
    operation: {
      type: 'update_file',
      path: 'README.md',
      diff: 'diff --git',
    },
  };
}

describe('tool invocation replay binding', () => {
  it('canonicalizes Unicode object keys without locale-dependent ordering', () => {
    const call = functionCall('unicode-order', 'unicode_tool', {
      ä: 1,
      z: 2,
    });

    const fingerprint = getToolInvocationFingerprint(call.name, call);
    expect(fingerprint.indexOf('"z"')).toBeLessThan(fingerprint.indexOf('"ä"'));
    expect(fingerprint).toContain('"toolName":"unicode_tool"');
  });

  it('canonicalizes JSON numbers without unsafe-integer collisions', () => {
    const firstCall: protocol.FunctionCallItem = {
      ...functionCall('unsafe-number', 'numeric_tool', {}),
      arguments: '{"n":9007199254740992}',
    };
    const secondCall: protocol.FunctionCallItem = {
      ...firstCall,
      arguments: '{"n":9007199254740993}',
    };
    const firstHostedCall: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      name: 'numeric_hosted_tool',
      status: 'completed',
      providerData: {
        id: 'unsafe-hosted-number',
        server_label: 'server',
        arguments: firstCall.arguments,
      },
    };

    expect(getToolInvocationFingerprint(firstCall.name, firstCall)).not.toBe(
      getToolInvocationFingerprint(secondCall.name, secondCall),
    );
    expect(
      getToolInvocationFingerprint(firstHostedCall.name, firstHostedCall),
    ).not.toBe(
      getToolInvocationFingerprint(firstHostedCall.name, {
        ...firstHostedCall,
        providerData: {
          ...firstHostedCall.providerData,
          arguments: secondCall.arguments,
        },
      }),
    );
    expect(
      getToolInvocationFingerprint(firstCall.name, {
        ...firstCall,
        arguments: '{"n":-0}',
      }),
    ).not.toBe(
      getToolInvocationFingerprint(firstCall.name, {
        ...firstCall,
        arguments: '{"n":0}',
      }),
    );
  });

  it('canonicalizes direct callers and distinguishes program ownership', () => {
    const call = functionCall('caller-identity', 'owned_tool', {
      value: 'safe',
    });

    expect(
      getToolInvocationFingerprint(call.name, {
        ...call,
        caller: { type: 'direct' },
      }),
    ).toBe(getToolInvocationFingerprint(call.name, call));
    expect(
      getToolInvocationFingerprint(call.name, {
        ...call,
        caller: { type: 'program', callerId: 'program-call-a' },
      }),
    ).not.toBe(
      getToolInvocationFingerprint(call.name, {
        ...call,
        caller: { type: 'program', callerId: 'program-call-b' },
      }),
    );
  });

  it('serializes explicit invocation state for the current schema', () => {
    const agent = new Agent({ name: 'EmptyInvocationStateAgent' });
    const serialized = new RunState(
      new RunContext(),
      'start',
      agent,
      1,
    ).toJSON() as any;

    expect(serialized.$schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(serialized.context.approvalInvocations).toEqual([]);
    expect(serialized.completedToolInvocations).toEqual([]);
    expect(serialized.completedToolInvocationEvidence).toEqual([]);
    expect(serialized.ambiguousToolInvocationCallIds).toEqual([]);
  });

  it.each([
    'approvalInvocations',
    'completedToolInvocations',
    'completedToolInvocationEvidence',
    'ambiguousToolInvocationCallIds',
  ] as const)(
    'rejects current-schema state missing %s',
    async (missingField) => {
      const agent = new Agent({ name: 'IncompleteInvocationStateAgent' });
      const serialized = new RunState(
        new RunContext(),
        'start',
        agent,
        1,
      ).toJSON() as any;
      if (missingField === 'approvalInvocations') {
        delete serialized.context.approvalInvocations;
      } else if (missingField === 'completedToolInvocations') {
        delete serialized.completedToolInvocations;
      } else if (missingField === 'completedToolInvocationEvidence') {
        delete serialized.completedToolInvocationEvidence;
      } else {
        delete serialized.ambiguousToolInvocationCallIds;
      }

      await expect(
        RunState.fromString(agent, JSON.stringify(serialized)),
      ).rejects.toThrow(
        `RunState schema ${CURRENT_SCHEMA_VERSION} requires explicit approval, completed, completion-evidence, and ambiguous invocation records.`,
      );
    },
  );

  it('rejects a current-schema per-call approval missing its invocation binding', async () => {
    const approvalTool = tool({
      name: 'tampered_approval_tool',
      description: 'Requires an exact invocation binding.',
      parameters: z.object({ value: z.string() }),
      needsApproval: true,
      execute: async () => 'unused',
    });
    const agent = new Agent({
      name: 'TamperedApprovalBindingAgent',
      tools: [approvalTool],
    });
    const call = functionCall('tampered-approval', approvalTool.name, {
      value: 'safe',
    });
    const context = new RunContext();
    context.approveTool(new RunToolApprovalItem(call, agent));
    const serialized = new RunState(context, 'start', agent, 1).toJSON() as any;
    delete serialized.context.approvalInvocations[0].invocations[call.callId];

    await expect(
      RunState.fromString(agent, JSON.stringify(serialized)),
    ).rejects.toThrow(UserError);
  });

  it('validates invocation conflicts before mutating a merged context', async () => {
    const approvalTool = tool({
      name: 'merge_conflict_tool',
      description: 'Uses an exact per-call approval.',
      parameters: z.object({ value: z.string() }),
      needsApproval: true,
      execute: async () => 'unused',
    });
    const agent = new Agent({
      name: 'AtomicApprovalMergeAgent',
      tools: [approvalTool],
    });
    const callId = 'merge-conflict-call';
    const sourceContext = new RunContext();
    sourceContext.approveTool(
      new RunToolApprovalItem(
        shellCall('source-shell', ['echo source']),
        agent,
        'shell',
      ),
      { alwaysApprove: true },
    );
    sourceContext.approveTool(
      new RunToolApprovalItem(
        functionCall(callId, approvalTool.name, { value: 'changed' }),
        agent,
      ),
    );
    const serialized = new RunState(
      sourceContext,
      'start',
      agent,
      1,
    ).toString();

    const overrideContext = new RunContext();
    overrideContext.approveTool(
      new RunToolApprovalItem(
        functionCall(callId, approvalTool.name, { value: 'safe' }),
        agent,
      ),
    );

    await expect(
      RunState.fromStringWithContext(agent, serialized, overrideContext, {
        contextStrategy: 'merge',
      }),
    ).rejects.toThrow(ModelBehaviorError);
    expect(
      overrideContext.isToolApproved({
        toolName: 'shell',
        callId: 'unrelated-shell-call',
        functionTool: false,
      }),
    ).toBeUndefined();
  });

  it('keeps non-function approvals scoped to their owning agent after serialization', async () => {
    const secondAgent = new Agent({ name: 'SecondShellApprovalOwner' });
    const firstAgent = new Agent({
      name: 'FirstShellApprovalOwner',
      handoffs: [secondAgent],
    });
    const context = new RunContext();
    const approvedCall = shellCall('shared-shell-approval', ['echo safe']);
    context.approveTool(
      new RunToolApprovalItem(approvedCall, firstAgent, 'shell'),
    );
    context.rejectTool(
      new RunToolApprovalItem(approvedCall, secondAgent, 'shell'),
      { message: 'second agent rejected' },
    );

    expect(
      context._resolveToolInvocationApproval(firstAgent, 'shell', approvedCall),
    ).toBe(true);
    expect(
      context._resolveToolInvocationApproval(
        secondAgent,
        'shell',
        approvedCall,
      ),
    ).toBe(false);
    expect(
      context._getToolInvocationRejectionMessage(
        secondAgent,
        'shell',
        approvedCall,
      ),
    ).toBe('second agent rejected');

    const restored = await RunState.fromString(
      firstAgent,
      JSON.stringify(new RunState(context, 'start', firstAgent, 1).toJSON()),
    );
    expect(
      restored._context._resolveToolInvocationApproval(
        firstAgent,
        'shell',
        approvedCall,
      ),
    ).toBe(true);
    expect(
      restored._context._resolveToolInvocationApproval(
        secondAgent,
        'shell',
        approvedCall,
      ),
    ).toBe(false);
    expect(
      restored._context._getToolInvocationRejectionMessage(
        secondAgent,
        'shell',
        approvedCall,
      ),
    ).toBe('second agent rejected');
  });

  it('binds serialized approvals to program caller ownership', async () => {
    const approvalTool = tool({
      name: 'program_owned_approval',
      description: 'Requires approval from the owning program call.',
      parameters: z.object({ value: z.string() }),
      allowedCallers: ['programmatic'],
      needsApproval: true,
      execute: async () => 'unused',
    });
    const agent = new Agent({
      name: 'ProgramOwnedApprovalAgent',
      tools: [approvalTool],
    });
    const approvedCall: protocol.FunctionCallItem = {
      ...functionCall('program-owned-approval', approvalTool.name, {
        value: 'safe',
      }),
      caller: { type: 'program', callerId: 'program-call-a' },
    };
    const context = new RunContext();
    context.approveTool(new RunToolApprovalItem(approvedCall, agent));

    const restored = await RunState.fromString(
      agent,
      new RunState(context, 'start', agent, 1).toString(),
    );

    expect(
      getToolInvocationApproval(
        restored._context,
        agent,
        approvalTool,
        approvedCall,
      ),
    ).toBe(true);
    expect(() =>
      getToolInvocationApproval(restored._context, agent, approvalTool, {
        ...approvedCall,
        caller: { type: 'program', callerId: 'program-call-b' },
      }),
    ).toThrow(ModelBehaviorError);
  });

  it.each([
    ['unsafe integers', '9007199254740992', '9007199254740993'],
    ['signed zero', '-0', '0'],
  ])('binds approvals to distinct %s', (_label, approved, changed) => {
    const approvalTool = tool({
      name: 'numeric_approval',
      description: 'Requires approval for an exact numeric argument.',
      parameters: z.object({ n: z.number() }),
      needsApproval: true,
      execute: async () => 'unused',
    });
    const agent = new Agent({
      name: 'NumericApprovalAgent',
      tools: [approvalTool],
    });
    const approvedCall: protocol.FunctionCallItem = {
      ...functionCall('numeric-approval-call', approvalTool.name, {}),
      arguments: `{"n":${approved}}`,
    };
    const context = new RunContext();
    context.approveTool(new RunToolApprovalItem(approvedCall, agent));

    expect(() =>
      getToolInvocationApproval(context, agent, approvalTool, {
        ...approvedCall,
        arguments: `{"n":${changed}}`,
      }),
    ).toThrow(ModelBehaviorError);
  });

  it.each([
    ['unsafe integers', '9007199254740992', '9007199254740993'],
    ['signed zero', '-0', '0'],
  ])(
    'rejects changed %s after a committed execution',
    async (_label, first, changed) => {
      const execute = vi.fn(async () => 'executed');
      const localTool = tool({
        name: 'numeric_execution',
        description: 'Executes for one exact numeric argument.',
        parameters: z.object({ n: z.number() }),
        execute,
      });
      const firstCall: protocol.FunctionCallItem = {
        ...functionCall('numeric-execution-call', localTool.name, {}),
        arguments: `{"n":${first}}`,
      };
      const model = new ScriptedModel([
        modelResponse(response([firstCall])),
        modelResponse(
          response([
            {
              ...firstCall,
              arguments: `{"n":${changed}}`,
            },
          ]),
        ),
      ]);
      const agent = new Agent({
        name: 'NumericExecutionAgent',
        model,
        tools: [localTool],
      });

      await expect(new Runner().run(agent, 'start')).rejects.toThrow(
        ModelBehaviorError,
      );
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects changed program caller ownership before tool execution', async () => {
    const execute = vi.fn(async () => 'executed');
    const localTool = tool({
      name: 'program_owned_execution',
      description: 'Runs only for the canonical program invocation.',
      parameters: z.object({ value: z.string() }),
      allowedCallers: ['programmatic'],
      execute,
    });
    const firstCall: protocol.FunctionCallItem = {
      ...functionCall('program-owned-call', localTool.name, { value: 'safe' }),
      caller: { type: 'program', callerId: 'program-call-a' },
    };
    const model = new ScriptedModel([
      modelResponse(response([firstCall])),
      modelResponse(response([firstCall])),
      modelResponse(
        response([
          {
            ...firstCall,
            caller: {
              type: 'program' as const,
              callerId: 'program-call-b',
            },
          },
        ]),
      ),
    ]);
    const agent = new Agent({
      name: 'ProgramOwnedExecutionAgent',
      model,
      tools: [localTool],
    });

    await expect(new Runner().run(agent, 'start')).rejects.toThrow(
      ModelBehaviorError,
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty call ID before any tool side effect', async () => {
    const execute = vi.fn(async () => 'unexpected');
    const localTool = tool({
      name: 'empty_id_tool',
      description: 'Must not run without a call ID.',
      parameters: z.object({ value: z.string() }),
      execute,
    });
    const model = new ScriptedModel([
      modelResponse(
        response([
          functionCall('', localTool.name, { value: 'first' }),
          functionCall('', localTool.name, { value: 'changed' }),
        ]),
      ),
    ]);
    const agent = new Agent({
      name: 'EmptyCallIdAgent',
      model,
      tools: [localTool],
    });

    await expect(new Runner().run(agent, 'start')).rejects.toThrow(
      ModelBehaviorError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['approve', 'reject'] as const)(
    'binds a hosted MCP %s decision to the server identity',
    (decision) => {
      const agent = new Agent({ name: 'HostedMcpApprovalAgent' });
      const context = new RunContext();
      const callId = `hosted-${decision}`;
      const approvalItem = new RunToolApprovalItem(
        {
          type: 'hosted_tool_call',
          id: callId,
          name: 'lookup',
          arguments: '{"account":"123"}',
          status: 'in_progress',
          providerData: { server_label: 'server_a' },
        },
        agent,
      );
      context[decision === 'approve' ? 'approveTool' : 'rejectTool'](
        approvalItem,
      );

      expect(() =>
        context._validateToolInvocation(agent, 'lookup', {
          ...approvalItem.rawItem,
          providerData: { server_label: 'server_b' },
        }),
      ).toThrow(ModelBehaviorError);
    },
  );

  it('fails changed arguments before any sibling tool side effect', async () => {
    const approvedExecute = vi.fn(
      async ({ value }: { value: string }) => value,
    );
    const siblingExecute = vi.fn(async () => 'sibling');
    const approvedTool = tool({
      name: 'approved_tool',
      description: 'Requires per-call approval.',
      parameters: z.object({ value: z.string() }),
      needsApproval: true,
      execute: approvedExecute,
    });
    const siblingTool = tool({
      name: 'sibling_tool',
      description: 'Must not run after invalid call ID reuse.',
      parameters: z.object({}),
      execute: siblingExecute,
    });
    const callId = 'reused-arguments';
    const model = new ScriptedModel([
      modelResponse(
        response([functionCall(callId, approvedTool.name, { value: 'safe' })]),
      ),
      modelResponse(
        response([
          functionCall(callId, approvedTool.name, { value: 'changed' }),
          functionCall('sibling-call', siblingTool.name, {}),
        ]),
      ),
    ]);
    const agent = new Agent({
      name: 'ChangedArgumentsAgent',
      model,
      tools: [approvedTool, siblingTool],
    });
    const runner = new Runner();

    const interrupted = await runner.run(agent, 'start');
    interrupted.state.approve(interrupted.interruptions[0]);

    await expect(runner.run(agent, interrupted.state)).rejects.toThrow(
      ModelBehaviorError,
    );
    expect(approvedExecute).toHaveBeenCalledTimes(1);
    expect(approvedExecute.mock.calls[0][0]).toEqual({ value: 'safe' });
    expect(siblingExecute).not.toHaveBeenCalled();
  });

  it('fails changed arguments before a sibling client tool-search callback', async () => {
    const approvedTool = tool({
      name: 'tool_search_preflight_approval',
      description: 'Requires per-call approval.',
      parameters: z.object({ value: z.string() }),
      needsApproval: true,
      execute: async ({ value }) => value,
    });
    const toolSearchExecute = vi.fn(async () => approvedTool);
    const toolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: {
          type: 'tool_search',
          execution: 'client',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      },
      toolSearchExecute,
    );
    const callId = 'tool-search-preflight-call';
    const model = new ScriptedModel([
      modelResponse(
        response([
          functionCall(callId, approvedTool.name, { value: 'approved' }),
        ]),
      ),
      modelResponse(
        response([
          functionCall(callId, approvedTool.name, { value: 'changed' }),
          {
            type: 'tool_search_call',
            id: 'tool-search-preflight-item',
            status: 'completed',
            arguments: {},
            providerData: { call_id: 'tool-search-preflight-search' },
          } as protocol.ToolSearchCallItem,
        ]),
      ),
    ]);
    const agent = new Agent({
      name: 'ToolSearchPreflightAgent',
      model,
      tools: [approvedTool, toolSearch],
    });
    const runner = new Runner();

    const interrupted = await runner.run(agent, 'start');
    interrupted.state.approve(interrupted.interruptions[0]);

    await expect(runner.run(agent, interrupted.state)).rejects.toThrow(
      ModelBehaviorError,
    );
    expect(toolSearchExecute).not.toHaveBeenCalled();
  });

  it('fails changed tool identity before the replacement tool executes', async () => {
    const firstExecute = vi.fn(async () => 'first');
    const secondExecute = vi.fn(async () => 'second');
    const firstTool = tool({
      name: 'first_tool',
      description: 'Requires approval.',
      parameters: z.object({}),
      needsApproval: true,
      execute: firstExecute,
    });
    const secondTool = tool({
      name: 'second_tool',
      description: 'Reuses the first call ID.',
      parameters: z.object({}),
      execute: secondExecute,
    });
    const callId = 'reused-tool';
    const model = new ScriptedModel([
      modelResponse(response([functionCall(callId, firstTool.name, {})])),
      modelResponse(response([functionCall(callId, secondTool.name, {})])),
    ]);
    const agent = new Agent({
      name: 'ChangedToolAgent',
      model,
      tools: [firstTool, secondTool],
    });
    const runner = new Runner();

    const interrupted = await runner.run(agent, 'start');
    interrupted.state.approve(interrupted.interruptions[0]);

    await expect(runner.run(agent, interrupted.state)).rejects.toThrow(
      ModelBehaviorError,
    );
    expect(firstExecute).toHaveBeenCalledTimes(1);
    expect(secondExecute).not.toHaveBeenCalled();
  });

  it('binds a per-call rejection to the rejected invocation', async () => {
    const execute = vi.fn(async () => 'unexpected');
    const rejectedTool = tool({
      name: 'rejected_tool',
      description: 'Requires approval.',
      parameters: z.object({ value: z.string() }),
      needsApproval: true,
      execute,
    });
    const callId = 'reused-rejection';
    const model = new ScriptedModel([
      modelResponse(
        response([
          functionCall(callId, rejectedTool.name, { value: 'rejected' }),
        ]),
      ),
      modelResponse(
        response([
          functionCall(callId, rejectedTool.name, { value: 'changed' }),
        ]),
      ),
    ]);
    const agent = new Agent({
      name: 'ChangedRejectionAgent',
      model,
      tools: [rejectedTool],
    });
    const runner = new Runner();

    const interrupted = await runner.run(agent, 'start');
    interrupted.state.reject(interrupted.interruptions[0]);

    await expect(runner.run(agent, interrupted.state)).rejects.toThrow(
      ModelBehaviorError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('suppresses a semantically exact committed function replay', async () => {
    const execute = vi.fn(async () => 'executed');
    const approvalTool = tool({
      name: 'approval_tool',
      description: 'Requires approval.',
      parameters: z.object({ first: z.number(), second: z.number() }),
      needsApproval: true,
      execute,
    });
    const callId = 'exact-replay';
    const model = new ScriptedModel([
      modelResponse(
        response([
          functionCall(callId, approvalTool.name, { first: 1, second: 2 }),
        ]),
      ),
      modelResponse(
        response([
          functionCall(callId, approvalTool.name, { second: 2, first: 1 }),
        ]),
      ),
      modelResponse(response([fakeModelMessage('done')])),
    ]);
    const agent = new Agent({
      name: 'ExactReplayAgent',
      model,
      tools: [approvalTool],
    });
    const runner = new Runner();

    const interrupted = await runner.run(agent, 'start');
    interrupted.state.approve(interrupted.interruptions[0]);
    const result = await runner.run(agent, interrupted.state);

    expect(result.finalOutput).toBe('done');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, '1.17'] as const)(
    'preserves committed replay suppression through %s RunState serialization',
    async (legacySchemaVersion) => {
      const calls: string[] = [];
      const approvalTool = tool({
        name: 'serialized_tool',
        description: 'Requires approval.',
        parameters: z.object({ value: z.string() }),
        needsApproval: true,
        execute: async ({ value }) => {
          calls.push(value);
          return value;
        },
      });
      const firstCallId = 'serialized-first';
      const secondCallId = 'serialized-second';
      const model = new ScriptedModel([
        modelResponse(
          response([
            functionCall(firstCallId, approvalTool.name, { value: 'first' }),
          ]),
        ),
        modelResponse(
          response([
            functionCall(secondCallId, approvalTool.name, { value: 'second' }),
          ]),
        ),
        modelResponse(
          response([
            functionCall(firstCallId, approvalTool.name, { value: 'first' }),
          ]),
        ),
        modelResponse(response([fakeModelMessage('done')])),
      ]);
      const agent = new Agent({
        name: 'SerializedReplayAgent',
        model,
        tools: [approvalTool],
      });
      const runner = new Runner();

      const firstInterruption = await runner.run(agent, 'start');
      firstInterruption.state.approve(firstInterruption.interruptions[0]);
      const secondInterruption = await runner.run(
        agent,
        firstInterruption.state,
      );
      expect(calls).toEqual(['first']);

      const serialized = secondInterruption.state.toJSON() as any;
      expect(serialized.$schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(
        serialized.context.approvalInvocations[0].invocations[firstCallId],
      ).toBeTypeOf('string');
      expect(
        serialized.completedToolInvocations[0].invocations[firstCallId],
      ).toBeTypeOf('string');
      if (legacySchemaVersion) {
        serialized.$schemaVersion = legacySchemaVersion;
        delete serialized.currentResponseGeneratedItemOwnership;
        delete serialized.context.approvalInvocations;
        delete serialized.completedToolInvocations;
        delete serialized.completedToolInvocationEvidence;
        delete serialized.ambiguousToolInvocationCallIds;
      }

      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );
      restored.approve(restored.getInterruptions()[0]);
      const result = await runner.run(agent, restored);

      expect(result.finalOutput).toBe('done');
      expect(calls).toEqual(['first', 'second']);
    },
  );

  it('rejects current state whose history completion is missing from replay records', async () => {
    const calls: string[] = [];
    const executedTool = tool({
      name: 'tampered_completion_tool',
      description: 'Runs before serialization pauses.',
      parameters: z.object({ value: z.string() }),
      execute: async ({ value }) => {
        calls.push(value);
        return value;
      },
    });
    const pauseTool = tool({
      name: 'tampered_completion_pause',
      description: 'Pauses after the first tool output.',
      parameters: z.object({}),
      needsApproval: true,
      execute: async () => 'unused',
    });
    const completedCallId = 'tampered-completed-call';
    const model = new ScriptedModel([
      modelResponse(
        response([
          functionCall(completedCallId, executedTool.name, { value: 'once' }),
        ]),
      ),
      modelResponse(
        response([functionCall('tampered-pause', pauseTool.name, {})]),
      ),
    ]);
    const agent = new Agent({
      name: 'TamperedCompletionAgent',
      model,
      tools: [executedTool, pauseTool],
    });
    const interrupted = await new Runner().run(agent, 'start');
    expect(calls).toEqual(['once']);
    interrupted.state._context.approveTool(
      new RunToolApprovalItem(
        shellCall('serialized-sticky-shell', ['echo source']),
        agent,
        'shell',
      ),
      { alwaysApprove: true },
    );
    const serialized = interrupted.state.toJSON() as any;
    delete serialized.completedToolInvocations[0].invocations[completedCallId];
    const overrideContext = new RunContext();

    await expect(
      RunState.fromStringWithContext(
        agent,
        JSON.stringify(serialized),
        overrideContext,
        { contextStrategy: 'merge' },
      ),
    ).rejects.toThrow(UserError);
    expect(calls).toEqual(['once']);
    expect(
      overrideContext.isToolApproved({
        toolName: 'shell',
        callId: 'unrelated-shell-call',
        functionTool: false,
      }),
    ).toBeUndefined();
  });

  it('rejects current state with completion authority absent from history', async () => {
    const agent = new Agent({ name: 'InjectedCompletionAgent' });
    const injectedCall = functionCall(
      'injected-completed-call',
      'injected_tool',
      { value: 'never-ran' },
    );
    const serialized = new RunState(
      new RunContext(),
      'start',
      agent,
      1,
    ).toJSON() as any;
    serialized.completedToolInvocations.push({
      agentIdentity:
        serialized.currentAgent.identity ?? serialized.currentAgent.name,
      invocations: {
        [injectedCall.callId]: getToolInvocationFingerprint(
          injectedCall.name,
          injectedCall,
        ),
      },
    });

    await expect(
      RunState.fromString(agent, JSON.stringify(serialized)),
    ).rejects.toThrow(UserError);
  });

  it('rejects history-filter evidence without a correlated completion', async () => {
    const localTool = tool({
      name: 'uncorrelated_filtered_tool',
      description: 'Provides an invocation without a committed result.',
      parameters: z.object({ value: z.string() }),
      execute: async () => 'unused',
    });
    const agent = new Agent({
      name: 'UncorrelatedFilteredEvidenceAgent',
      tools: [localTool],
    });
    const call = functionCall('uncorrelated-filtered-call', localTool.name, {
      value: 'never-ran',
    });
    const state = new RunState(new RunContext(), 'start', agent, 1);
    state._generatedItems.push(new RunToolCallItem(call, agent));
    const serialized = state.toJSON() as any;
    const serializedCall = serialized.generatedItems.pop();
    const agentIdentity =
      serialized.currentAgent.identity ?? serialized.currentAgent.name;
    serialized.completedToolInvocations.push({
      agentIdentity,
      invocations: {
        [call.callId]: getToolInvocationFingerprint(
          getFunctionToolStateKey(localTool)!,
          call,
        ),
      },
    });
    serialized.completedToolInvocationEvidence.push({
      agentIdentity,
      invocations: {
        [call.callId]: {
          fingerprint: getToolInvocationFingerprint(
            getFunctionToolStateKey(localTool)!,
            call,
          ),
          items: [{ item: serializedCall }, { item: serializedCall }],
        },
      },
    });

    await expect(
      RunState.fromString(agent, JSON.stringify(serialized)),
    ).rejects.toThrow(UserError);
  });

  it('rejects a hosted MCP completion with changed caller ownership', async () => {
    const agent = new Agent({ name: 'HostedMcpResultCallerAgent' });
    const callId = 'hosted-mcp-caller-binding';
    const caller = { type: 'program', callerId: 'program-a' } as const;
    const request = {
      type: 'hosted_tool_call',
      id: 'hosted-mcp-request-item',
      name: 'mcp_approval_request',
      arguments: '{"account":"123"}',
      status: 'in_progress',
      caller,
      providerData: {
        type: 'mcp_approval_request',
        id: callId,
        name: 'lookup',
        server_label: 'accounts',
      },
    } as protocol.HostedToolCallItem;
    const approvalResponse = {
      type: 'hosted_tool_call',
      id: 'hosted-mcp-response-item',
      name: 'mcp_approval_response',
      status: 'completed',
      caller,
      providerData: { approval_request_id: callId, approve: true },
    } as protocol.HostedToolCallItem;
    const state = new RunState(new RunContext(), 'start', agent, 1);
    state._generatedItems.push(
      new RunToolCallItem(request, agent),
      new RunToolCallItem(approvalResponse, agent),
    );
    const serialized = state.toJSON() as any;
    const serializedResponse = serialized.generatedItems.find(
      (item: any) => item.rawItem.name === 'mcp_approval_response',
    );
    serializedResponse.rawItem.caller = {
      type: 'program',
      callerId: 'program-b',
    };

    await expect(
      RunState.fromString(agent, JSON.stringify(serialized)),
    ).rejects.toThrow(UserError);
  });

  it.each(['tool identity', 'caller ownership'] as const)(
    'rejects current state whose function result changes %s',
    async (changedField) => {
      const functionTool = tool({
        name: 'result_binding_tool',
        description: 'Provides a canonical result identity.',
        parameters: z.object({}),
        execute: async () => 'unused',
      });
      const agent = new Agent({
        name: 'ResultBindingAgent',
        tools: [functionTool],
      });
      const call: protocol.FunctionCallItem = {
        ...functionCall('result-binding-call', functionTool.name, {}),
        caller: { type: 'program', callerId: 'owner-a' },
      };
      const result: protocol.FunctionCallResultItem = {
        type: 'function_call_result',
        name: functionTool.name,
        callId: call.callId,
        status: 'completed',
        caller: call.caller,
        output: 'done',
      };
      const state = new RunState(new RunContext(), 'start', agent, 1);
      state._generatedItems.push(
        new RunToolCallItem(call, agent),
        new RunToolCallOutputItem(result, agent, result.output),
      );
      const serialized = state.toJSON() as any;
      const serializedResult = serialized.generatedItems.find(
        (item: any) => item.rawItem.type === 'function_call_result',
      ).rawItem;
      if (changedField === 'tool identity') {
        serializedResult.name = 'different_tool';
      } else {
        serializedResult.caller = {
          type: 'program',
          callerId: 'owner-b',
        };
      }

      await expect(
        RunState.fromString(agent, JSON.stringify(serialized)),
      ).rejects.toThrow(UserError);
    },
  );

  it('round-trips the runtime-selected first local tool identity', async () => {
    const firstShell = shellTool({
      name: 'first_runtime_shell',
      shell: new FakeShell(),
    });
    const secondShell = shellTool({
      name: 'second_runtime_shell',
      shell: new FakeShell(),
    });
    const agent = new Agent({
      name: 'FirstShellSelectionAgent',
      tools: [firstShell, secondShell],
    });
    const call = shellCall('first-shell-selection', ['echo once']);
    const result: protocol.ShellCallResultItem = {
      type: 'shell_call_output',
      callId: call.callId,
      output: [
        { stdout: 'once', stderr: '', outcome: { type: 'exit', exitCode: 0 } },
      ],
    };
    const fingerprint = getToolInvocationFingerprint(firstShell.name, call);
    const state = new RunState(new RunContext(), 'start', agent, 1);
    state._generatedItems.push(
      new RunToolCallItem(call, agent),
      new RunToolCallOutputItem(result, agent, result.output),
    );
    state._completedToolInvocations.set(
      agent,
      new Map([[call.callId, fingerprint]]),
    );

    const restored = await RunState.fromString(agent, state.toString());
    expect(
      restored._preflightToolInvocation(agent, call.callId, fingerprint),
    ).toBe(true);
  });

  it('round-trips an execution-time injected local tool identity', async () => {
    const agent = new Agent({ name: 'InjectedApplyPatchAgent' });
    const call = applyPatchCall('injected-apply-patch-call');
    const result: protocol.ApplyPatchCallResultItem = {
      type: 'apply_patch_call_output',
      callId: call.callId,
      status: 'completed',
      output: 'Done!',
    };
    const fingerprint = getToolInvocationFingerprint('apply_patch', call);
    const state = new RunState(new RunContext(), 'start', agent, 1);
    const items = [
      new RunToolCallItem(call, agent),
      new RunToolCallOutputItem(result, agent, result.output ?? ''),
    ];
    state._observeToolInvocation(agent, call.callId, fingerprint);
    state._commitToolInvocations(items);
    state._generatedItems.push(...items);

    const restored = await RunState.fromString(agent, state.toString());
    expect(
      restored._preflightToolInvocation(agent, call.callId, fingerprint),
    ).toBe(true);
  });

  it('references retained generated items without duplicating large tool payloads', async () => {
    const localTool = tool({
      name: 'large_output_tool',
      description: 'Produces a large result.',
      parameters: z.object({}),
      execute: async () => 'unused',
    });
    const agent = new Agent({
      name: 'LargeOutputEvidenceAgent',
      tools: [localTool],
    });
    const call = functionCall('large-output-call', localTool.name, {});
    const output = 'x'.repeat(10_000);
    const result: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      name: localTool.name,
      callId: call.callId,
      status: 'completed',
      output,
    };
    const state = new RunState(new RunContext(), 'start', agent, 1);
    state._generatedItems.push(
      new RunToolCallItem(call, agent),
      new RunToolCallOutputItem(result, agent, output),
    );

    const serialized = state.toJSON() as any;
    const evidence =
      serialized.completedToolInvocationEvidence[0].invocations[call.callId];
    expect(evidence.items).toEqual([
      { generatedItemIndex: 0 },
      { generatedItemIndex: 1 },
    ]);
    expect(JSON.stringify(evidence)).not.toContain(output);

    const restored = await RunState.fromString(
      agent,
      JSON.stringify(serialized),
    );
    expect(
      restored._preflightToolInvocation(
        agent,
        call.callId,
        getToolInvocationFingerprint(getFunctionToolStateKey(localTool)!, call),
      ),
    ).toBe(true);

    evidence.items[0].generatedItemIndex = 999;
    await expect(
      RunState.fromString(agent, JSON.stringify(serialized)),
    ).rejects.toThrow(UserError);
  });

  it('preserves same-turn completion authority through a handoff filter', async () => {
    const calls: string[] = [];
    const executedTool = tool({
      name: 'filtered_completion_tool',
      description: 'Runs before a handoff filters its history.',
      parameters: z.object({ value: z.string() }),
      execute: async ({ value }) => {
        calls.push(value);
        return value;
      },
    });
    const pauseTool = tool({
      name: 'filtered_completion_pause',
      description: 'Pauses after the filtered handoff.',
      parameters: z.object({}),
      needsApproval: true,
      execute: async () => 'unused',
    });
    const completedCallId = 'filtered-completed-call';
    const completedCall = functionCall(completedCallId, executedTool.name, {
      value: 'once',
    });
    const targetAgent = new Agent({
      name: 'FilteredCompletionTarget',
      model: new ScriptedModel([
        modelResponse(
          response([
            functionCall('filtered-completion-pause', pauseTool.name, {}),
          ]),
        ),
      ]),
      tools: [pauseTool],
    });
    const transfer = handoff(targetAgent, {
      inputFilter: (data) => ({
        ...data,
        newItems: [],
      }),
    });
    const sourceAgent = new Agent({
      name: 'FilteredCompletionSource',
      model: new ScriptedModel([
        modelResponse(
          response([
            completedCall,
            functionCall('filtered-completion-handoff', transfer.toolName, {}),
          ]),
        ),
      ]),
      tools: [executedTool],
      handoffs: [transfer],
    });

    const interrupted = await new Runner().run(sourceAgent, 'start');

    expect(calls).toEqual(['once']);
    expect(
      interrupted.state._generatedItems.some(
        (item) =>
          'callId' in item.rawItem && item.rawItem.callId === completedCallId,
      ),
    ).toBe(false);
    const serialized = interrupted.state.toJSON() as any;
    const evidenceItems =
      serialized.completedToolInvocationEvidence[0].invocations[completedCallId]
        .items;
    expect(
      evidenceItems.map((reference: any) => reference.item.rawItem.type),
    ).toEqual(['function_call', 'function_call_result']);
    const restored = await RunState.fromString(
      sourceAgent,
      JSON.stringify(serialized),
    );
    expect(
      restored._preflightToolInvocation(
        sourceAgent,
        completedCallId,
        getToolInvocationFingerprint(
          getFunctionToolStateKey(executedTool)!,
          completedCall,
        ),
      ),
    ).toBe(true);
    expect(calls).toEqual(['once']);
  });

  it('binds local shell approvals to the approved command', async () => {
    const shell = new FakeShell();
    const localShell = shellTool({ shell, needsApproval: true });
    const callId = 'reused-shell';
    const model = new ScriptedModel([
      modelResponse(response([shellCall(callId, ['echo safe'])])),
      modelResponse(response([shellCall(callId, ['echo changed'])])),
    ]);
    const agent = new Agent({
      name: 'ChangedShellAgent',
      model,
      tools: [localShell],
    });
    const runner = new Runner();

    const interrupted = await runner.run(agent, 'start');
    interrupted.state.approve(interrupted.interruptions[0]);

    await expect(runner.run(agent, interrupted.state)).rejects.toThrow(
      ModelBehaviorError,
    );
    expect(shell.calls).toEqual([{ commands: ['echo safe'] }]);
  });

  it('reconstructs unapproved shell completion from schema 1.17 state', async () => {
    const shell = new FakeShell();
    const localShell = shellTool({ shell });
    const pauseTool = tool({
      name: 'pause_for_serialization',
      description: 'Creates a resumable state after shell execution.',
      parameters: z.object({}),
      needsApproval: true,
      execute: async () => 'approved',
    });
    const shellCallId = 'legacy-shell';
    const model = new ScriptedModel([
      modelResponse(response([shellCall(shellCallId, ['echo once'])])),
      modelResponse(response([functionCall('pause-call', pauseTool.name, {})])),
      modelResponse(response([shellCall(shellCallId, ['echo once'])])),
      modelResponse(response([fakeModelMessage('done')])),
    ]);
    const agent = new Agent({
      name: 'LegacyShellReplayAgent',
      model,
      tools: [localShell, pauseTool],
    });
    const runner = new Runner();

    const interrupted = await runner.run(agent, 'start');
    expect(shell.calls).toEqual([{ commands: ['echo once'] }]);
    const serialized = interrupted.state.toJSON() as any;
    serialized.$schemaVersion = '1.17';
    delete serialized.currentResponseGeneratedItemOwnership;
    for (const item of serialized.generatedItems) {
      if (item.type === 'tool_call_output_item') {
        item.output = JSON.stringify(item.output);
      }
    }
    delete serialized.context.approvalInvocations;
    delete serialized.completedToolInvocations;

    const restored = await RunState.fromString(
      agent,
      JSON.stringify(serialized),
    );
    restored.approve(restored.getInterruptions()[0]);
    const result = await runner.run(agent, restored);

    expect(result.finalOutput).toBe('done');
    expect(shell.calls).toEqual([{ commands: ['echo once'] }]);
  });

  it('does not let a later legacy approval rename an earlier completion', async () => {
    const firstShell = shellTool({
      name: 'first_shell',
      shell: new FakeShell(),
    });
    const secondShell = shellTool({
      name: 'second_shell',
      shell: new FakeShell(),
    });
    const agent = new Agent({
      name: 'OrderedLegacyShellAgent',
      tools: [firstShell, secondShell],
    });
    const callId = 'legacy-reused-shell';
    const firstCall = shellCall(callId, ['echo once']);
    const secondCall = shellCall(callId, ['echo once']);
    const output: protocol.ShellCallResultItem = {
      type: 'shell_call_output',
      callId,
      output: [
        { stdout: 'once', stderr: '', outcome: { type: 'exit', exitCode: 0 } },
      ],
    };
    const state = new RunState(new RunContext(), 'start', agent, 1);
    state._generatedItems.push(
      new RunToolCallItem(firstCall, agent),
      new RunToolApprovalItem(firstCall, agent, firstShell.name),
      new RunToolCallOutputItem(output, agent, output.output),
      new RunToolCallItem(secondCall, agent),
      new RunToolApprovalItem(secondCall, agent, secondShell.name),
    );
    const serialized = state.toJSON() as any;
    serialized.$schemaVersion = '1.17';
    for (const item of serialized.generatedItems) {
      if (item.type === 'tool_call_output_item') {
        item.output = JSON.stringify(item.output);
      }
    }
    delete serialized.context.approvalInvocations;
    delete serialized.completedToolInvocations;

    const restored = await RunState.fromString(
      agent,
      JSON.stringify(serialized),
    );
    const secondFingerprint = getToolInvocationFingerprint(
      secondShell.name,
      secondCall,
    );

    expect(() =>
      restored._observeToolInvocation(agent, callId, secondFingerprint),
    ).toThrow(ModelBehaviorError);

    const upgraded = await RunState.fromString(agent, restored.toString());
    expect(() =>
      upgraded._observeToolInvocation(agent, callId, secondFingerprint),
    ).toThrow(ModelBehaviorError);
  });

  it('reconstructs unapproved computer completion from schema 1.17 state', async () => {
    const computer = new FakeComputer();
    const screenshot = vi.spyOn(computer, 'screenshot');
    const localComputer = computerTool({ computer });
    const pauseTool = tool({
      name: 'pause_after_computer',
      description: 'Creates a resumable state after computer execution.',
      parameters: z.object({}),
      needsApproval: true,
      execute: async () => 'approved',
    });
    const callId = 'legacy-computer';
    const model = new ScriptedModel([
      modelResponse(response([computerCall(callId)])),
      modelResponse(
        response([functionCall('pause-computer', pauseTool.name, {})]),
      ),
      modelResponse(response([computerCall(callId)])),
      modelResponse(response([fakeModelMessage('done')])),
    ]);
    const agent = new Agent({
      name: 'LegacyComputerReplayAgent',
      model,
      tools: [localComputer, pauseTool],
    });
    const runner = new Runner();

    const interrupted = await runner.run(agent, 'start');
    expect(screenshot).toHaveBeenCalledTimes(1);
    const serialized = interrupted.state.toJSON() as any;
    serialized.$schemaVersion = '1.17';
    delete serialized.currentResponseGeneratedItemOwnership;
    delete serialized.context.approvalInvocations;
    delete serialized.completedToolInvocations;

    const restored = await RunState.fromString(
      agent,
      JSON.stringify(serialized),
    );
    restored.approve(restored.getInterruptions()[0]);
    const result = await runner.run(agent, restored);

    expect(result.finalOutput).toBe('done');
    expect(screenshot).toHaveBeenCalledTimes(1);
  });

  it('reconstructs unapproved apply-patch completion from schema 1.17 state', async () => {
    const editor = new FakeEditor();
    const localApplyPatch = applyPatchTool({ editor });
    const pauseTool = tool({
      name: 'pause_after_patch',
      description: 'Creates a resumable state after patch execution.',
      parameters: z.object({}),
      needsApproval: true,
      execute: async () => 'approved',
    });
    const callId = 'legacy-apply-patch';
    const model = new ScriptedModel([
      modelResponse(response([applyPatchCall(callId)])),
      modelResponse(
        response([functionCall('pause-patch', pauseTool.name, {})]),
      ),
      modelResponse(response([applyPatchCall(callId)])),
      modelResponse(response([fakeModelMessage('done')])),
    ]);
    const agent = new Agent({
      name: 'LegacyApplyPatchReplayAgent',
      model,
      tools: [localApplyPatch, pauseTool],
    });
    const runner = new Runner();

    const interrupted = await runner.run(agent, 'start');
    expect(editor.operations).toHaveLength(1);
    const serialized = interrupted.state.toJSON() as any;
    serialized.$schemaVersion = '1.17';
    delete serialized.currentResponseGeneratedItemOwnership;
    delete serialized.context.approvalInvocations;
    delete serialized.completedToolInvocations;

    const restored = await RunState.fromString(
      agent,
      JSON.stringify(serialized),
    );
    restored.approve(restored.getInterruptions()[0]);
    const result = await runner.run(agent, restored);

    expect(result.finalOutput).toBe('done');
    expect(editor.operations).toHaveLength(1);
  });
});
