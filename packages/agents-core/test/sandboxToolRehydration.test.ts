import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Agent } from '../src/agent';
import { RunContext } from '../src/runContext';
import {
  getSerializedApplyPatchToolPlaceholder,
  getSerializedComputerToolPlaceholder,
  getSerializedFunctionToolPlaceholder,
  getSerializedShellToolPlaceholder,
  processedResponseRequiresExecutionToolRehydration,
} from '../src/sandbox/runtime/toolRehydration';
import { SandboxAgent } from '../src/sandbox';
import {
  getFunctionToolQualifiedName,
  resolveFunctionToolCallName,
} from '../src/toolIdentity';
import { shellTool, tool } from '../src/tool';
import type * as protocol from '../src/types/protocol';
import { FakeShell } from './stubs';

const functionCall: protocol.FunctionCallItem = {
  type: 'function_call',
  callId: 'call_lookup_customer',
  name: 'lookup_customer',
  namespace: 'crm',
  arguments: '{}',
  status: 'completed',
};

describe('serialized sandbox execution tool placeholders', () => {
  it('restores namespaced function metadata with safe defaults', async () => {
    const agent = new SandboxAgent({ name: 'Sandbox' });
    const placeholder = getSerializedFunctionToolPlaceholder({
      agent,
      baseAgentTools: [],
      serializedTool: { type: 'function' },
      toolCall: functionCall,
      toolIdentity: 'crm.lookup_customer',
      allowSerializedExecutionToolPlaceholder: true,
    });

    expect(placeholder).toMatchObject({
      type: 'function',
      name: 'lookup_customer',
      description: 'Serialized execution-time tool lookup_customer.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
      deferLoading: false,
    });
    expect(getFunctionToolQualifiedName(placeholder!)).toBe(
      'crm.lookup_customer',
    );
    expect(
      resolveFunctionToolCallName(
        functionCall,
        new Map([['crm.lookup_customer', placeholder!]]),
      ),
    ).toBe('crm.lookup_customer');
    await expect(placeholder!.invoke(new RunContext(), '{}')).rejects.toThrow(
      'Function tool crm.lookup_customer was restored from serialized execution-time metadata without an executable handler.',
    );
    const runContext = new RunContext();
    await expect(placeholder!.needsApproval(runContext, '{}')).resolves.toBe(
      false,
    );
    await expect(placeholder!.isEnabled(runContext, agent)).resolves.toBe(true);
  });

  it('preserves serialized function metadata when it is usable', () => {
    const parameters = {
      type: 'object' as const,
      properties: { customerId: { type: 'string' as const } },
      required: ['customerId'],
      additionalProperties: false,
    };
    const placeholder = getSerializedFunctionToolPlaceholder({
      agent: new SandboxAgent({ name: 'Sandbox' }),
      baseAgentTools: [],
      serializedTool: {
        type: 'function',
        name: 'serialized_lookup',
        description: 'Serialized lookup.',
        parameters,
        strict: false,
        deferLoading: true,
      },
      toolCall: {
        ...functionCall,
        namespace: 'serialized_lookup',
      },
      toolIdentity: 'serialized_lookup',
      allowSerializedExecutionToolPlaceholder: true,
    });

    expect(placeholder).toMatchObject({
      name: 'serialized_lookup',
      description: 'Serialized lookup.',
      parameters,
      strict: false,
      deferLoading: true,
    });
    expect(getFunctionToolQualifiedName(placeholder!)).toBe(
      'serialized_lookup',
    );
  });

  it('restores computer, shell, and apply_patch placeholders that fail safely', async () => {
    const agent = new SandboxAgent({ name: 'Sandbox' });
    const computer = getSerializedComputerToolPlaceholder({
      agent,
      baseAgentTools: [],
      serializedTool: { type: 'computer', name: 'browser' },
      toolName: 'computer',
      allowSerializedExecutionToolPlaceholder: true,
    });
    const shell = getSerializedShellToolPlaceholder({
      agent,
      baseAgentTools: [],
      serializedTool: { type: 'shell', name: 'terminal' },
      toolName: 'shell',
      allowSerializedExecutionToolPlaceholder: true,
    });
    const applyPatch = getSerializedApplyPatchToolPlaceholder({
      agent,
      baseAgentTools: [],
      serializedTool: { type: 'apply_patch', name: 'editor' },
      toolName: 'apply_patch',
      allowSerializedExecutionToolPlaceholder: true,
    });

    expect(computer).toMatchObject({
      type: 'computer',
      name: 'browser',
      computer: {
        environment: 'browser',
        dimensions: [1, 1],
      },
    });
    await expect((computer!.computer as any).screenshot()).rejects.toThrow(
      'Computer tool browser was restored from serialized execution-time metadata without an executable handler.',
    );
    await expect(
      computer!.needsApproval(new RunContext(), { type: 'screenshot' }),
    ).resolves.toBe(false);

    expect(shell).toMatchObject({
      type: 'shell',
      name: 'terminal',
      environment: { type: 'local' },
    });
    await expect(
      (shell!.shell as any).run({ commands: ['pwd'] }),
    ).rejects.toThrow(
      'Shell tool terminal was restored from serialized execution-time metadata without an executable handler.',
    );
    await expect(
      shell!.needsApproval(new RunContext(), { commands: ['pwd'] }),
    ).resolves.toBe(false);

    expect(applyPatch).toMatchObject({
      type: 'apply_patch',
      name: 'editor',
    });
    await expect(
      (applyPatch!.editor as any).createFile({
        type: 'create_file',
        path: 'notes.txt',
        diff: '+hello\n',
      }),
    ).rejects.toThrow(
      'Apply patch tool editor was restored from serialized execution-time metadata without an executable handler.',
    );
    await expect(
      applyPatch!.needsApproval(new RunContext(), {
        type: 'delete_file',
        path: 'notes.txt',
      }),
    ).resolves.toBe(false);
  });

  it('detects every serialized execution tool placeholder location', () => {
    const agent = new SandboxAgent({ name: 'Sandbox' });
    const functionPlaceholder = getSerializedFunctionToolPlaceholder({
      agent,
      baseAgentTools: [],
      serializedTool: { type: 'function' },
      toolCall: functionCall,
      toolIdentity: 'crm.lookup_customer',
      allowSerializedExecutionToolPlaceholder: true,
    })!;
    const computerPlaceholder = getSerializedComputerToolPlaceholder({
      agent,
      baseAgentTools: [],
      serializedTool: { type: 'computer' },
      toolName: 'computer',
      allowSerializedExecutionToolPlaceholder: true,
    })!;
    const shellPlaceholder = getSerializedShellToolPlaceholder({
      agent,
      baseAgentTools: [],
      serializedTool: { type: 'shell' },
      toolName: 'shell',
      allowSerializedExecutionToolPlaceholder: true,
    })!;
    const applyPatchPlaceholder = getSerializedApplyPatchToolPlaceholder({
      agent,
      baseAgentTools: [],
      serializedTool: { type: 'apply_patch' },
      toolName: 'apply_patch',
      allowSerializedExecutionToolPlaceholder: true,
    })!;
    const base = {
      newItems: [],
      functions: [],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
      hasToolsOrApprovalsToRun: () => true,
    };

    expect(processedResponseRequiresExecutionToolRehydration(undefined)).toBe(
      false,
    );
    expect(
      processedResponseRequiresExecutionToolRehydration({
        ...base,
        functions: [{ toolCall: functionCall, tool: functionPlaceholder }],
      }),
    ).toBe(true);
    expect(
      processedResponseRequiresExecutionToolRehydration({
        ...base,
        computerActions: [
          {
            toolCall: {
              type: 'computer_call',
              callId: 'computer_call',
              status: 'completed',
              action: { type: 'screenshot' },
            },
            computer: computerPlaceholder,
          },
        ],
      }),
    ).toBe(true);
    expect(
      processedResponseRequiresExecutionToolRehydration({
        ...base,
        shellActions: [
          {
            toolCall: {
              type: 'shell_call',
              callId: 'shell_call',
              status: 'completed',
              action: { commands: ['pwd'] },
            },
            shell: shellPlaceholder,
          },
        ],
      }),
    ).toBe(true);
    expect(
      processedResponseRequiresExecutionToolRehydration({
        ...base,
        applyPatchActions: [
          {
            toolCall: {
              type: 'apply_patch_call',
              callId: 'apply_patch_call',
              status: 'completed',
              operation: {
                type: 'delete_file',
                path: 'notes.txt',
              },
            },
            applyPatch: applyPatchPlaceholder,
          },
        ],
      }),
    ).toBe(true);
    expect(processedResponseRequiresExecutionToolRehydration(base)).toBe(false);
  });

  it('does not replace configured, disabled, mismatched, or non-sandbox tools', () => {
    const configuredFunction = tool({
      name: 'lookup_customer',
      description: 'Looks up a customer.',
      parameters: z.object({}),
      execute: async () => 'configured',
    });
    const configuredShell = shellTool({ shell: new FakeShell() });
    const sandboxAgent = new SandboxAgent({ name: 'Sandbox' });

    expect(
      getSerializedFunctionToolPlaceholder({
        agent: sandboxAgent,
        baseAgentTools: [configuredFunction],
        serializedTool: { type: 'function' },
        toolCall: { ...functionCall, namespace: 'lookup_customer' },
        toolIdentity: 'lookup_customer',
        allowSerializedExecutionToolPlaceholder: true,
      }),
    ).toBeUndefined();
    expect(
      getSerializedShellToolPlaceholder({
        agent: sandboxAgent,
        baseAgentTools: [configuredShell],
        serializedTool: { type: 'shell' },
        toolName: configuredShell.name,
        allowSerializedExecutionToolPlaceholder: true,
      }),
    ).toBeUndefined();
    expect(
      getSerializedFunctionToolPlaceholder({
        agent: sandboxAgent,
        baseAgentTools: [],
        serializedTool: { type: 'computer' },
        toolCall: functionCall,
        toolIdentity: 'crm.lookup_customer',
        allowSerializedExecutionToolPlaceholder: true,
      }),
    ).toBeUndefined();
    expect(
      getSerializedFunctionToolPlaceholder({
        agent: sandboxAgent,
        baseAgentTools: [],
        serializedTool: { type: 'function' },
        toolCall: functionCall,
        toolIdentity: 'crm.lookup_customer',
        allowSerializedExecutionToolPlaceholder: false,
      }),
    ).toBeUndefined();
    expect(
      getSerializedFunctionToolPlaceholder({
        agent: new Agent({ name: 'Regular' }),
        baseAgentTools: [],
        serializedTool: { type: 'function' },
        toolCall: functionCall,
        toolIdentity: 'crm.lookup_customer',
        allowSerializedExecutionToolPlaceholder: true,
      }),
    ).toBeUndefined();
  });
});
