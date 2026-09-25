import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { Agent, Runner, type Model } from '@openai/agents-core';
import { OpenAIResponsesModel } from '../src/openaiResponsesModel';

type CapturedRequest = {
  url: URL;
  headers: Headers;
  body: Record<string, any>;
};

function response(output: unknown[]) {
  return new Response(
    JSON.stringify({
      id: 'resp_test',
      object: 'response',
      status: 'completed',
      output,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

function message(text: string) {
  return {
    type: 'message',
    id: 'msg_test',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

describe('Agent.asTool transport inheritance', () => {
  it.each(['agent', 'runConfig', 'named', 'default'] as const)(
    'respects client ownership for the %s model selection',
    async (selection) => {
      const requests: CapturedRequest[] = [];
      const isolated = selection === 'agent' || selection === 'runConfig';
      const parentData = {
        extra_headers: { 'x-parent-header': 'parent-sentinel' },
        extraHeaders: { 'x-parent-camel': 'parent-camel-sentinel' },
        extra_query: { parent_query: 'parent-sentinel' },
        extraQuery: { parent_camel: 'parent-camel-sentinel' },
        extra_body: { parent_body: 'parent-sentinel' },
        extraBody: { parent_camel_body: 'parent-camel-sentinel' },
        store: false,
      };
      const originalParentData = structuredClone(parentData);
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const body = (await request.json()) as Record<string, any>;
        requests.push({
          url: new URL(request.url),
          headers: request.headers,
          body,
        });
        if (requests.length === 1) {
          return response([
            {
              type: 'function_call',
              id: 'fc_delegate',
              call_id: 'call_delegate',
              name: 'delegate',
              arguments: JSON.stringify({ input: 'child input' }),
              status: 'completed',
            },
          ]);
        }
        return response([message('done')]);
      };
      const parentModel = new OpenAIResponsesModel(
        new OpenAI({
          apiKey: 'synthetic-parent-key',
          baseURL: 'https://parent.invalid/v1',
          fetch,
          maxRetries: 0,
        }),
        'test-parent',
      );
      const childModel = new OpenAIResponsesModel(
        new OpenAI({
          apiKey: 'synthetic-child-key',
          baseURL: 'https://child.invalid/v1',
          fetch,
          maxRetries: 0,
        }),
        'test-child',
      );
      const child = new Agent({
        name: 'child',
        model:
          selection === 'agent'
            ? childModel
            : selection === 'named'
              ? 'named-child'
              : undefined,
      });
      const parent = new Agent({
        name: 'parent',
        tools: [
          child.asTool({
            toolName: 'delegate',
            toolDescription: 'Delegate a task.',
            runConfig: {
              // A named Agent model takes precedence over this explicit model.
              model:
                selection === 'runConfig' || selection === 'named'
                  ? childModel
                  : undefined,
              ...(selection === 'agent'
                ? {}
                : {
                    modelSettings: {
                      providerData: {
                        extraHeaders: { 'x-child-header': 'child-sentinel' },
                        extraQuery: { child_query: 'child-sentinel' },
                        extraBody: { child_body: 'child-sentinel' },
                      },
                    },
                  }),
            },
          }),
        ],
      });
      const runner = new Runner({
        modelProvider: { getModel: async (): Promise<Model> => parentModel },
        modelSettings: { temperature: 0.2, providerData: parentData },
        tracingDisabled: true,
      });
      const result = await runner.run(parent, 'delegate this');
      expect(result.finalOutput).toBe('done');
      expect(requests).toHaveLength(3);
      const childRequest = requests[1];
      expect(childRequest.url.hostname).toBe(
        isolated ? 'child.invalid' : 'parent.invalid',
      );
      expect(childRequest.headers.get('authorization')).toBe(
        isolated ? 'Bearer synthetic-child-key' : 'Bearer synthetic-parent-key',
      );
      expect(childRequest.headers.get('x-parent-header')).toBe(
        isolated ? null : 'parent-sentinel',
      );
      expect(childRequest.headers.get('x-parent-camel')).toBe(
        isolated ? null : 'parent-camel-sentinel',
      );
      expect(childRequest.url.searchParams.get('parent_query')).toBe(
        isolated ? null : 'parent-sentinel',
      );
      expect(childRequest.url.searchParams.get('parent_camel')).toBe(
        isolated ? null : 'parent-camel-sentinel',
      );
      expect(childRequest.body.parent_body).toBe(
        isolated ? undefined : 'parent-sentinel',
      );
      expect(childRequest.body.parent_camel_body).toBe(
        isolated ? undefined : 'parent-camel-sentinel',
      );
      expect(childRequest.headers.get('x-child-header')).toBe(
        selection === 'agent' ? null : 'child-sentinel',
      );
      expect(childRequest.url.searchParams.get('child_query')).toBe(
        selection === 'agent' ? null : 'child-sentinel',
      );
      expect(childRequest.body.child_body).toBe(
        selection === 'agent' ? undefined : 'child-sentinel',
      );
      expect(childRequest.body.temperature).toBe(0.2);
      expect(childRequest.body.store).toBe(false);
      expect(parentData).toEqual(originalParentData);
      expect(requests[2].headers.get('x-parent-header')).toBe(
        'parent-sentinel',
      );
    },
  );
});
