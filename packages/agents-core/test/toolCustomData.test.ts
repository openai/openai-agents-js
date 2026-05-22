import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Agent } from '../src/agent';
import { RunToolCallOutputItem } from '../src/items';
import type { ModelRequest, ModelResponse } from '../src/model';
import type { MCPServer, MCPTool } from '../src/mcp';
import { attachCallToolResultMetadata, mcpToFunctionTool } from '../src/mcp';
import { run, Runner } from '../src/run';
import { RunContext } from '../src/runContext';
import { RunState } from '../src/runState';
import { applyPatchTool, computerTool, tool } from '../src/tool';
import {
  executeApplyPatchOperations,
  executeComputerActions,
} from '../src/runner/toolExecution';
import * as protocol from '../src/types/protocol';
import { ToolCallError, UserError } from '../src/errors';
import { Usage } from '../src/usage';
import { FakeComputer, FakeEditor, FakeModel, fakeModelMessage } from './stubs';

class RecordingModel extends FakeModel {
  readonly requests: ModelRequest[] = [];

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return super.getResponse(request);
  }
}

function toolOutputItem(items: unknown[]): RunToolCallOutputItem {
  const item = items.find(
    (candidate) => candidate instanceof RunToolCallOutputItem,
  );
  expect(item).toBeDefined();
  return item as RunToolCallOutputItem;
}

describe('tool output customData', () => {
  it('attaches function tool customData without replaying it to the model', async () => {
    const model = new RecordingModel([
      {
        output: [
          {
            type: 'function_call',
            name: 'get_data',
            callId: 'call_custom_data',
            status: 'completed',
            arguments: '{"key":"alpha"}',
          },
        ],
        usage: new Usage(),
      },
      {
        output: [fakeModelMessage('done')],
        usage: new Usage(),
      },
    ]);
    const getData = tool({
      name: 'get_data',
      description: 'Get data.',
      parameters: z.object({ key: z.string() }),
      execute: ({ key }) => `tool result for ${key}`,
      customDataExtractor: (context) => {
        (context.rawItem as any).providerData = { leaked: true };
        return {
          callId: context.rawItem.callId,
          output: context.output,
        };
      },
    });
    const agent = new Agent({
      name: 'CustomDataAgent',
      model,
      tools: [getData],
      toolUseBehavior: 'run_llm_again',
    });

    const result = await run(agent, 'start');

    const outputItem = toolOutputItem(result.newItems);
    expect(outputItem.customData).toEqual({
      callId: 'call_custom_data',
      output: 'tool result for alpha',
    });
    expect(outputItem.rawItem.providerData).toBeUndefined();

    const secondInput = model.requests[1].input as protocol.ModelItem[];
    expect(JSON.stringify(secondInput)).not.toContain('customData');
    expect(JSON.stringify(secondInput)).not.toContain('leaked');

    const restored = await RunState.fromString(agent, result.state.toString());
    const restoredOutput = toolOutputItem(restored._generatedItems);
    expect(restoredOutput.customData).toEqual(outputItem.customData);
    expect(JSON.stringify(restored.history)).not.toContain('customData');
  });

  it('rejects non-JSON-compatible customData', async () => {
    const model = new RecordingModel([
      {
        output: [
          {
            type: 'function_call',
            name: 'bad_data',
            callId: 'call_bad_data',
            status: 'completed',
            arguments: '{}',
          },
        ],
        usage: new Usage(),
      },
    ]);
    const badData = tool({
      name: 'bad_data',
      description: 'Return invalid custom data.',
      parameters: z.object({}),
      execute: () => 'ok',
      customDataExtractor: () => ({ bad: BigInt(1) }) as any,
    });
    const agent = new Agent({
      name: 'BadCustomDataAgent',
      model,
      tools: [badData],
    });

    const runPromise = run(agent, 'start');

    await expect(runPromise).rejects.toThrow(ToolCallError);
    await expect(runPromise).rejects.toThrow(
      'customDataExtractor must return JSON-compatible data.',
    );
    await runPromise.catch((error) => {
      expect(error).toBeInstanceOf(ToolCallError);
      expect((error as ToolCallError).error).toBeInstanceOf(UserError);
    });
  });

  it('maps local MCP result metadata to tool output customData', async () => {
    const model = new RecordingModel([
      {
        output: [
          {
            type: 'function_call',
            name: 'meta_tool',
            callId: 'call_mcp_meta',
            status: 'completed',
            arguments: '{}',
          },
        ],
        usage: new Usage(),
      },
      {
        output: [fakeModelMessage('done')],
        usage: new Usage(),
      },
    ]);
    const server: MCPServer = {
      name: 'meta-server',
      cacheToolsList: false,
      customDataExtractor: (context) => ({
        responseMeta: context.resultMeta,
        structuredContent: context.structuredContent,
        isError: context.isError,
        output: context.toolOutput,
      }),
      connect: async () => {},
      close: async () => {},
      listTools: async () => [],
      callTool: async () =>
        attachCallToolResultMetadata([{ type: 'text', text: 'mcp result' }], {
          _meta: { renderer: { type: 'chart' } },
          structuredContent: { rows: [{ x: 1, y: 2 }] },
          isError: false,
        }),
      invalidateToolsCache: async () => {},
    };
    const mcpTool = mcpToFunctionTool(
      {
        name: 'meta_tool',
        description: 'Returns metadata.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      } satisfies MCPTool,
      server,
      false,
    );
    const agent = new Agent({
      name: 'McpCustomDataAgent',
      model,
      tools: [mcpTool],
      toolUseBehavior: 'run_llm_again',
    });

    const result = await run(agent, 'start');

    const outputItem = toolOutputItem(result.newItems);
    expect(outputItem.customData).toEqual({
      responseMeta: { renderer: { type: 'chart' } },
      structuredContent: { rows: [{ x: 1, y: 2 }] },
      isError: false,
      output: { type: 'text', text: 'mcp result' },
    });
    expect(JSON.stringify(model.requests[1].input)).not.toContain('customData');
  });

  it('attaches computer tool customData', async () => {
    const computer = computerTool({
      computer: new FakeComputer(),
      customDataExtractor: (context) => ({
        callId: context.toolCall.callId,
        output: context.output,
      }),
    });
    const agent = new Agent({ name: 'ComputerAgent', tools: [computer] });
    const toolCall: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'call_computer',
      status: 'completed',
      action: { type: 'screenshot' },
    };

    const [item] = await executeComputerActions(
      agent,
      [{ toolCall, computer }],
      new Runner({ tracingDisabled: true }),
      new RunContext(),
    );

    expect(item).toBeInstanceOf(RunToolCallOutputItem);
    expect((item as RunToolCallOutputItem).customData).toEqual({
      callId: 'call_computer',
      output: 'data:image/png;base64,img',
    });
  });

  it('attaches apply_patch tool customData', async () => {
    const patchTool = applyPatchTool({
      editor: new FakeEditor(),
      customDataExtractor: (context) => {
        (context.rawItem as any).status = 'failed';
        return {
          status: context.status,
          path: context.operation.path,
        };
      },
    });
    const agent = new Agent({ name: 'PatchAgent', tools: [patchTool] });
    const toolCall: protocol.ApplyPatchCallItem = {
      type: 'apply_patch_call',
      callId: 'call_patch',
      status: 'completed',
      operation: {
        type: 'create_file',
        path: 'tasks.md',
        diff: '+hello\n',
      },
    };

    const [item] = await executeApplyPatchOperations(
      agent,
      [{ toolCall, applyPatch: patchTool }],
      new Runner({ tracingDisabled: true }),
      new RunContext(),
    );

    expect(item).toBeInstanceOf(RunToolCallOutputItem);
    expect((item as RunToolCallOutputItem).customData).toEqual({
      status: 'completed',
      path: 'tasks.md',
    });
    expect(
      (
        (item as RunToolCallOutputItem)
          .rawItem as protocol.ApplyPatchCallResultItem
      ).status,
    ).toBe('completed');
  });
});
