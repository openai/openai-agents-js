import { describe, test, expect } from 'vitest';
import { removeAllTools } from '../../src/extensions';
import {
  RunHandoffCallItem,
  RunHandoffOutputItem,
  RunMessageOutputItem,
  RunToolCallItem,
  RunToolCallOutputItem,
  RunToolSearchCallItem,
  RunToolSearchOutputItem,
} from '../../src/items';
import type { AgentInputItem } from '../../src/types';
import type * as protocol from '../../src/types/protocol';
import {
  TEST_AGENT,
  TEST_MODEL_FUNCTION_CALL,
  fakeModelMessage,
} from '../stubs';

const functionCallResult: protocol.FunctionCallResultItem = {
  type: 'function_call_result',
  callId: 'call-1',
  name: 'tool',
  status: 'completed',
  output: { type: 'text', text: 'done' },
};

const computerCall: protocol.ComputerUseCallItem = {
  type: 'computer_call',
  callId: 'computer-call',
  status: 'completed',
  action: { type: 'screenshot' },
};

const computerCallResult: protocol.ComputerCallResultItem = {
  type: 'computer_call_result',
  callId: 'computer-call',
  output: { type: 'computer_screenshot', data: 'image-data' },
};

const hostedToolCall: protocol.HostedToolCallItem = {
  type: 'hosted_tool_call',
  name: 'web_search_call',
  arguments: '{"q":"openai"}',
  status: 'completed',
  output: 'results',
};

const shellCall: protocol.ShellCallItem = {
  type: 'shell_call',
  callId: 'shell-call',
  status: 'completed',
  action: { commands: ['echo hi'] },
};

const shellCallResult: protocol.ShellCallResultItem = {
  type: 'shell_call_output',
  callId: 'shell-call',
  output: [
    { stdout: 'hi', stderr: '', outcome: { type: 'exit', exitCode: 0 } },
  ],
};

const applyPatchCall: protocol.ApplyPatchCallItem = {
  type: 'apply_patch_call',
  callId: 'patch-call',
  status: 'completed',
  operation: { type: 'delete_file', path: 'tmp.txt' },
};

const applyPatchCallResult: protocol.ApplyPatchCallResultItem = {
  type: 'apply_patch_call_output',
  callId: 'patch-call',
  status: 'completed',
  output: 'done',
};

const toolSearchCall: protocol.ToolSearchCallItem = {
  type: 'tool_search_call',
  id: 'tool-search-call',
  status: 'completed',
  arguments: {
    paths: ['crm'],
    query: 'lookup account',
  },
};

const toolSearchOutput: protocol.ToolSearchOutputItem = {
  type: 'tool_search_output',
  id: 'tool-search-output',
  status: 'completed',
  tools: [
    {
      type: 'tool_reference',
      functionName: 'lookup_account',
      namespace: 'crm',
    },
  ],
};

describe('removeAllTools', () => {
  test('should be available', () => {
    const result = removeAllTools({
      inputHistory: [],
      preHandoffItems: [],
      newItems: [],
    });
    expect(result).toEqual({
      inputHistory: [],
      preHandoffItems: [],
      newItems: [],
    });
  });

  test('removes run tool and handoff items from run collections', () => {
    const message = new RunMessageOutputItem(
      fakeModelMessage('ok'),
      TEST_AGENT,
    );
    const anotherMessage = new RunMessageOutputItem(
      fakeModelMessage('still here'),
      TEST_AGENT,
    );

    const result = removeAllTools({
      inputHistory: 'keep me',
      preHandoffItems: [
        new RunHandoffCallItem(TEST_MODEL_FUNCTION_CALL, TEST_AGENT),
        message,
        new RunToolSearchCallItem(toolSearchCall, TEST_AGENT),
        new RunToolCallItem(TEST_MODEL_FUNCTION_CALL, TEST_AGENT),
      ],
      newItems: [
        new RunToolSearchOutputItem(toolSearchOutput, TEST_AGENT),
        new RunToolCallOutputItem(functionCallResult, TEST_AGENT, 'ok'),
        new RunHandoffOutputItem(functionCallResult, TEST_AGENT, TEST_AGENT),
        anotherMessage,
      ],
    });

    expect(result.inputHistory).toBe('keep me');
    expect(result.preHandoffItems).toStrictEqual([message]);
    expect(result.newItems).toStrictEqual([anotherMessage]);
  });

  test('filters out tool typed input history entries', () => {
    const userMessage = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }],
    } as AgentInputItem;
    const history: AgentInputItem[] = [
      userMessage,
      TEST_MODEL_FUNCTION_CALL,
      functionCallResult,
      toolSearchCall,
      toolSearchOutput,
      computerCall,
      computerCallResult,
      hostedToolCall,
      shellCall,
      shellCallResult,
      applyPatchCall,
      applyPatchCallResult,
    ];

    const result = removeAllTools({
      inputHistory: history,
      preHandoffItems: [],
      newItems: [],
    });

    expect(result.inputHistory).toStrictEqual([userMessage]);
    expect(history).toHaveLength(12);
    expect((result.inputHistory as AgentInputItem[])[0]).toBe(userMessage);
  });
});
