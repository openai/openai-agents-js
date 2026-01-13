import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  setDefaultModelProvider,
  setTracingDisabled,
  withTrace,
} from '../../src';
import { Agent, AgentOutputType } from '../../src/agent';
import { Computer } from '../../src/computer';
import { ModelBehaviorError } from '../../src/errors';
import {
  RunToolApprovalItem as ToolApprovalItem,
  RunToolCallItem as ToolCallItem,
  RunToolCallOutputItem as ToolCallOutputItem,
} from '../../src/items';
import { ModelResponse } from '../../src/model';
import { processModelResponse } from '../../src/runner/modelOutputs';
import {
  resolveInterruptedTurn,
  resolveTurnAfterModelResponse,
} from '../../src/runner/turnResolution';
import { getToolCallOutputItem } from '../../src/runner/toolExecution';
import type { ProcessedResponse } from '../../src/runner/types';
import { RunContext } from '../../src/runContext';
import { RunState } from '../../src/runState';
import { Runner } from '../../src/run';
import {
  computerTool,
  applyPatchTool,
  shellTool,
  tool,
  hostedMcpTool,
} from '../../src/tool';
import { Usage } from '../../src/usage';
import {
  FakeEditor,
  FakeModelProvider,
  FakeShell,
  TEST_AGENT,
  TEST_MODEL_RESPONSE_BASIC,
  TEST_MODEL_FUNCTION_CALL,
  TEST_MODEL_MESSAGE,
  TEST_MODEL_RESPONSE_WITH_FUNCTION,
  TEST_TOOL,
  fakeModelMessage,
} from '../stubs';
import * as protocol from '../../src/types/protocol';
import { z } from 'zod';
import type { UnknownContext } from '../../src/types';

beforeAll(() => {
  setTracingDisabled(true);
  setDefaultModelProvider(new FakeModelProvider());
});

describe('resolveTurnAfterModelResponse', () => {
  let runner: Runner;
  let state: RunState<any, any>;

  beforeAll(() => {
    setDefaultModelProvider(new FakeModelProvider());
  });

  beforeEach(() => {
    runner = new Runner({ tracingDisabled: true });
    state = new RunState(new RunContext(), 'test input', TEST_AGENT, 1);
  });

  it('does not finalize when tools are used in the same turn (text output); runs again', async () => {
    const textAgent = new Agent({ name: 'TextAgent', outputType: 'text' });
    const processedResponse = processModelResponse(
      TEST_MODEL_RESPONSE_WITH_FUNCTION,
      textAgent,
      [TEST_TOOL],
      [],
    );

    expect(processedResponse.hasToolsOrApprovalsToRun()).toBe(true);

    const result = await withTrace('test', () =>
      resolveTurnAfterModelResponse(
        textAgent,
        'test input',
        [],
        TEST_MODEL_RESPONSE_WITH_FUNCTION,
        processedResponse,
        runner,
        state,
      ),
    );

    expect(result.nextStep.type).toBe('next_step_run_again');
  });

  it('emits hosted MCP approval responses when already approved', async () => {
    const agent = new Agent({ name: 'MCPAgent', outputType: 'text' });
    const approvalCall: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      name: 'approve_me',
      id: 'mcpr_approved',
      status: 'in_progress',
      providerData: {
        type: 'mcp_approval_request',
        server_label: 'server',
        name: 'approve_me',
        id: 'mcpr_approved',
        arguments: '{}',
        input_schema: {},
      },
    };
    const approvalItem = new ToolApprovalItem(approvalCall, agent);
    const processedResponse: ProcessedResponse = {
      newItems: [approvalItem],
      handoffs: [],
      functions: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [
        {
          requestItem: approvalItem,
          mcpTool: hostedMcpTool({
            serverLabel: 'server',
            requireApproval: 'always',
          }),
        },
      ],
      toolsUsed: [],
      hasToolsOrApprovalsToRun() {
        return true;
      },
    };
    const modelResponse: ModelResponse = {
      output: [],
      usage: new Usage(),
    } as any;
    const localState = new RunState(new RunContext(), 'hello', agent, 1);
    localState._context.approveTool(approvalItem);

    const result = await resolveTurnAfterModelResponse(
      agent,
      'hello',
      [],
      modelResponse,
      processedResponse,
      runner,
      localState,
    );

    expect(result.newStepItems).toContainEqual(
      expect.objectContaining({
        rawItem: expect.objectContaining({
          name: 'mcp_approval_response',
        }),
      }),
    );
  });

  it('does not finalize when tools are used in the same turn (structured output); runs again', async () => {
    const structuredAgent = new Agent({
      name: 'StructuredAgent',
      outputType: z.object({
        foo: z.string(),
      }),
    });

    const structuredResponse: ModelResponse = {
      output: [
        { ...TEST_MODEL_FUNCTION_CALL },
        fakeModelMessage('{"foo":"bar"}'),
      ],
      usage: new Usage(),
    } as any;

    const processedResponse = processModelResponse(
      structuredResponse,
      structuredAgent,
      [TEST_TOOL],
      [],
    );

    expect(processedResponse.hasToolsOrApprovalsToRun()).toBe(true);

    const structuredState = new RunState(
      new RunContext(),
      'test input',
      structuredAgent,
      1,
    );

    const result = await withTrace('test', () =>
      resolveTurnAfterModelResponse(
        structuredAgent,
        'test input',
        [],
        structuredResponse,
        processedResponse,
        runner,
        structuredState,
      ),
    );

    expect(result.nextStep.type).toBe('next_step_run_again');
  });

  it('returns final output when text agent has no tools pending', async () => {
    const textAgent = new Agent({ name: 'TextAgent', outputType: 'text' });
    const response: ModelResponse = {
      output: [TEST_MODEL_MESSAGE],
      usage: new Usage(),
    } as any;
    const processedResponse = processModelResponse(response, textAgent, [], []);

    expect(processedResponse.hasToolsOrApprovalsToRun()).toBe(false);

    const result = await withTrace('test', () =>
      resolveTurnAfterModelResponse(
        textAgent,
        'test input',
        [],
        response,
        processedResponse,
        runner,
        state,
      ),
    );

    expect(result.nextStep.type).toBe('next_step_final_output');
    if (result.nextStep.type === 'next_step_final_output') {
      expect(result.nextStep.output).toBe('Hello World');
    }
  });

  it('returns final output when final message text is empty', async () => {
    const textAgent = new Agent({ name: 'TextAgent', outputType: 'text' });
    const imageCall: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      id: 'img1',
      name: 'image_generation_call',
      status: 'completed',
      output: 'iVBORw0KGgoAAAANSUhEUgAABAAAAAYACAIAAABn4K39AAHH1....',
      providerData: { type: 'image_generation_call' },
    };
    const emptyMessage: protocol.AssistantMessageItem = {
      id: 'msg1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: '' }],
    };
    const response: ModelResponse = {
      output: [imageCall, emptyMessage],
      usage: new Usage(),
    } as any;
    const processedResponse = processModelResponse(response, textAgent, [], []);

    expect(processedResponse.hasToolsOrApprovalsToRun()).toBe(false);

    const result = await withTrace('test', () =>
      resolveTurnAfterModelResponse(
        textAgent,
        'test input',
        [],
        response,
        processedResponse,
        runner,
        state,
      ),
    );

    expect(result.nextStep.type).toBe('next_step_final_output');
    if (result.nextStep.type === 'next_step_final_output') {
      expect(result.nextStep.output).toBe('');
    }
  });

  it('validates structured output types and throws ModelBehaviorError', async () => {
    const structuredAgent = new Agent({
      name: 'StructuredAgent',
      outputType: z.object({
        foo: z.string(),
      }),
    });

    const badResponse: ModelResponse = {
      output: [fakeModelMessage('invalid structured output')],
      usage: new Usage(),
    } as any;

    const processedResponse = processModelResponse(
      badResponse,
      structuredAgent,
      [],
      [],
    );

    await expect(
      resolveTurnAfterModelResponse(
        structuredAgent,
        'test input',
        [],
        badResponse,
        processedResponse,
        runner,
        state,
      ),
    ).rejects.toBeInstanceOf(ModelBehaviorError);
  });
});

describe('resolveInterruptedTurn', () => {
  it('ignores already-completed approvals when resuming', async () => {
    const agent = new Agent({ name: 'rewind-agent2' });
    const state = new RunState(new RunContext(), 'hello', agent, 1);

    const approvalItem = new ToolApprovalItem(
      {
        type: 'function_call',
        name: 't',
        callId: 'c1',
        arguments: '{}',
        status: 'in_progress',
      },
      agent,
    );
    const completionItem = new ToolCallOutputItem(
      getToolCallOutputItem(
        approvalItem.rawItem as protocol.FunctionCallItem,
        'done',
      ),
      agent,
      'done',
    );
    state._currentTurnPersistedItemCount = 2;
    const preStepItems = [approvalItem, completionItem];
    state._currentStep = {
      type: 'next_step_interruption',
      data: { interruptions: [approvalItem] },
    };

    const processedResponse: ProcessedResponse = {
      newItems: [],
      handoffs: [],
      functions: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
      hasToolsOrApprovalsToRun: () => false,
    };

    await resolveInterruptedTurn(
      agent,
      'input',
      preStepItems,
      TEST_MODEL_RESPONSE_BASIC,
      processedResponse,
      new Runner(),
      state,
    );

    expect(state._currentTurnPersistedItemCount).toBe(1);
  });

  it('rewinds persisted count only for pending approval placeholders', async () => {
    const textAgent = new Agent<UnknownContext, 'text'>({
      name: 'SequentialApprovalsAgent',
      outputType: 'text',
    });
    const agent = textAgent as unknown as Agent<
      UnknownContext,
      AgentOutputType
    >;
    const firstCall: protocol.FunctionCallItem = {
      ...TEST_MODEL_FUNCTION_CALL,
      id: 'call-first',
      callId: 'call-first',
    };
    const secondCall: protocol.FunctionCallItem = {
      ...TEST_MODEL_FUNCTION_CALL,
      id: 'call-second',
      callId: 'call-second',
    };

    const firstApproval = new ToolApprovalItem(firstCall, agent);
    const firstOutputRaw = getToolCallOutputItem(firstCall, 'done');
    const firstOutput = new ToolCallOutputItem(firstOutputRaw, agent, 'done');
    const secondApproval = new ToolApprovalItem(secondCall, agent);

    const generatedItems = [firstApproval, firstOutput, secondApproval];
    const state = new RunState(new RunContext(), 'hello', agent, 5);
    state._generatedItems = generatedItems;
    state._currentTurnPersistedItemCount = generatedItems.length;
    state._currentStep = {
      type: 'next_step_interruption',
      data: {
        interruptions: [secondApproval],
      },
    };

    const processedResponse: ProcessedResponse = {
      newItems: [],
      handoffs: [],
      functions: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
      hasToolsOrApprovalsToRun() {
        return false;
      },
    };

    const runner = new Runner({ tracingDisabled: true });
    const modelResponse: ModelResponse = {
      output: [],
      usage: new Usage(),
    } as any;

    const result = await resolveInterruptedTurn(
      agent,
      'hello',
      generatedItems,
      modelResponse,
      processedResponse,
      runner,
      state,
    );

    expect(state._currentTurnPersistedItemCount).toBe(
      generatedItems.length - 1,
    );
    // Only the still-pending approval (secondApproval) should remain alongside prior outputs.
    expect(result.preStepItems).toEqual([firstOutput, secondApproval]);
  });

  it('retains non-hosted approvals when resuming interruptions', async () => {
    const agent = new Agent({ name: 'KeepApprovalAgent' });
    const approvalCall: protocol.FunctionCallItem = {
      ...TEST_MODEL_FUNCTION_CALL,
      id: 'call-keep',
      callId: 'call-keep',
      name: 'keep_tool',
    };
    const approvalItem = new ToolApprovalItem(approvalCall, agent);
    const originalPreStepItems = [approvalItem];

    const processedResponse: ProcessedResponse = {
      newItems: [approvalItem],
      handoffs: [],
      functions: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
      hasToolsOrApprovalsToRun() {
        return true;
      },
    };

    const runner = new Runner({ tracingDisabled: true });
    const resumedState = new RunState(new RunContext(), 'hello', agent, 2);
    resumedState._currentStep = {
      type: 'next_step_interruption',
      data: { interruptions: [approvalItem] },
    };

    const resumedResponse: ModelResponse = {
      output: [],
      usage: new Usage(),
    } as any;

    const result = await resolveInterruptedTurn(
      agent,
      'hello',
      originalPreStepItems,
      resumedResponse,
      processedResponse,
      runner,
      resumedState,
    );

    expect(result.generatedItems).toContain(approvalItem);
  });

  it('dispatches approved computer actions when resuming an interruption', async () => {
    const fakeComputer: Computer = {
      environment: 'mac',
      dimensions: [1, 1],
      screenshot: vi.fn().mockResolvedValue('img'),
      click: vi.fn(async () => {}),
      doubleClick: vi.fn(async () => {}),
      drag: vi.fn(async () => {}),
      keypress: vi.fn(async () => {}),
      move: vi.fn(async () => {}),
      scroll: vi.fn(async () => {}),
      type: vi.fn(async () => {}),
      wait: vi.fn(async () => {}),
    };
    const computer = computerTool({ computer: fakeComputer });
    const agent = new Agent({ name: 'ComputerAgent', tools: [computer] });
    const computerCall: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      id: 'comp1',
      callId: 'comp1',
      status: 'in_progress',
      action: { type: 'screenshot' } as any,
    };
    const processedResponse: ProcessedResponse<UnknownContext> = {
      newItems: [new ToolCallItem(computerCall, agent)],
      handoffs: [],
      functions: [],
      computerActions: [{ toolCall: computerCall, computer }],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [computer.name],
      hasToolsOrApprovalsToRun() {
        return true;
      },
    };

    const runner = new Runner({ tracingDisabled: true });
    const state = new RunState(new RunContext(), 'hello', agent, 1);
    const approvalSpy = vi
      .spyOn(state._context, 'isToolApproved')
      .mockImplementation(({ toolName, callId }) => {
        if (toolName === computer.name && callId === computerCall.callId) {
          return true as any;
        }
        return undefined as any;
      });

    const originalItems = [new ToolCallItem(computerCall, agent)];
    const resumedResponse: ModelResponse = {
      output: [],
      usage: new Usage(),
    } as any;

    const result = await resolveInterruptedTurn(
      agent,
      'hello',
      originalItems,
      resumedResponse,
      processedResponse,
      runner,
      state,
    );

    approvalSpy.mockRestore();

    const toolOutputs = result.newStepItems.filter(
      (item): item is ToolCallOutputItem => item instanceof ToolCallOutputItem,
    );

    expect(toolOutputs).toHaveLength(1);
    expect(
      (toolOutputs[0].rawItem as protocol.ComputerCallResultItem).callId,
    ).toBe(computerCall.callId);
    expect(fakeComputer.screenshot).toHaveBeenCalledTimes(1);
  });

  it('skips rerunning already completed computer actions when resuming an interruption', async () => {
    const fakeComputer: Computer = {
      environment: 'mac',
      dimensions: [1, 1],
      screenshot: vi.fn().mockResolvedValue('img'),
      click: vi.fn(async () => {}),
      doubleClick: vi.fn(async () => {}),
      drag: vi.fn(async () => {}),
      keypress: vi.fn(async () => {}),
      move: vi.fn(async () => {}),
      scroll: vi.fn(async () => {}),
      type: vi.fn(async () => {}),
      wait: vi.fn(async () => {}),
    };
    const computer = computerTool({ computer: fakeComputer });
    const agent = new Agent({ name: 'ComputerAgent', tools: [computer] });
    const computerCall: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      id: 'comp1',
      callId: 'comp1',
      status: 'completed',
      action: { type: 'screenshot' } as any,
    };
    const computerResult: protocol.ComputerCallResultItem = {
      type: 'computer_call_result',
      callId: 'comp1',
      output: { type: 'computer_screenshot', data: 'data:image/png;base64,ok' },
    };

    const processedResponse: ProcessedResponse<UnknownContext> = {
      newItems: [new ToolCallItem(computerCall, agent)],
      handoffs: [],
      functions: [],
      computerActions: [{ toolCall: computerCall, computer }],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [computer.name],
      hasToolsOrApprovalsToRun() {
        return true;
      },
    };

    const runner = new Runner({ tracingDisabled: true });
    const state = new RunState(new RunContext(), 'hello', agent, 1);
    const modelResponse: ModelResponse = {
      output: [],
      usage: new Usage(),
    } as any;

    const originalItems = [
      new ToolCallItem(computerCall, agent),
      new ToolCallOutputItem(computerResult, agent, ''),
    ];

    const result = await resolveInterruptedTurn(
      agent,
      'hello',
      originalItems,
      modelResponse,
      processedResponse,
      runner,
      state,
    );

    const toolOutputs = result.newStepItems.filter(
      (item): item is ToolCallOutputItem => item instanceof ToolCallOutputItem,
    );

    expect(toolOutputs).toHaveLength(0);
    expect(fakeComputer.screenshot).not.toHaveBeenCalled();
  });

  it('runs shell actions after approval when resuming an interruption', async () => {
    const shell = new FakeShell();
    const shellToolDef = shellTool({
      shell,
      needsApproval: async () => true,
    });
    const agent = new Agent({ name: 'ShellAgent', tools: [shellToolDef] });
    const shellCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell',
      status: 'completed',
      action: { commands: ['echo hi'] },
    };
    const processedResponse: ProcessedResponse<UnknownContext> = {
      newItems: [new ToolCallItem(shellCall, agent)],
      handoffs: [],
      functions: [],
      computerActions: [],
      shellActions: [{ toolCall: shellCall, shell: shellToolDef }],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [shellToolDef.name],
      hasToolsOrApprovalsToRun() {
        return true;
      },
    };

    const runner = new Runner({ tracingDisabled: true });
    const state = new RunState(new RunContext(), 'hello', agent, 1);
    const modelResponse: ModelResponse = {
      output: [],
      usage: new Usage(),
    } as any;

    const approvalItem = new ToolApprovalItem(shellCall, agent, 'shell');
    state._currentStep = {
      type: 'next_step_interruption',
      data: { interruptions: [approvalItem] },
    };
    state._context.approveTool(approvalItem);

    const result = await resolveInterruptedTurn(
      agent,
      'hello',
      [new ToolCallItem(shellCall, agent), approvalItem],
      modelResponse,
      processedResponse,
      runner,
      state,
    );

    const toolOutputs = result.newStepItems.filter(
      (item): item is ToolCallOutputItem => item instanceof ToolCallOutputItem,
    );

    expect(toolOutputs).toHaveLength(1);
    expect(shell.calls).toHaveLength(1);
  });

  it('runs apply_patch operations after approval when resuming an interruption', async () => {
    const editor = new FakeEditor();
    const applyPatch = applyPatchTool({
      editor,
      needsApproval: async () => true,
    });
    const agent = new Agent({ name: 'EditorAgent', tools: [applyPatch] });
    const toolCall: protocol.ApplyPatchCallItem = {
      type: 'apply_patch_call',
      callId: 'call_patch',
      status: 'completed',
      operation: {
        type: 'update_file',
        path: 'README.md',
        diff: 'diff --git',
      },
    };
    const processedResponse: ProcessedResponse<UnknownContext> = {
      newItems: [new ToolCallItem(toolCall, agent)],
      handoffs: [],
      functions: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [{ toolCall, applyPatch }],
      mcpApprovalRequests: [],
      toolsUsed: [applyPatch.name],
      hasToolsOrApprovalsToRun() {
        return true;
      },
    };

    const runner = new Runner({ tracingDisabled: true });
    const state = new RunState(new RunContext(), 'hello', agent, 1);
    const modelResponse: ModelResponse = {
      output: [],
      usage: new Usage(),
    } as any;

    const approvalItem = new ToolApprovalItem(toolCall, agent, applyPatch.name);
    state._currentStep = {
      type: 'next_step_interruption',
      data: { interruptions: [approvalItem] },
    };
    state._context.approveTool(approvalItem);

    const result = await resolveInterruptedTurn(
      agent,
      'hello',
      [new ToolCallItem(toolCall, agent), approvalItem],
      modelResponse,
      processedResponse,
      runner,
      state,
    );

    const toolOutputs = result.newStepItems.filter(
      (item): item is ToolCallOutputItem => item instanceof ToolCallOutputItem,
    );

    expect(toolOutputs).toHaveLength(1);
    expect(editor.operations).toHaveLength(1);
  });

  it('does not rerun completed tools when approvals are handled across resumes', async () => {
    const executedFunctionCallIds: string[] = [];
    const approvalTool = tool({
      name: 'approval_tool',
      description: 'Approval-gated tool.',
      parameters: z.object({}),
      needsApproval: async () => true,
      execute: async (_input, _context, details) => {
        const callId = details?.toolCall?.callId;
        if (callId) {
          executedFunctionCallIds.push(callId);
        }
        return 'ok';
      },
    });

    const shell = new FakeShell();
    const shellToolDef = shellTool({
      shell,
      needsApproval: async () => true,
    });

    const editor = new FakeEditor();
    const applyPatch = applyPatchTool({
      editor,
      needsApproval: async () => true,
    });

    const agent = new Agent({
      name: 'MultiApprovalAgent',
      tools: [approvalTool, shellToolDef, applyPatch],
    });

    const functionCall1: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'call-func-1',
      callId: 'call-func-1',
      status: 'completed',
      name: approvalTool.name,
      arguments: '{}',
    };
    const functionCall2: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'call-func-2',
      callId: 'call-func-2',
      status: 'completed',
      name: approvalTool.name,
      arguments: '{}',
    };
    const shellCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call-shell',
      status: 'completed',
      action: { commands: ['echo hi'] },
    };
    const patchCall: protocol.ApplyPatchCallItem = {
      type: 'apply_patch_call',
      callId: 'call-patch',
      status: 'completed',
      operation: {
        type: 'update_file',
        path: 'README.md',
        diff: 'diff --git',
      },
    };

    const functionApproval1 = new ToolApprovalItem(functionCall1, agent);
    const functionApproval2 = new ToolApprovalItem(functionCall2, agent);
    const shellApproval = new ToolApprovalItem(
      shellCall,
      agent,
      shellToolDef.name,
    );
    const patchApproval = new ToolApprovalItem(
      patchCall,
      agent,
      applyPatch.name,
    );

    const processedResponse: ProcessedResponse<UnknownContext> = {
      newItems: [],
      handoffs: [],
      functions: [
        { toolCall: functionCall1, tool: approvalTool as any },
        { toolCall: functionCall2, tool: approvalTool as any },
      ],
      computerActions: [],
      shellActions: [{ toolCall: shellCall, shell: shellToolDef }],
      applyPatchActions: [{ toolCall: patchCall, applyPatch }],
      mcpApprovalRequests: [],
      toolsUsed: [],
      hasToolsOrApprovalsToRun() {
        return true;
      },
    };

    const runner = new Runner({ tracingDisabled: true });
    const state = new RunState(new RunContext(), 'hello', agent, 5);
    const modelResponse: ModelResponse = {
      output: [],
      usage: new Usage(),
    } as any;

    const originalItems = [
      new ToolCallItem(functionCall1, agent),
      functionApproval1,
      new ToolCallItem(functionCall2, agent),
      functionApproval2,
      new ToolCallItem(shellCall, agent),
      shellApproval,
      new ToolCallItem(patchCall, agent),
      patchApproval,
    ];
    state._generatedItems = originalItems;
    state._currentStep = {
      type: 'next_step_interruption',
      data: {
        interruptions: [
          shellApproval,
          functionApproval1,
          patchApproval,
          functionApproval2,
        ],
      },
    };

    state._context.approveTool(shellApproval);
    let result = await withTrace('test', () =>
      resolveInterruptedTurn(
        agent,
        'hello',
        state._generatedItems,
        modelResponse,
        processedResponse,
        runner,
        state,
      ),
    );
    state._generatedItems = result.generatedItems;
    state._currentStep = result.nextStep;
    expect(shell.calls).toHaveLength(1);
    expect(editor.operations).toHaveLength(0);
    expect(executedFunctionCallIds).toEqual([]);

    state._context.approveTool(functionApproval1);
    result = await withTrace('test', () =>
      resolveInterruptedTurn(
        agent,
        'hello',
        state._generatedItems,
        modelResponse,
        processedResponse,
        runner,
        state,
      ),
    );
    state._generatedItems = result.generatedItems;
    state._currentStep = result.nextStep;
    expect(shell.calls).toHaveLength(1);
    expect(editor.operations).toHaveLength(0);
    expect(executedFunctionCallIds).toEqual(['call-func-1']);

    state._context.approveTool(patchApproval);
    result = await withTrace('test', () =>
      resolveInterruptedTurn(
        agent,
        'hello',
        state._generatedItems,
        modelResponse,
        processedResponse,
        runner,
        state,
      ),
    );
    state._generatedItems = result.generatedItems;
    state._currentStep = result.nextStep;
    expect(shell.calls).toHaveLength(1);
    expect(editor.operations).toHaveLength(1);
    expect(executedFunctionCallIds).toEqual(['call-func-1']);

    state._context.approveTool(functionApproval2);
    result = await withTrace('test', () =>
      resolveInterruptedTurn(
        agent,
        'hello',
        state._generatedItems,
        modelResponse,
        processedResponse,
        runner,
        state,
      ),
    );
    expect(shell.calls).toHaveLength(1);
    expect(editor.operations).toHaveLength(1);
    expect(executedFunctionCallIds).toEqual(['call-func-1', 'call-func-2']);
    expect(result.nextStep.type).toBe('next_step_run_again');
  });

  it('removes resolved hosted MCP approvals but keeps unresolved ones', async () => {
    const agent = new Agent({ name: 'MCPAgent' });
    const approvalCall: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      name: 'mcp_approval_request',
      id: 'mcpr_123',
      status: 'in_progress',
      providerData: {
        type: 'mcp_approval_request',
        server_label: 'server',
        name: 'approve_me',
        id: 'mcpr_123',
        arguments: '{}',
        input_schema: {},
      },
    };
    const approvalItem = new ToolApprovalItem(approvalCall, agent);
    const originalPreStepItems = [approvalItem];

    const processedResponse: ProcessedResponse = {
      newItems: [approvalItem],
      handoffs: [],
      functions: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [
        {
          requestItem: approvalItem,
          mcpTool: {
            type: 'hosted_tool',
            name: 'hosted_mcp',
            providerData: { server_label: 'server', type: 'mcp' },
          } as any,
        },
      ],
      toolsUsed: [],
      hasToolsOrApprovalsToRun() {
        return true;
      },
    };

    const runner = new Runner({ tracingDisabled: true });
    const state = new RunState(new RunContext(), 'hello', agent, 1);
    const modelResponse: ModelResponse = {
      output: [],
      usage: new Usage(),
    } as any;

    state._context.approveTool(approvalItem);

    const result = await resolveInterruptedTurn(
      agent,
      'hello',
      originalPreStepItems,
      modelResponse,
      processedResponse,
      runner,
      state,
    );

    expect(result.preStepItems).not.toContain(approvalItem);
    expect(result.newStepItems).toContainEqual(
      expect.objectContaining({
        rawItem: expect.objectContaining({
          name: 'mcp_approval_response',
        }),
      }),
    );
  });
});
