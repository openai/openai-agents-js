import { describe, expect, it } from 'vitest';

import { Agent } from '../../src/agent';
import {
  RunMessageOutputItem,
  RunReasoningItem,
  RunToolCallItem,
  RunToolCallOutputItem,
} from '../../src/items';
import {
  dropOrphanToolCalls,
  extractOutputItemsFromRunItems,
  prepareModelInputItems,
} from '../../src/runner/items';
import type { AgentInputItem } from '../../src/types';
import * as protocol from '../../src/types/protocol';

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
