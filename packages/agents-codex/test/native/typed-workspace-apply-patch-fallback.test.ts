import { createOpenAI } from '@ai-sdk/openai';
import { expect, it } from 'vitest';
import {
  Agent,
  AiSdkModel,
  ChatCompletionsModel,
  NativeProvider,
  applyPatchBatchTool,
  applyPatchTool,
  type ApplyPatchOperation,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';

const operations = [
  { type: 'create_file', path: 'first.txt', diff: 'custom-create' },
  {
    type: 'update_file',
    path: 'source.txt',
    diff: 'custom-update',
    move_to: 'dest.txt',
  },
  { type: 'delete_file', path: 'last.txt' },
];
const receipts = ['created', 'editor rejected move', 'deleted'];

const routes = ['native-chat', 'ai-sdk-chat', 'ai-sdk-responses'] as const;
it.each(
  routes.flatMap((route) => [
    { route, batch: false },
    { route, batch: true },
  ]),
)(
  'replays structured editor results on $route (batch=$batch)',
  async ({ route, batch }) => {
    const toolName = batch ? 'apply_patch_batch' : 'apply_patch';
    const callCount = batch ? 1 : operations.length;
    const declaredEditor = batch ? applyPatchBatchTool : applyPatchTool;
    const requests: JsonObject[] = [];
    const edits: ApplyPatchOperation[] = [];
    const sharedData = { receipt: { ticket: '' } };
    const edit = (operation: ApplyPatchOperation) => {
      const index = edits.length;
      edits.push(operation);
      sharedData.receipt.ticket = 'private-g18-batch-ticket-' + index;
      return {
        status: index === 1 ? ('failed' as const) : ('completed' as const),
        output: receipts[index],
        applicationData: sharedData,
      };
    };
    const response = (request: JsonObject) => {
      requests.push(request);
      const operationIndex = requests.length - 1;
      const hasCall = operationIndex < callCount;
      const responseCalls = hasCall
        ? [
            {
              type: 'function_call',
              id: 'fc_patch_' + operationIndex,
              call_id: 'patch_' + operationIndex,
              name: toolName,
              status: 'completed',
              arguments: JSON.stringify(
                batch
                  ? { operations }
                  : { operation: operations[operationIndex] },
              ),
            },
          ]
        : [];
      if (route === 'ai-sdk-responses')
        return {
          id: 'resp_patch_' + requests.length,
          object: 'response',
          created_at: 0,
          status: 'completed',
          model: 'gpt-4.1',
          output: hasCall
            ? responseCalls
            : [
                {
                  type: 'message',
                  id: 'msg_patch',
                  status: 'completed',
                  role: 'assistant',
                  content: [
                    { type: 'output_text', text: 'finished', annotations: [] },
                  ],
                },
              ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        };
      return {
        id: 'chat_patch_' + requests.length,
        object: 'chat.completion',
        created: 0,
        model: 'gpt-4.1',
        choices: [
          {
            index: 0,
            finish_reason: hasCall ? 'tool_calls' : 'stop',
            message: hasCall
              ? {
                  role: 'assistant',
                  content: null,
                  tool_calls: responseCalls.map((call) => ({
                    type: 'function',
                    id: call.call_id,
                    function: { name: call.name, arguments: call.arguments },
                  })),
                }
              : { role: 'assistant', content: 'finished' },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    };
    const openai = createOpenAI({
      apiKey: 'synthetic',
      fetch: async (_url, init) =>
        Response.json(response(JSON.parse(String(init?.body)))),
    });
    const backend =
      route === 'native-chat'
        ? new ChatCompletionsModel({
            chat: { completions: { create: response } },
          })
        : new AiSdkModel(
            route === 'ai-sdk-chat'
              ? openai.chat('gpt-4.1')
              : openai.responses('gpt-4.1'),
          );
    await using provider = new NativeProvider({ modelBackend: backend });
    const agent = new Agent({
      model: 'gpt-4.1',
      modelSettings: { parallelToolCalls: false },
      instructions: 'Apply three structured editor operations.',
      provider,
      tools: [
        declaredEditor({
          editor: { createFile: edit, updateFile: edit, deleteFile: edit },
        }),
      ],
    });
    const result = await agent.run('Apply the edits.', { returnState: batch });
    expect(result.finalOutput).toBe('finished');
    if (batch) {
      const state = JSON.stringify(result.state);
      const positions = operations.map((_, index) =>
        state.indexOf('private-g18-batch-ticket-' + index),
      );
      expect(positions[0]).toBeGreaterThanOrEqual(0);
      expect(positions[1]).toBeGreaterThan(positions[0]);
      expect(positions[2]).toBeGreaterThan(positions[1]);
    }
    expect(edits).toEqual([
      { type: 'create_file', path: 'first.txt', diff: 'custom-create' },
      {
        type: 'update_file',
        path: 'source.txt',
        diff: 'custom-update',
        moveTo: 'dest.txt',
      },
      { type: 'delete_file', path: 'last.txt' },
    ]);
    expect(requests).toHaveLength(callCount + 1);
    const responses = route === 'ai-sdk-responses';
    const [tool] = requests[0].tools as any[];
    expect(responses ? tool : tool.function).toMatchObject({
      name: toolName,
      parameters: { required: [batch ? 'operations' : 'operation'] },
    });
    const history = (
      responses ? requests[callCount].input : requests[callCount].messages
    ) as any[];
    const calls = responses
      ? history
          .filter((item) => item.type === 'function_call')
          .map((item) => ({
            id: item.call_id,
            name: item.name,
            arguments: item.arguments,
          }))
      : history.flatMap((item) =>
          (item.tool_calls ?? []).map((call: any) => ({
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          })),
        );
    expect(calls.map((call) => call.id)).toEqual(
      Array.from({ length: callCount }, (_, index) => 'patch_' + index),
    );
    expect(calls.every((call) => call.name === toolName)).toBe(true);
    expect(calls.map((call) => JSON.parse(call.arguments))).toEqual(
      batch ? [{ operations }] : operations.map((operation) => ({ operation })),
    );
    const results = responses
      ? history
          .filter((item) => item.type === 'function_call_output')
          .map((item) => item.output)
      : history
          .filter((item) => item.role === 'tool')
          .map((item) => item.content);
    const expectedResults = receipts.map((output, index) => ({
      status: index === 1 ? 'failed' : 'completed',
      output,
    }));
    expect(
      results.map((item) =>
        JSON.parse(typeof item === 'string' ? item : item[0].text),
      ),
    ).toEqual(batch ? [{ results: expectedResults }] : expectedResults);
    expect(JSON.stringify(requests)).not.toContain('private-g18-batch-ticket');
  },
  30_000,
);
