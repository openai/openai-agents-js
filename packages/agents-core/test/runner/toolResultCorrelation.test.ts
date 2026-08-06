import { describe, expect, it } from 'vitest';

import {
  getToolResultCorrelationForCall,
  getToolResultCorrelationForResult,
  getToolResultCorrelationKey,
  getUnresolvedToolResultCorrelationsForResponse,
} from '../../src/runner/toolResultCorrelation';
import type { AgentInputItem } from '../../src/types';

type CorrelationPair = {
  call: AgentInputItem;
  result: AgentInputItem;
};

function expectMatchingCorrelation({ call, result }: CorrelationPair) {
  const callCorrelation = getToolResultCorrelationForCall(call);
  const resultCorrelation = getToolResultCorrelationForResult(result);

  expect(callCorrelation).toEqual(resultCorrelation);
  expect(callCorrelation).toBeDefined();
  expect(getToolResultCorrelationKey(callCorrelation!)).toBe(
    getToolResultCorrelationKey(resultCorrelation!),
  );
}

describe('tool result correlation', () => {
  it.each<CorrelationPair>([
    {
      call: {
        type: 'program',
        callId: 'shared:program',
        code: 'return "done";',
        fingerprint: 'fingerprint:program',
      },
      result: {
        type: 'program_output',
        callId: 'shared:program',
        output: 'done',
        status: 'completed',
      },
    },
    {
      call: {
        type: 'function_call',
        callId: 'shared:function',
        name: 'test',
        arguments: '{}',
      },
      result: {
        type: 'function_call_result',
        callId: 'shared:function',
        name: 'test',
        status: 'completed',
        output: 'done',
      },
    },
    {
      call: {
        type: 'computer_call',
        callId: 'shared:computer',
        status: 'completed',
        action: { type: 'screenshot' },
      },
      result: {
        type: 'computer_call_result',
        callId: 'shared:computer',
        output: { type: 'computer_screenshot', data: 'image' },
      },
    },
    {
      call: {
        type: 'shell_call',
        callId: 'shared:shell',
        status: 'completed',
        action: { commands: ['echo hi'] },
      },
      result: {
        type: 'shell_call_output',
        callId: 'shared:shell',
        output: [
          {
            stdout: 'hi',
            stderr: '',
            outcome: { type: 'exit', exitCode: 0 },
          },
        ],
      },
    },
    {
      call: {
        type: 'apply_patch_call',
        callId: 'shared:apply-patch',
        status: 'completed',
        operation: { type: 'delete_file', path: 'old.txt' },
      },
      result: {
        type: 'apply_patch_call_output',
        callId: 'shared:apply-patch',
        status: 'completed',
        output: 'done',
      },
    },
    {
      call: {
        type: 'tool_search_call',
        id: 'tool-search-item',
        arguments: { paths: ['crm'] },
        providerData: {
          call_id: 'shared:tool-search',
          execution: 'client',
        },
      },
      result: {
        type: 'tool_search_output',
        status: 'completed',
        tools: [],
        providerData: {
          call_id: 'shared:tool-search',
          execution: 'client',
        },
      },
    },
  ])('matches $call.type calls with their result type', (pair) => {
    expectMatchingCorrelation(pair);
  });

  it('uses the provider request ID for hosted MCP approvals', () => {
    expectMatchingCorrelation({
      call: {
        type: 'hosted_tool_call',
        id: 'approval-item:1',
        name: 'mcp_approval_request',
        providerData: {
          type: 'mcp_approval_request',
          id: 'provider-approval-id',
        },
      },
      result: {
        type: 'hosted_tool_call',
        name: 'mcp_approval_response',
        providerData: {
          approve: true,
          approval_request_id: 'provider-approval-id',
        },
      },
    });
  });

  it('does not correlate server-executed tool searches', () => {
    const call: AgentInputItem = {
      type: 'tool_search_call',
      arguments: { query: 'crm' },
      providerData: {
        call_id: 'server-tool-search',
        execution: 'server',
      },
    };
    const result: AgentInputItem = {
      type: 'tool_search_output',
      tools: [],
      providerData: {
        call_id: 'server-tool-search',
        execution: 'server',
      },
    };

    expect(getToolResultCorrelationForCall(call)).toBeUndefined();
    expect(getToolResultCorrelationForResult(result)).toBeUndefined();
  });

  it('matches call-id-less client tool search outputs by response order', () => {
    const call: AgentInputItem = {
      type: 'tool_search_call',
      id: 'tool-search-call',
      execution: 'client',
      arguments: { paths: ['crm'] },
    };
    const output: AgentInputItem = {
      type: 'tool_search_output',
      id: 'tool-search-output',
      execution: 'client',
      tools: [],
    };

    expect(getToolResultCorrelationForResult(output)).toBeUndefined();
    expect(
      getUnresolvedToolResultCorrelationsForResponse([call, output]),
    ).toEqual([]);
  });

  it('keeps client tool search calls unresolved when a server output reuses the ID', () => {
    const call: AgentInputItem = {
      type: 'tool_search_call',
      id: 'client-tool-search-call',
      execution: 'client',
      arguments: { paths: ['crm'] },
      providerData: {
        call_id: 'shared-tool-search',
        execution: 'client',
      },
    };
    const serverOutput: AgentInputItem = {
      type: 'tool_search_output',
      id: 'server-tool-search-output',
      execution: 'server',
      tools: [],
      providerData: {
        call_id: 'shared-tool-search',
        execution: 'server',
      },
    };

    expect(
      getUnresolvedToolResultCorrelationsForResponse([call, serverOutput]),
    ).toEqual([getToolResultCorrelationForCall(call)]);
  });

  it('resolves provider-executed tool calls within their response', () => {
    const call: AgentInputItem = {
      type: 'shell_call',
      callId: 'provider-shell',
      status: 'completed',
      action: { commands: ['echo provider'] },
    };
    const output: AgentInputItem = {
      type: 'shell_call_output',
      callId: 'provider-shell',
      output: [
        {
          stdout: 'provider',
          stderr: '',
          outcome: { type: 'exit', exitCode: 0 },
        },
      ],
    };

    expect(
      getUnresolvedToolResultCorrelationsForResponse([call, output]),
    ).toEqual([]);
  });

  it('keeps program calls unresolved until their program output arrives', () => {
    const call: AgentInputItem = {
      type: 'program',
      callId: 'pending-program',
      code: 'return "pending";',
      fingerprint: 'fingerprint:pending-program',
    };

    expect(getUnresolvedToolResultCorrelationsForResponse([call])).toEqual([
      getToolResultCorrelationForCall(call),
    ]);
  });

  it('does not correlate unrelated hosted tool calls', () => {
    const hostedCall: AgentInputItem = {
      type: 'hosted_tool_call',
      id: 'web-search-1',
      name: 'web_search_call',
    };

    expect(getToolResultCorrelationForCall(hostedCall)).toBeUndefined();
    expect(getToolResultCorrelationForResult(hostedCall)).toBeUndefined();
  });
});
