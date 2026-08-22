import { describe, expect, it } from 'vitest';

import { Agent } from '../../src/agent';
import {
  RunCompactionItem,
  RunMessageOutputItem,
  RunReasoningItem,
  RunToolCallItem,
  RunToolCallOutputItem,
} from '../../src/items';
import {
  deduplicateAgentInputItemsPreferringLatest,
  dropOrphanToolCalls,
  extractOutputItemsFromRunItems,
  prepareModelInputItems,
} from '../../src/runner/items';
import type { AgentInputItem } from '../../src/types';
import * as protocol from '../../src/types/protocol';

describe('deduplicateAgentInputItemsPreferringLatest', () => {
  it('keeps the latest duplicate call at the earliest causal position', () => {
    const oldCall: protocol.FunctionCallItem = {
      type: 'function_call',
      callId: 'call_ordered',
      name: 'lookup',
      arguments: '{"version":"old"}',
    };
    const output: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      callId: 'call_ordered',
      name: 'lookup',
      status: 'completed',
      output: 'done',
    };
    const newCall: protocol.FunctionCallItem = {
      ...oldCall,
      arguments: '{"version":"new"}',
    };

    expect(
      deduplicateAgentInputItemsPreferringLatest([oldCall, output, newCall]),
    ).toEqual([newCall, output]);
  });

  it('prefers call correlation over mixed item ids', () => {
    const oldCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'item_old',
      callId: 'call_mixed_identity',
      name: 'lookup',
      arguments: '{"version":"old"}',
    };
    const output: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      callId: 'call_mixed_identity',
      name: 'lookup',
      status: 'completed',
      output: 'done',
    };
    const newCall: protocol.FunctionCallItem = {
      ...oldCall,
      id: undefined,
      arguments: '{"version":"new"}',
    };

    expect(
      deduplicateAgentInputItemsPreferringLatest([oldCall, output, newCall]),
    ).toEqual([newCall, output]);
  });

  it('prefers tool-search call correlation over item ids', () => {
    const oldOutput: protocol.ToolSearchOutputItem = {
      type: 'tool_search_output',
      id: 'item_old',
      execution: 'client',
      status: 'in_progress',
      tools: [],
      providerData: {
        type: 'tool_search_output',
        call_id: 'call_shared',
        execution: 'client',
      },
    };
    const newOutput: protocol.ToolSearchOutputItem = {
      ...oldOutput,
      id: 'item_new',
      status: 'completed',
    };

    expect(
      deduplicateAgentInputItemsPreferringLatest([oldOutput, newOutput]),
    ).toEqual([newOutput]);
  });

  it('keeps client tool-search calls before their required output', () => {
    const oldCall: protocol.ToolSearchCallItem = {
      type: 'tool_search_call',
      callId: 'call_client_search',
      execution: 'client',
      arguments: { query: 'old' },
    };
    const output: protocol.ToolSearchOutputItem = {
      type: 'tool_search_output',
      callId: 'call_client_search',
      execution: 'client',
      status: 'completed',
      tools: [],
    };
    const newCall: protocol.ToolSearchCallItem = {
      ...oldCall,
      arguments: { query: 'new' },
    };

    expect(
      deduplicateAgentInputItemsPreferringLatest([oldCall, output, newCall]),
    ).toEqual([newCall, output]);
  });

  it('keeps server tool-search calls before their output', () => {
    const oldCall: protocol.ToolSearchCallItem = {
      type: 'tool_search_call',
      callId: 'call_server_search',
      execution: 'server',
      arguments: { query: 'old' },
      status: 'in_progress',
    };
    const output: protocol.ToolSearchOutputItem = {
      type: 'tool_search_output',
      callId: 'call_server_search',
      execution: 'server',
      status: 'completed',
      tools: [],
    };
    const newCall: protocol.ToolSearchCallItem = {
      ...oldCall,
      arguments: { query: 'new' },
      status: 'completed',
    };

    expect(
      deduplicateAgentInputItemsPreferringLatest([oldCall, output, newCall]),
    ).toEqual([newCall, output]);
  });

  it('keeps hosted tool calls at their earliest causal position', () => {
    const oldCall: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      id: 'hosted_shared',
      name: 'web_search_call',
      status: 'in_progress',
      providerData: { type: 'web_search' },
    };
    const message: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'searching',
    };
    const newCall: protocol.HostedToolCallItem = {
      ...oldCall,
      status: 'completed',
      providerData: { type: 'web_search_call' },
    };

    expect(
      deduplicateAgentInputItemsPreferringLatest([oldCall, message, newCall]),
    ).toEqual([newCall, message]);
  });

  it('keeps the latest duplicate output at its latest position', () => {
    const oldOutput: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      callId: 'call_output',
      name: 'lookup',
      status: 'completed',
      output: 'old',
    };
    const message: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'next',
    };
    const newOutput: protocol.FunctionCallResultItem = {
      ...oldOutput,
      output: 'new',
    };

    expect(
      deduplicateAgentInputItemsPreferringLatest([
        oldOutput,
        message,
        newOutput,
      ]),
    ).toEqual([message, newOutput]);
  });

  it('keeps latest reasoning before its required follower', () => {
    const oldReasoning: protocol.ReasoningItem = {
      type: 'reasoning',
      id: 'rs_ordered',
      content: [{ type: 'input_text', text: 'old' }],
    };
    const call: protocol.FunctionCallItem = {
      type: 'function_call',
      callId: 'call_after_reasoning',
      name: 'lookup',
      arguments: '{}',
    };
    const newReasoning: protocol.ReasoningItem = {
      ...oldReasoning,
      content: [{ type: 'input_text', text: 'new' }],
    };

    expect(
      deduplicateAgentInputItemsPreferringLatest([
        oldReasoning,
        call,
        newReasoning,
      ]),
    ).toEqual([newReasoning, call]);
  });

  it('keeps latest compaction at its earliest causal position', () => {
    const oldCompaction: protocol.CompactionItem = {
      type: 'compaction',
      id: 'compaction_ordered',
      encrypted_content: 'old',
    };
    const message: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'next',
    };
    const newCompaction: protocol.CompactionItem = {
      ...oldCompaction,
      encrypted_content: 'new',
    };

    expect(
      deduplicateAgentInputItemsPreferringLatest([
        oldCompaction,
        message,
        newCompaction,
      ]),
    ).toEqual([newCompaction, message]);
  });

  it('keeps latest MCP approval request before its response', () => {
    const oldRequest: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      id: 'approval_ordered',
      name: 'mcp_approval_request',
      status: 'in_progress',
      providerData: {
        type: 'mcp_approval_request',
        id: 'approval_ordered',
        arguments: 'old',
      },
    };
    const response: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      name: 'mcp_approval_response',
      status: 'completed',
      providerData: {
        type: 'mcp_approval_response',
        approval_request_id: 'approval_ordered',
        approve: true,
      },
    };
    const newRequest: protocol.HostedToolCallItem = {
      ...oldRequest,
      providerData: { ...oldRequest.providerData, arguments: 'new' },
    };

    expect(
      deduplicateAgentInputItemsPreferringLatest([
        oldRequest,
        response,
        newRequest,
      ]),
    ).toEqual([newRequest, response]);
  });

  it('keeps the latest MCP approval response at its latest position', () => {
    const oldResponse: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      name: 'mcp_approval_response',
      status: 'in_progress',
      providerData: {
        type: 'mcp_approval_response',
        approval_request_id: 'approval_response_ordered',
        approve: false,
      },
    };
    const message: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'approval processed',
    };
    const newResponse: protocol.HostedToolCallItem = {
      ...oldResponse,
      status: 'completed',
      providerData: { ...oldResponse.providerData, approve: true },
    };

    expect(
      deduplicateAgentInputItemsPreferringLatest([
        oldResponse,
        message,
        newResponse,
      ]),
    ).toEqual([message, newResponse]);
  });

  it('preserves unique items and duplicate messages without stable identity', () => {
    const duplicateMessage: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'repeat me',
    };
    const uniqueCall: protocol.FunctionCallItem = {
      type: 'function_call',
      callId: 'call_unique',
      name: 'lookup',
      arguments: '{}',
    };
    const items = [duplicateMessage, uniqueCall, duplicateMessage];

    expect(deduplicateAgentInputItemsPreferringLatest(items)).toEqual(items);
  });

  it('preserves duplicate calls and outputs with empty correlations', () => {
    const oldCall: protocol.FunctionCallItem = {
      type: 'function_call',
      callId: '',
      name: 'lookup',
      arguments: '{"value":"old"}',
    };
    const newCall: protocol.FunctionCallItem = {
      ...oldCall,
      arguments: '{"value":"new"}',
    };
    const oldOutput: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      callId: '',
      name: 'lookup',
      status: 'completed',
      output: 'old',
    };
    const newOutput: protocol.FunctionCallResultItem = {
      ...oldOutput,
      output: 'new',
    };
    const items = [oldCall, oldOutput, newCall, newOutput];

    expect(deduplicateAgentInputItemsPreferringLatest(items)).toEqual(items);
  });

  it('preserves duplicate compaction items without stable identity', () => {
    const oldCompaction: protocol.CompactionItem = {
      type: 'compaction',
      encrypted_content: 'old',
    };
    const newCompaction: protocol.CompactionItem = {
      type: 'compaction',
      encrypted_content: 'new',
    };
    const items = [oldCompaction, newCompaction];

    expect(deduplicateAgentInputItemsPreferringLatest(items)).toEqual(items);
  });
});

describe('prepareModelInputItems', () => {
  it('drops orphan generated hosted shell calls', () => {
    const agent = new Agent({ name: 'HelperAgent' });
    const shellCall = new RunToolCallItem(
      {
        type: 'shell_call',
        callId: 'shell_1',
        status: 'completed',
        action: { commands: ['echo hi'] },
      } satisfies protocol.ShellCallItem,
      agent,
    );

    const prepared = prepareModelInputItems('hello', [shellCall]);

    expect(prepared).toEqual([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
    ]);
  });

  it('drops orphan calls before considering pre-compaction results', () => {
    const agent = new Agent({ name: 'HelperAgent' });
    const callId = 'call_reused_after_compaction';
    const oldResult = new RunToolCallOutputItem(
      {
        type: 'function_call_result',
        name: 'reused_tool',
        callId,
        output: 'old result',
        status: 'completed',
      },
      agent,
      'old result',
    );
    const compaction = {
      type: 'compaction',
      id: 'cmp_reused_call',
      encrypted_content: 'ciphertext',
    } satisfies protocol.CompactionItem;
    const newCall = new RunToolCallItem(
      {
        type: 'function_call',
        name: 'reused_tool',
        callId,
        arguments: '{}',
        status: 'completed',
      },
      agent,
    );

    const prepared = prepareModelInputItems('old input', [
      oldResult,
      new RunCompactionItem(compaction, agent),
      newCall,
    ]);

    expect(prepared).toEqual([compaction]);
  });

  it('drops orphan generated programs and keeps completed programs', () => {
    const agent = new Agent({ name: 'HelperAgent' });
    const orphanProgram = new RunToolCallItem(
      {
        type: 'program',
        callId: 'program_orphan',
        code: 'return "orphan";',
        fingerprint: 'fingerprint:orphan',
      } satisfies protocol.ProgramCallItem,
      agent,
    );
    const completedProgram = new RunToolCallItem(
      {
        type: 'program',
        callId: 'program_completed',
        code: 'return "completed";',
        fingerprint: 'fingerprint:completed',
      } satisfies protocol.ProgramCallItem,
      agent,
    );
    const programOutput = new RunToolCallOutputItem(
      {
        type: 'program_output',
        callId: 'program_completed',
        output: 'completed',
        status: 'completed',
      } satisfies protocol.ProgramCallResultItem,
      agent,
      'completed',
    );

    const prepared = prepareModelInputItems('hello', [
      orphanProgram,
      completedProgram,
      programOutput,
    ]);

    expect(prepared).toEqual([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      completedProgram.rawItem,
      programOutput.rawItem,
    ]);
  });

  it('keeps programs that are waiting on program-owned tool calls', () => {
    const agent = new Agent({ name: 'HelperAgent' });
    const program = new RunToolCallItem(
      {
        type: 'program',
        callId: 'program_pending',
        code: 'return await tools.lookup({ key: "value" });',
        fingerprint: 'fingerprint:pending',
      } satisfies protocol.ProgramCallItem,
      agent,
    );
    const functionCall = new RunToolCallItem(
      {
        type: 'function_call',
        callId: 'lookup_pending',
        name: 'lookup',
        arguments: '{"key":"value"}',
        caller: { type: 'program', callerId: 'program_pending' },
      } satisfies protocol.FunctionCallItem,
      agent,
    );
    const functionOutput = new RunToolCallOutputItem(
      {
        type: 'function_call_result',
        callId: 'lookup_pending',
        name: 'lookup',
        status: 'completed',
        output: 'value',
        caller: { type: 'program', callerId: 'program_pending' },
      } satisfies protocol.FunctionCallResultItem,
      agent,
      'value',
    );

    const prepared = prepareModelInputItems('hello', [
      program,
      functionCall,
      functionOutput,
    ]);

    expect(prepared).toEqual([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      program.rawItem,
      functionCall.rawItem,
      functionOutput.rawItem,
    ]);
  });

  it('keeps generated pending hosted shell calls without outputs', () => {
    const agent = new Agent({ name: 'HelperAgent' });
    const shellCall = new RunToolCallItem(
      {
        type: 'shell_call',
        callId: 'shell_1',
        status: 'in_progress',
        action: { commands: ['echo hi'] },
      } satisfies protocol.ShellCallItem,
      agent,
    );

    const prepared = prepareModelInputItems('hello', [shellCall]);

    expect(prepared).toEqual([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      shellCall.rawItem,
    ]);
  });

  it('preserves caller-provided pending shell calls while pruning generated orphans', () => {
    const agent = new Agent({ name: 'HelperAgent' });
    const callerPendingShell: AgentInputItem = {
      type: 'shell_call',
      callId: 'manual_shell',
      status: 'in_progress',
      action: { commands: ['echo hi'] },
    };
    const orphanGeneratedShell = new RunToolCallItem(
      {
        type: 'shell_call',
        callId: 'orphan_shell',
        status: 'completed',
        action: { commands: ['echo bye'] },
      } satisfies protocol.ShellCallItem,
      agent,
    );

    const prepared = prepareModelInputItems(
      [callerPendingShell],
      [orphanGeneratedShell],
    );

    expect(prepared).toEqual([callerPendingShell]);
  });

  it('keeps generated shell calls when a matching output is present', () => {
    const agent = new Agent({ name: 'HelperAgent' });
    const shellCall = new RunToolCallItem(
      {
        type: 'shell_call',
        callId: 'shell_1',
        status: 'completed',
        action: { commands: ['echo hi'] },
      } satisfies protocol.ShellCallItem,
      agent,
    );
    const shellOutput = new RunToolCallOutputItem(
      {
        type: 'shell_call_output',
        callId: 'shell_1',
        output: [
          {
            stdout: 'hi',
            stderr: '',
            outcome: { type: 'exit', exitCode: 0 },
          },
        ],
      } satisfies protocol.ShellCallResultItem,
      agent,
      'hi',
    );

    const prepared = prepareModelInputItems('hello', [shellCall, shellOutput]);

    expect(prepared).toEqual([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      shellCall.rawItem,
      shellOutput.rawItem,
    ]);
  });

  it('drops reasoning items tied to orphan generated tool calls', () => {
    const agent = new Agent({ name: 'HelperAgent' });
    const orphanReasoningA = new RunReasoningItem(
      {
        type: 'reasoning',
        id: 'rs_orphan_a',
        content: [],
      },
      agent,
    );
    const orphanReasoningB = new RunReasoningItem(
      {
        type: 'reasoning',
        id: 'rs_orphan_b',
        content: [],
      },
      agent,
    );
    const orphanCall = new RunToolCallItem(
      {
        type: 'function_call',
        callId: 'orphan_call',
        name: 'orphan',
        arguments: '{}',
      } satisfies protocol.FunctionCallItem,
      agent,
    );
    const pairedReasoning = new RunReasoningItem(
      {
        type: 'reasoning',
        id: 'rs_paired',
        content: [],
      },
      agent,
    );
    const pairedCall = new RunToolCallItem(
      {
        type: 'function_call',
        callId: 'paired_call',
        name: 'paired',
        arguments: '{}',
      } satisfies protocol.FunctionCallItem,
      agent,
    );
    const pairedOutput = new RunToolCallOutputItem(
      {
        type: 'function_call_result',
        name: 'paired',
        callId: 'paired_call',
        status: 'completed',
        output: 'ok',
      } satisfies protocol.FunctionCallResultItem,
      agent,
      'ok',
    );

    const prepared = prepareModelInputItems('hello', [
      orphanReasoningA,
      orphanReasoningB,
      orphanCall,
      pairedReasoning,
      pairedCall,
      pairedOutput,
    ]);

    expect(prepared).toEqual([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      pairedReasoning.rawItem,
      pairedCall.rawItem,
      pairedOutput.rawItem,
    ]);
  });

  it('keeps generated lone reasoning when no tool calls are dropped', () => {
    const agent = new Agent({ name: 'HelperAgent' });
    const reasoning = new RunReasoningItem(
      {
        type: 'reasoning',
        id: 'rs_lone',
        content: [],
      },
      agent,
    );

    const prepared = prepareModelInputItems('hello', [reasoning]);

    expect(prepared).toEqual([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      reasoning.rawItem,
    ]);
  });
});

describe('extractOutputItemsFromRunItems', () => {
  it('strips protocol created_by metadata without mutating provider data or raw items', () => {
    const agent = new Agent({ name: 'HelperAgent' });
    const functionCall = {
      type: 'function_call',
      id: 'fc_created_by',
      callId: 'call_created_by',
      name: 'lookup',
      arguments: '{}',
      status: 'completed',
      providerData: {
        created_by: 'server',
        retained: 'function metadata',
      },
    } satisfies protocol.FunctionCallItem;
    const compaction = {
      type: 'compaction',
      id: 'cmp_created_by',
      encrypted_content: 'ciphertext',
      created_by: 'compaction_endpoint',
      providerData: {
        created_by: 'third-party-provider',
        retained: 'compaction metadata',
      },
    } satisfies protocol.CompactionItem;
    const shellOutput = {
      type: 'shell_call_output',
      callId: 'shell_created_by',
      status: 'completed',
      providerData: {
        created_by: 'server',
        retained: 'shell metadata',
      },
      output: [
        {
          stdout: 'ok',
          stderr: '',
          outcome: { type: 'exit', exitCode: 0 },
          created_by: 'server',
          retained: 'chunk metadata',
        },
      ],
    } satisfies protocol.ShellCallResultItem;
    const functionRunItem = new RunToolCallItem(functionCall, agent);
    const compactionRunItem = new RunCompactionItem(compaction, agent);
    const shellRunItem = new RunToolCallOutputItem(shellOutput, agent, 'ok');

    const [convertedFunctionCall, convertedCompaction, convertedShellOutput] =
      extractOutputItemsFromRunItems([
        functionRunItem,
        compactionRunItem,
        shellRunItem,
      ]);

    expect(convertedFunctionCall).toEqual({
      type: 'function_call',
      id: 'fc_created_by',
      callId: 'call_created_by',
      name: 'lookup',
      arguments: '{}',
      status: 'completed',
      providerData: {
        created_by: 'server',
        retained: 'function metadata',
      },
    });
    expect(convertedCompaction).toEqual({
      type: 'compaction',
      id: 'cmp_created_by',
      encrypted_content: 'ciphertext',
      providerData: {
        created_by: 'third-party-provider',
        retained: 'compaction metadata',
      },
    });
    expect(convertedShellOutput).toEqual({
      type: 'shell_call_output',
      callId: 'shell_created_by',
      status: 'completed',
      providerData: {
        created_by: 'server',
        retained: 'shell metadata',
      },
      output: [
        {
          stdout: 'ok',
          stderr: '',
          outcome: { type: 'exit', exitCode: 0 },
          retained: 'chunk metadata',
        },
      ],
    });
    expect(functionRunItem.rawItem).toBe(functionCall);
    expect(convertedFunctionCall).toBe(functionCall);
    expect(functionRunItem.rawItem.providerData).toHaveProperty(
      'created_by',
      'server',
    );
    expect(compactionRunItem.rawItem).toBe(compaction);
    expect(compactionRunItem.rawItem).toHaveProperty(
      'created_by',
      'compaction_endpoint',
    );
    expect(shellRunItem.rawItem).toBe(shellOutput);
    expect(shellRunItem.rawItem.providerData).toHaveProperty(
      'created_by',
      'server',
    );
    expect(shellOutput.output[0]).toHaveProperty('created_by', 'server');
    expect(functionRunItem.toJSON().rawItem).toBe(functionCall);
    expect(compactionRunItem.toJSON().rawItem).toBe(compaction);
    expect(shellRunItem.toJSON().rawItem).toBe(shellOutput);

    const [cachedFunctionCall, cachedCompaction, cachedShellOutput] =
      extractOutputItemsFromRunItems([
        functionRunItem,
        compactionRunItem,
        shellRunItem,
      ]);
    expect(cachedFunctionCall).toBe(convertedFunctionCall);
    expect(cachedCompaction).toBe(convertedCompaction);
    expect(cachedShellOutput).toBe(convertedShellOutput);
  });

  it('preserves identity when output-only metadata does not need normalization', () => {
    const agent = new Agent({ name: 'HelperAgent' });
    const message: protocol.AssistantMessageItem = {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        { type: 'output_text', text: 'hello' },
        { type: 'refusal', refusal: 'no' },
        {
          type: 'audio',
          audio: 'base64-audio',
          format: 'wav',
          transcript: 'hello',
        },
      ],
    };
    const runItem = new RunMessageOutputItem(message, agent);

    const [converted] = extractOutputItemsFromRunItems([runItem]);

    expect(converted).toBe(message);
    expect(extractOutputItemsFromRunItems([runItem])[0]).toBe(converted);
  });

  it('omits null statuses from model input history', () => {
    const agent = new Agent({ name: 'HelperAgent' });
    const message = {
      type: 'message',
      role: 'assistant',
      content: [],
      status: null,
    } as unknown as protocol.AssistantMessageItem;
    const runItem = new RunMessageOutputItem(message, agent);

    expect(extractOutputItemsFromRunItems([runItem])).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [],
      },
    ]);
  });
});

describe('dropOrphanToolCalls', () => {
  it('drops program outputs without matching program calls', () => {
    const programOutput: protocol.ProgramCallResultItem = {
      type: 'program_output',
      callId: 'program_orphan',
      output: 'done',
      status: 'completed',
    };

    expect(dropOrphanToolCalls([programOutput])).toEqual([]);
    expect(
      dropOrphanToolCalls([programOutput], {
        pruningIndexes: new Set([0]),
      }),
    ).toEqual([]);
    expect(
      dropOrphanToolCalls([programOutput], {
        pruningIndexes: new Set(),
      }),
    ).toEqual([programOutput]);
  });

  it.each([
    {
      name: 'function',
      call: {
        type: 'function_call',
        callId: 'owned_call',
        name: 'lookup',
        arguments: '{}',
        caller: { type: 'program', callerId: 'program_pending' },
      } satisfies protocol.FunctionCallItem,
    },
    {
      name: 'shell',
      call: {
        type: 'shell_call',
        callId: 'owned_call',
        status: 'completed',
        action: { commands: ['echo pending'] },
        caller: { type: 'program', callerId: 'program_pending' },
      } satisfies protocol.ShellCallItem,
    },
    {
      name: 'apply patch',
      call: {
        type: 'apply_patch_call',
        callId: 'owned_call',
        status: 'completed',
        operation: { type: 'delete_file', path: 'pending.txt' },
        caller: { type: 'program', callerId: 'program_pending' },
      } satisfies protocol.ApplyPatchCallItem,
    },
  ])('drops a program with an orphan program-owned $name call', ({ call }) => {
    const program: protocol.ProgramCallItem = {
      type: 'program',
      callId: 'program_pending',
      code: 'return await tools.lookup({});',
      fingerprint: 'fingerprint:pending',
    };

    expect(dropOrphanToolCalls([program, call])).toEqual([]);
  });

  it('drops a program with a dangling program-owned result', () => {
    const program: protocol.ProgramCallItem = {
      type: 'program',
      callId: 'program_pending',
      code: 'return await tools.lookup({});',
      fingerprint: 'fingerprint:pending',
    };
    const functionOutput: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      callId: 'owned_call',
      name: 'lookup',
      status: 'completed',
      output: 'done',
      caller: { type: 'program', callerId: 'program_pending' },
    };

    expect(dropOrphanToolCalls([program, functionOutput])).toEqual([]);
    expect(
      dropOrphanToolCalls([program, functionOutput], {
        pruningIndexes: new Set([0]),
      }),
    ).toEqual([]);
  });

  it('drops a program with an orphan program-owned MCP approval response', () => {
    const program: protocol.ProgramCallItem = {
      type: 'program',
      callId: 'program_pending',
      code: 'return await tools.lookup({});',
      fingerprint: 'fingerprint:pending',
    };
    const approvalResponse: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      id: 'mcpr_response',
      name: 'mcp_approval_response',
      status: 'completed',
      caller: { type: 'program', callerId: 'program_pending' },
      providerData: {
        type: 'mcp_approval_response',
        approval_request_id: 'mcpr_missing',
        approve: true,
      },
    };

    expect(dropOrphanToolCalls([program, approvalResponse])).toEqual([]);
  });

  it('keeps a program with a paired program-owned MCP approval response', () => {
    const program: protocol.ProgramCallItem = {
      type: 'program',
      callId: 'program_pending',
      code: 'return await tools.lookup({});',
      fingerprint: 'fingerprint:pending',
    };
    const approvalRequest: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      id: 'mcpr_request',
      name: 'mcp_approval_request',
      status: 'in_progress',
      caller: { type: 'program', callerId: 'program_pending' },
      providerData: {
        type: 'mcp_approval_request',
        id: 'mcpr_request',
      },
    };
    const approvalResponse: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      id: 'mcpr_response',
      name: 'mcp_approval_response',
      status: 'completed',
      caller: { type: 'program', callerId: 'program_pending' },
      providerData: {
        type: 'mcp_approval_response',
        approval_request_id: 'mcpr_request',
        approve: true,
      },
    };

    expect(
      dropOrphanToolCalls([program, approvalRequest, approvalResponse]),
    ).toEqual([program, approvalRequest, approvalResponse]);
  });

  it('drops program-owned items without their owning program', () => {
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      callId: 'owned_call',
      name: 'lookup',
      arguments: '{}',
      caller: { type: 'program', callerId: 'program_missing' },
    };
    const functionOutput: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      callId: 'owned_call',
      name: 'lookup',
      status: 'completed',
      output: 'done',
      caller: { type: 'program', callerId: 'program_missing' },
    };
    const hostedCall: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      id: 'ci_missing',
      name: 'code_interpreter_call',
      status: 'completed',
      caller: { type: 'program', callerId: 'program_missing' },
      providerData: { type: 'code_interpreter_call' },
    };

    expect(
      dropOrphanToolCalls([functionCall, functionOutput, hostedCall]),
    ).toEqual([]);
  });

  it('drops dangling owned results from completed programs', () => {
    const program: protocol.ProgramCallItem = {
      type: 'program',
      callId: 'program_completed',
      code: 'return await tools.lookup({});',
      fingerprint: 'fingerprint:completed',
    };
    const functionOutput: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      callId: 'owned_call',
      name: 'lookup',
      status: 'completed',
      output: 'done',
      caller: { type: 'program', callerId: 'program_completed' },
    };
    const programOutput: protocol.ProgramCallResultItem = {
      type: 'program_output',
      callId: 'program_completed',
      output: 'done',
      status: 'completed',
    };

    expect(
      dropOrphanToolCalls([program, functionOutput, programOutput]),
    ).toEqual([program, programOutput]);
  });

  it('keeps a program with a completed owned pair at pruning indexes', () => {
    const program: protocol.ProgramCallItem = {
      type: 'program',
      callId: 'program_pending',
      code: 'return await tools.lookup({});',
      fingerprint: 'fingerprint:pending',
    };
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      callId: 'owned_call',
      name: 'lookup',
      arguments: '{}',
      caller: { type: 'program', callerId: 'program_pending' },
    };
    const functionOutput: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      callId: 'owned_call',
      name: 'lookup',
      status: 'completed',
      output: 'done',
      caller: { type: 'program', callerId: 'program_pending' },
    };

    expect(
      dropOrphanToolCalls([program, functionCall, functionOutput], {
        pruningIndexes: new Set([0, 1, 2]),
      }),
    ).toEqual([program, functionCall, functionOutput]);
  });

  it('keeps active programs with program-owned hosted calls', () => {
    const program: protocol.ProgramCallItem = {
      type: 'program',
      callId: 'program_pending',
      code: 'return await tools.code_interpreter({});',
      fingerprint: 'fingerprint:pending',
    };
    const hostedCall: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      id: 'ci_1',
      name: 'code_interpreter_call',
      status: 'completed',
      caller: { type: 'program', callerId: 'program_pending' },
      providerData: { type: 'code_interpreter_call' },
    };

    expect(dropOrphanToolCalls([program, hostedCall])).toEqual([
      program,
      hostedCall,
    ]);
  });

  it('drops program-owned hosted calls with an explicitly pruned owner', () => {
    const program: protocol.ProgramCallItem = {
      type: 'program',
      callId: 'program_orphan',
      code: 'return await tools.code_interpreter({});',
      fingerprint: 'fingerprint:orphan',
    };
    const hostedCall: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      id: 'ci_1',
      name: 'code_interpreter_call',
      status: 'completed',
      caller: { type: 'program', callerId: 'program_orphan' },
      providerData: { type: 'code_interpreter_call' },
    };

    expect(
      dropOrphanToolCalls([program, hostedCall], {
        pruningIndexes: new Set([0, 1]),
      }),
    ).toEqual([]);
  });

  it('prunes only the indexes explicitly marked for pruning', () => {
    const historyShell: AgentInputItem = {
      type: 'shell_call',
      callId: 'history_shell',
      status: 'completed',
      action: { commands: ['echo old'] },
    };
    const callerShell: AgentInputItem = {
      type: 'shell_call',
      callId: 'caller_shell',
      status: 'completed',
      action: { commands: ['echo new'] },
    };

    const prepared = dropOrphanToolCalls([historyShell, callerShell], {
      pruningIndexes: new Set([0]),
    });

    expect(prepared).toEqual([callerShell]);
  });

  it('preserves pending hosted shell calls at pruned indexes', () => {
    const pendingShell: AgentInputItem = {
      type: 'shell_call',
      callId: 'pending_shell',
      status: 'in_progress',
      action: { commands: ['echo wait'] },
    };

    const prepared = dropOrphanToolCalls([pendingShell], {
      pruningIndexes: new Set([0]),
    });

    expect(prepared).toEqual([pendingShell]);
  });

  it('does not drop reasoning outside the explicit pruning indexes', () => {
    const callerReasoning: AgentInputItem = {
      type: 'reasoning',
      id: 'rs_caller',
      content: [],
    };
    const historyShell: AgentInputItem = {
      type: 'shell_call',
      callId: 'history_shell',
      status: 'completed',
      action: { commands: ['echo old'] },
    };

    const prepared = dropOrphanToolCalls([callerReasoning, historyShell], {
      pruningIndexes: new Set([1]),
    });

    expect(prepared).toEqual([callerReasoning]);
  });
});
