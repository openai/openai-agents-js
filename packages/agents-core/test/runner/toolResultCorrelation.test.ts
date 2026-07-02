import { describe, expect, it } from 'vitest';

import {
  getToolResultCorrelationForCall,
  getToolResultCorrelationForResult,
  getToolResultCorrelationKey,
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
