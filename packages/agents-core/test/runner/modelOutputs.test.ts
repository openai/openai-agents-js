import { beforeAll, describe, expect, it, vi } from 'vitest';

import { setDefaultModelProvider, setTracingDisabled } from '../../src';
import { Agent } from '../../src/agent';
import { ModelBehaviorError } from '../../src/errors';
import { handoff } from '../../src/handoff';
import {
  RunMessageOutputItem as MessageOutputItem,
  RunReasoningItem as ReasoningItem,
  RunToolCallItem as ToolCallItem,
} from '../../src/items';
import { ModelResponse } from '../../src/model';
import { processModelResponse } from '../../src/runner/modelOutputs';
import { computerTool, applyPatchTool, shellTool } from '../../src/tool';
import { Usage } from '../../src/usage';
import {
  FakeEditor,
  FakeModelProvider,
  FakeShell,
  TEST_AGENT,
  TEST_MODEL_FUNCTION_CALL,
  TEST_MODEL_MESSAGE,
  TEST_MODEL_RESPONSE_WITH_FUNCTION,
  TEST_TOOL,
} from '../stubs';
import * as protocol from '../../src/types/protocol';

beforeAll(() => {
  setTracingDisabled(true);
  setDefaultModelProvider(new FakeModelProvider());
});

describe('processModelResponse', () => {
  it('processes message outputs and tool calls', () => {
    const modelResponse: ModelResponse = TEST_MODEL_RESPONSE_WITH_FUNCTION;

    const result = processModelResponse(
      modelResponse,
      TEST_AGENT,
      [TEST_TOOL],
      [],
    );

    expect(result.newItems).toHaveLength(2);
    expect(result.newItems[0]).toBeInstanceOf(ToolCallItem);
    expect(result.newItems[0].rawItem).toEqual(
      TEST_MODEL_RESPONSE_WITH_FUNCTION.output[0],
    );
    expect(result.toolsUsed).toEqual(['test']);
    expect(result.functions).toContainEqual({
      tool: TEST_TOOL,
      toolCall: TEST_MODEL_RESPONSE_WITH_FUNCTION.output[0],
    });
    expect(result.newItems[1]).toBeInstanceOf(MessageOutputItem);
    expect(result.newItems[1].rawItem).toEqual(
      TEST_MODEL_RESPONSE_WITH_FUNCTION.output[1],
    );
    expect(result.hasToolsOrApprovalsToRun()).toBe(true);
  });

  it('queues shell actions when shell tool registered', () => {
    const shellCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell',
      status: 'completed',
      action: { commands: ['echo hi'] },
    };
    const modelResponse: ModelResponse = {
      output: [shellCall],
      usage: new Usage(),
    };

    const shell = shellTool({ shell: new FakeShell() });
    const result = processModelResponse(modelResponse, TEST_AGENT, [shell], []);

    expect(result.shellActions).toHaveLength(1);
    expect(result.shellActions[0]?.toolCall).toEqual(shellCall);
    expect(result.shellActions[0]?.shell).toBe(shell);
    expect(result.toolsUsed).toEqual(['shell']);
  });

  it('throws when shell action emitted without shell tool', () => {
    const shellCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell',
      status: 'completed',
      action: { commands: ['echo hi'] },
    };
    const modelResponse: ModelResponse = {
      output: [shellCall],
      usage: new Usage(),
    };

    expect(() =>
      processModelResponse(modelResponse, TEST_AGENT, [TEST_TOOL], []),
    ).toThrow(ModelBehaviorError);
  });

  it('queues apply_patch actions when editor tool registered', () => {
    const applyPatchCall: protocol.ApplyPatchCallItem = {
      type: 'apply_patch_call',
      callId: 'call_patch',
      status: 'completed',
      operation: {
        type: 'update_file',
        path: 'README.md',
        diff: 'diff --git',
      },
    };
    const modelResponse: ModelResponse = {
      output: [applyPatchCall],
      usage: new Usage(),
    };

    const editor = applyPatchTool({ editor: new FakeEditor() });
    const result = processModelResponse(
      modelResponse,
      TEST_AGENT,
      [editor],
      [],
    );

    expect(result.applyPatchActions).toHaveLength(1);
    expect(result.applyPatchActions[0]?.toolCall).toEqual(applyPatchCall);
    expect(result.applyPatchActions[0]?.applyPatch).toBe(editor);
    expect(result.toolsUsed).toEqual(['apply_patch']);
  });

  it('throws when apply_patch action emitted without editor tool', () => {
    const applyPatchCall: protocol.ApplyPatchCallItem = {
      type: 'apply_patch_call',
      callId: 'call_patch',
      status: 'completed',
      operation: {
        type: 'delete_file',
        path: 'temp.txt',
      },
    };
    const modelResponse: ModelResponse = {
      output: [applyPatchCall],
      usage: new Usage(),
    };

    expect(() =>
      processModelResponse(modelResponse, TEST_AGENT, [TEST_TOOL], []),
    ).toThrow(ModelBehaviorError);
  });

  it('throws when hosted MCP approval references missing server', () => {
    const hostedCall: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      name: 'mcp_approval_request',
      id: 'mcpr_123',
      status: 'in_progress',
      providerData: {
        type: 'mcp_approval_request',
        server_label: 'missing',
        name: 'mcp_approval_request',
        id: 'mcpr_123',
        arguments: {},
      },
    };
    const response: ModelResponse = {
      output: [hostedCall],
      usage: new Usage(),
    };

    expect(() =>
      processModelResponse(response, TEST_AGENT, [TEST_TOOL], []),
    ).toThrow(ModelBehaviorError);
  });

  it('captures reasoning items', () => {
    const reasoning: protocol.ReasoningItem = {
      id: 'r1',
      type: 'reasoning',
      content: [{ type: 'input_text', text: 'thinking' }],
    };
    const response: ModelResponse = { output: [reasoning], usage: new Usage() };
    const result = processModelResponse(response, TEST_AGENT, [TEST_TOOL], []);

    expect(result.newItems[0]).toBeInstanceOf(ReasoningItem);
    expect(result.toolsUsed).toEqual([]);
  });
});

describe('processModelResponse edge cases', () => {
  it('throws when model references unknown tool', () => {
    const badCall: protocol.FunctionCallItem = {
      ...TEST_MODEL_FUNCTION_CALL,
      name: 'missing_tool',
    };
    const response: ModelResponse = {
      output: [badCall],
      usage: new Usage(),
    } as any;

    expect(() =>
      processModelResponse(response, TEST_AGENT, [TEST_TOOL], []),
    ).toThrow(ModelBehaviorError);
  });

  it('throws when computer action emitted without computer tool', () => {
    const compCall: protocol.ComputerUseCallItem = {
      id: 'c1',
      type: 'computer_call',
      callId: 'c1',
      status: 'completed',
      action: { type: 'click', x: 1, y: 1, button: 'left' },
    };
    const response: ModelResponse = {
      output: [compCall],
      usage: new Usage(),
    } as any;

    expect(() =>
      processModelResponse(response, TEST_AGENT, [TEST_TOOL], []),
    ).toThrow(ModelBehaviorError);
  });

  it('classifies functions, handoffs and computer actions', () => {
    const target = new Agent({ name: 'B' });
    const h = handoff(target);
    const computer = computerTool({
      computer: {
        environment: 'mac',
        dimensions: [10, 10],
        screenshot: vi.fn(async () => 'img'),
        click: vi.fn(async () => {}),
        doubleClick: vi.fn(async () => {}),
        drag: vi.fn(async () => {}),
        keypress: vi.fn(async () => {}),
        move: vi.fn(async () => {}),
        scroll: vi.fn(async () => {}),
        type: vi.fn(async () => {}),
        wait: vi.fn(async () => {}),
      },
    });

    const funcCall = { ...TEST_MODEL_FUNCTION_CALL, callId: 'f1' };
    const compCall: protocol.ComputerUseCallItem = {
      id: 'c1',
      type: 'computer_call',
      callId: 'c1',
      status: 'completed',
      action: { type: 'screenshot' },
    };
    const handCall: protocol.FunctionCallItem = {
      ...TEST_MODEL_FUNCTION_CALL,
      name: h.toolName,
      callId: 'h1',
    };
    const response: ModelResponse = {
      output: [funcCall, compCall, handCall, TEST_MODEL_MESSAGE],
      usage: new Usage(),
    } as any;

    const result = processModelResponse(
      response,
      TEST_AGENT,
      [TEST_TOOL, computer],
      [h],
    );

    expect(result.functions[0]?.toolCall).toBe(funcCall);
    expect(result.computerActions[0]?.toolCall).toBe(compCall);
    expect(result.handoffs[0]?.toolCall).toBe(handCall);
    expect(result.toolsUsed).toEqual(['test', computer.name, h.toolName]);
    expect(result.hasToolsOrApprovalsToRun()).toBe(true);
    expect(result.newItems[3]).toBeInstanceOf(MessageOutputItem);
  });
});

describe('hasToolsOrApprovalsToRun method', () => {
  it('returns true when handoffs are pending', () => {
    const target = new Agent({ name: 'Target' });
    const h = handoff(target);
    const response: ModelResponse = {
      output: [{ ...TEST_MODEL_FUNCTION_CALL, name: h.toolName }],
      usage: new Usage(),
    } as any;

    const result = processModelResponse(response, TEST_AGENT, [], [h]);
    expect(result.hasToolsOrApprovalsToRun()).toBe(true);
  });

  it('returns true when function calls are pending', () => {
    const result = processModelResponse(
      TEST_MODEL_RESPONSE_WITH_FUNCTION,
      TEST_AGENT,
      [TEST_TOOL],
      [],
    );
    expect(result.hasToolsOrApprovalsToRun()).toBe(true);
  });

  it('returns true when computer actions are pending', () => {
    const computer = computerTool({
      computer: {
        environment: 'mac',
        dimensions: [10, 10],
        screenshot: vi.fn(async () => 'img'),
        click: vi.fn(async () => {}),
        doubleClick: vi.fn(async () => {}),
        drag: vi.fn(async () => {}),
        keypress: vi.fn(async () => {}),
        move: vi.fn(async () => {}),
        scroll: vi.fn(async () => {}),
        type: vi.fn(async () => {}),
        wait: vi.fn(async () => {}),
      },
    });
    const compCall: protocol.ComputerUseCallItem = {
      id: 'c1',
      type: 'computer_call',
      callId: 'c1',
      status: 'completed',
      action: { type: 'screenshot' },
    };
    const response: ModelResponse = {
      output: [compCall],
      usage: new Usage(),
    } as any;

    const result = processModelResponse(response, TEST_AGENT, [computer], []);
    expect(result.hasToolsOrApprovalsToRun()).toBe(true);
  });

  it('returns false when no tools or approvals are pending', () => {
    const response: ModelResponse = {
      output: [TEST_MODEL_MESSAGE],
      usage: new Usage(),
    } as any;

    const result = processModelResponse(response, TEST_AGENT, [], []);
    expect(result.hasToolsOrApprovalsToRun()).toBe(false);
  });
});
