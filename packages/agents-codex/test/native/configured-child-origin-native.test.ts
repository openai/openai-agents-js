import { expect, it } from 'vitest';
import { Agent, NativeProvider, type Completed } from '../../src';

it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'attributes each configured child call and its result to the admitted declaration',
  async () => {
    let rootRequests = 0;
    let childRequests = 0;
    let childResult: Completed<string> | undefined;
    const usage = (input: number, output: number) => ({
      input_tokens: input,
      output_tokens: output,
      total_tokens: input + output,
    });
    const message = (text: string) => ({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    });
    await using childProvider = new NativeProvider({
      baseUrl: 'https://configured-child.invalid/v1',
      apiKey: 'synthetic-g14',
      supportsWebsockets: false,
      modelBackend: {
        complete(request) {
          childRequests++;
          expect(request.body.model).toBe('fixture-child');
          return {
            output: [message('child done')],
            usage: usage(7, 2),
            responseId: 'child-response',
          };
        },
      },
    });
    const child = new Agent({
      name: 'Worker',
      instructions: 'Finish the work.',
      model: 'fixture-child',
      provider: childProvider,
    });
    await using rootProvider = new NativeProvider({
      baseUrl: 'https://configured-parent.invalid/v1',
      apiKey: 'synthetic-g14',
      supportsWebsockets: false,
      modelBackend: {
        complete(request) {
          rootRequests++;
          expect(request.body.model).toBe('fixture-root');
          return rootRequests === 1
            ? {
                output: [
                  {
                    type: 'function_call',
                    id: 'delegate-item',
                    call_id: 'delegate-call',
                    name: 'delegate',
                    arguments: '{"input":"work"}',
                  },
                ],
                usage: usage(3, 1),
                responseId: 'parent-first',
              }
            : {
                output: [message('parent done')],
                usage: usage(5, 1),
                responseId: 'parent-last',
              };
        },
      },
    });
    const root = new Agent({
      name: 'Parent',
      instructions: 'Delegate then finish.',
      model: 'fixture-root',
      provider: rootProvider,
      tools: [
        child.asTool({
          toolName: 'delegate',
          customOutputExtractor(result) {
            childResult = result;
            return String(result.finalOutput);
          },
        }),
      ],
    });
    const result = await root.run('Start.', { returnItems: true });
    const items =
      result.items?.filter(
        ({ item }) => 'callId' in item && item.callId === 'delegate-call',
      ) ?? [];
    expect(rootRequests).toBe(2);
    expect(childRequests).toBe(1);
    expect(result.finalOutput).toBe('parent done');
    expect(items.map(({ item }) => item.type)).toEqual([
      'function_call',
      'function_call_output',
    ]);
    expect(items.map(({ toolOrigin }) => toolOrigin)).toEqual([
      { name: 'delegate', role: 'Worker' },
      { name: 'delegate', role: 'Worker' },
    ]);
    expect(childResult?.runUsage).toMatchObject({
      requests: 1,
      totalTokens: 9,
    });
    expect
      .soft(result.runUsage)
      .toMatchObject({ requests: 3, totalTokens: 19 });
  },
  20_000,
);
