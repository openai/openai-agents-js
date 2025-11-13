import { describe, test, expect } from 'vitest';
import { removeAllTools } from '../../src/extensions';
import {
  RunHandoffCallItem,
  RunHandoffOutputItem,
  RunMessageOutputItem,
  RunToolCallItem,
  RunToolCallOutputItem,
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
        new RunToolCallItem(TEST_MODEL_FUNCTION_CALL, TEST_AGENT),
      ],
      newItems: [
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
    expect(history).toHaveLength(10);
    expect((result.inputHistory as AgentInputItem[])[0]).toBe(userMessage);
  });
});
