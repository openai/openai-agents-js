import { describe, expect, it, vi } from 'vitest';

import {
  Agent,
  defineToolInputGuardrail,
  defineToolOutputGuardrail,
  RunState,
  RunToolCallOutputItem,
  run,
  ToolGuardrailFunctionOutputFactory,
} from '../src';
import type { MCPServer, MCPTool } from '../src/mcp';
import { getAllMcpTools } from '../src/mcp';
import { ScriptedModel } from '../src/testing';
import type * as protocol from '../src/types/protocol';

function functionToolCall(
  name: string,
  args: string,
  callId = 'mcp-call',
): protocol.FunctionCallItem {
  return {
    id: `fc_${callId}`,
    type: 'function_call',
    name,
    callId,
    status: 'completed',
    arguments: args,
    providerData: {},
  };
}

function textMessage(text: string): protocol.AssistantMessageItem {
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text,
        providerData: { annotations: [] },
      },
    ],
    providerData: {},
  };
}

function mcpTool(name: string): MCPTool {
  return {
    name,
    description: '',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  };
}

async function runInMode(
  agent: Agent<any, any>,
  input: string | RunState<any, any>,
  stream: boolean,
  preApprovalInputGuardrails = false,
): Promise<any> {
  const options = {
    tracingDisabled: true,
    toolExecution: { preApprovalInputGuardrails },
  };
  if (stream) {
    const result = await run(agent, input, { ...options, stream: true });
    await result.completed;
    return result;
  }
  return run(agent, input, options);
}

describe('MCP server tool guardrails', () => {
  it.each([false, true])(
    'blocks MCP input before the server call with stream=$stream',
    async (stream) => {
      const callTool = vi.fn(async () => [
        { type: 'text', text: 'unexpected output' },
      ]);
      const inputGuardrail = defineToolInputGuardrail({
        name: 'block-sensitive-input',
        run: async ({ toolCall }) => {
          expect(toolCall.name).toBe('sensitive');
          expect(toolCall.arguments).toBe('{"secret":"value"}');
          return ToolGuardrailFunctionOutputFactory.rejectContent(
            'blocked MCP input',
          );
        },
      });
      const server: MCPServer = {
        name: 'input-guarded-server',
        cacheToolsList: false,
        toolInputGuardrails: [inputGuardrail],
        connect: async () => {},
        close: async () => {},
        listTools: async () => [mcpTool('sensitive')],
        callTool,
        invalidateToolsCache: async () => {},
      };
      const model = new ScriptedModel([
        [functionToolCall('sensitive', '{"secret":"value"}')],
        [textMessage('done')],
      ]);
      const agent = new Agent({
        name: 'InputGuardedMcpAgent',
        model,
        mcpServers: [server],
      });

      const result = await runInMode(agent, 'call the tool', stream);

      expect(result.finalOutput).toBe('done');
      expect(callTool).not.toHaveBeenCalled();
      expect(result.toolInputGuardrailResults).toHaveLength(1);
      expect(JSON.stringify(model.lastCall?.request.input)).toContain(
        'blocked MCP input',
      );
      expect(JSON.stringify(model.lastCall?.request.input)).not.toContain(
        'unexpected output',
      );
    },
  );

  it.each([false, true])(
    'replaces MCP output before the next model input with stream=$stream',
    async (stream) => {
      const sensitiveOutput = 'sensitive MCP output';
      const replacementOutput = 'blocked MCP output';
      const callTool = vi.fn(async () => {
        throw new Error('callTool should not run when customData is enabled.');
      });
      const callToolResult = vi.fn(async () => ({
        content: [{ type: 'text' as const, text: sensitiveOutput }],
      }));
      const outputGuardrail = defineToolOutputGuardrail({
        name: 'block-sensitive-output',
        run: async ({ output }) => {
          expect(output).toEqual({ type: 'text', text: sensitiveOutput });
          return ToolGuardrailFunctionOutputFactory.rejectContent(
            replacementOutput,
          );
        },
      });
      const server: MCPServer = {
        name: 'output-guarded-server',
        cacheToolsList: false,
        toolOutputGuardrails: [outputGuardrail],
        customDataExtractor: ({ toolOutput }) => ({ output: toolOutput }),
        connect: async () => {},
        close: async () => {},
        listTools: async () => [mcpTool('lookup')],
        callTool,
        callToolResult,
        invalidateToolsCache: async () => {},
      };
      const model = new ScriptedModel([
        [functionToolCall('lookup', '{}')],
        [textMessage('done')],
      ]);
      const agent = new Agent({
        name: 'OutputGuardedMcpAgent',
        model,
        mcpServers: [server],
      });

      const result = await runInMode(agent, 'call the tool', stream);

      expect(result.finalOutput).toBe('done');
      expect(callTool).not.toHaveBeenCalled();
      expect(callToolResult).toHaveBeenCalledTimes(1);
      expect(result.toolOutputGuardrailResults).toHaveLength(1);
      expect(JSON.stringify(model.lastCall?.request.input)).toContain(
        replacementOutput,
      );
      expect(JSON.stringify(model.lastCall?.request.input)).not.toContain(
        sensitiveOutput,
      );

      const outputItem = result.newItems.find(
        (item: unknown) => item instanceof RunToolCallOutputItem,
      ) as RunToolCallOutputItem | undefined;
      expect(outputItem?.customData).toEqual({ output: replacementOutput });
      const serializedState = result.state.toString();
      expect(serializedState).toContain(replacementOutput);
      expect(serializedState).not.toContain(sensitiveOutput);
      const restored = await RunState.fromString(agent, serializedState);
      const restoredOutputItem = restored._generatedItems.find(
        (item) => item instanceof RunToolCallOutputItem,
      ) as RunToolCallOutputItem | undefined;
      expect(restoredOutputItem?.customData).toEqual({
        output: replacementOutput,
      });
    },
  );

  it.each([false, true])(
    'preserves approval and serialized resume ordering with stream=$stream',
    async (stream) => {
      const inputGuardrailRun = vi.fn(async () =>
        ToolGuardrailFunctionOutputFactory.allow(),
      );
      const server: MCPServer = {
        name: 'approval-guarded-server',
        cacheToolsList: false,
        toolInputGuardrails: [
          defineToolInputGuardrail({
            name: 'time-sensitive-check',
            run: inputGuardrailRun,
          }),
        ],
        connect: async () => {},
        close: async () => {},
        listTools: async () => [mcpTool('approved')],
        callTool: vi.fn(async () => [{ type: 'text', text: 'approved' }]),
        invalidateToolsCache: async () => {},
      };
      const [convertedTool] = await getAllMcpTools([server]);
      if (!convertedTool || convertedTool.type !== 'function') {
        throw new Error('Expected a converted MCP function tool.');
      }
      convertedTool.needsApproval = async () => true;
      const model = new ScriptedModel([
        [functionToolCall('approved', '{}', 'approval-call')],
      ]);
      const agent = new Agent({
        name: 'ApprovalGuardedMcpAgent',
        model,
        tools: [convertedTool],
        toolUseBehavior: 'stop_on_first_tool',
      });

      const first = await runInMode(agent, 'call the tool', stream, true);

      expect(first.interruptions).toHaveLength(1);
      expect(inputGuardrailRun).toHaveBeenCalledTimes(1);
      expect(server.callTool).not.toHaveBeenCalled();

      const restored = await RunState.fromString(agent, first.state.toString());
      restored.approve(restored.getInterruptions()[0]);
      const resumed = await runInMode(agent, restored, stream, true);

      expect(resumed.interruptions).toHaveLength(0);
      expect(inputGuardrailRun).toHaveBeenCalledTimes(2);
      expect(server.callTool).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
    },
  );
});
