import { Buffer } from 'node:buffer';
import { expect, it } from 'vitest';
import {
  AiSdkModel,
  type AiSdkLanguageModel,
  type ModelRequest,
} from '../src/runtime/models';

const usage = { inputTokens: { total: 9 }, outputTokens: { total: 4 } };
function response() {
  return {
    finishReason: { unified: 'length', raw: 'MAX_TOKENS' },
    response: { id: 'provider-response' },
    usage: structuredClone(usage),
    content: [
      {
        type: 'text',
        text: 'partial 海豚',
        providerMetadata: { private: 'private-token' },
      },
      {
        type: 'tool-call',
        toolCallId: 'call-danger',
        toolName: 'danger',
        input: '{"payload":"private-tool-argument"}',
      },
    ],
  };
}
function model(result: ReturnType<typeof response>): AiSdkLanguageModel {
  return {
    specificationVersion: 'v3',
    provider: 'fixture',
    modelId: 'incomplete',
    doGenerate() {
      return result;
    },
    doStream() {
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: 'response-metadata',
              id: result.response.id,
            });
            controller.enqueue({
              type: 'text-delta',
              id: 'text',
              delta: 'partial 海豚',
            });
            controller.enqueue(result.content[1]);
            controller.enqueue({
              type: 'response-metadata',
              id: result.response.id,
            });
            controller.enqueue({
              type: 'finish',
              finishReason: result.finishReason,
              usage: result.usage,
            });
            controller.close();
          },
        }),
      };
    },
  };
}
function request(reportUsage: ModelRequest['reportUsage']): ModelRequest {
  return {
    body: {
      input: [],
      tools: [
        {
          type: 'function',
          name: 'danger',
          parameters: {
            type: 'object',
            properties: { payload: { type: 'string' } },
          },
        },
      ],
    },
    context: null,
    sessionId: 'incomplete',
    turnId: 'turn',
    signal: new AbortController().signal,
    reportUsage,
  };
}
function diagnostic(error: unknown): Record<string, unknown> {
  expect(error).toBeInstanceOf(TypeError);
  const cause = (error as Error).cause;
  if (!cause || typeof cause !== 'object' || Array.isArray(cause))
    throw new Error('Expected diagnostic cause');
  return cause as Record<string, unknown>;
}
it.each([false, true])(
  'retains incomplete diagnostics and reports one attempt (stream=%s)',
  async (stream) => {
    const result = response();
    const adapter = new AiSdkModel(model(result), {}, { stream });
    const measurements: unknown[] = [],
      events: Record<string, unknown>[] = [];
    const input = request((value) => {
      measurements.push(value);
    });
    let failure: unknown;
    try {
      if (stream) {
        for await (const event of adapter.stream!(input)) events.push(event);
      } else await adapter.complete(input);
    } catch (error) {
      failure = error;
    }
    const cause = diagnostic(failure);
    expect(cause).toEqual({
      finishReason: 'length',
      rawFinishReason: 'MAX_TOKENS',
      responseId: 'provider-response',
      partialText: 'partial 海豚',
      partialTextTruncated: false,
      usage: {
        input_tokens: 9,
        output_tokens: 4,
        total_tokens: 13,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        reasoning_output_tokens: 0,
      },
    });
    expect(measurements).toHaveLength(1);
    expect(measurements[0]).toMatchObject({
      inputTokens: 9,
      outputTokens: 4,
      totalTokens: 13,
    });
    expect(events.some((event) => event.type === 'response.completed')).toBe(
      false,
    );
    expect(JSON.stringify(cause)).not.toMatch(
      /private-token|private-tool-argument|call-danger/,
    );
    expect(Object.isFrozen(cause)).toBe(true);
    expect(Object.isFrozen(cause.usage)).toBe(true);
    result.content[0].text = 'provider mutation';
    result.usage.inputTokens.total = 999;
    expect(cause.partialText).toBe('partial 海豚');
    expect(cause.usage).toMatchObject({ input_tokens: 9 });
  },
);

it('bounds partial text by the existing response bytes without splitting Unicode', async () => {
  const result = response();
  result.content = [
    { type: 'text', text: 'x'.repeat(8 * 1024 * 1024 - 3) },
    { type: 'text', text: '🐬extra' },
  ] as ReturnType<typeof response>['content'];
  let failure: unknown;
  try {
    await new AiSdkModel(model(result)).complete(request(undefined));
  } catch (error) {
    failure = error;
  }
  const cause = diagnostic(failure);
  expect(cause.partialTextTruncated).toBe(true);
  expect(typeof cause.partialText).toBe('string');
  const text = cause.partialText as string;
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(text.endsWith('x')).toBe(true);
  expect(text).not.toContain('\uFFFD');
});

it('keeps other unfinished reasons under the original rejection', async () => {
  const result = response();
  result.finishReason = { unified: 'content-filter', raw: 'SAFETY' };
  let failure: unknown;
  try {
    await new AiSdkModel(model(result)).complete(request(undefined));
  } catch (error) {
    failure = error;
  }
  expect((failure as Error).cause).toBeUndefined();
  expect(failure).toMatchObject({
    name: 'TypeError',
    message: 'AiSdkModel requires a completed response',
  });
});

function toolStream(part: Record<string, unknown>): AiSdkModel {
  return new AiSdkModel(
    {
      specificationVersion: 'v3',
      provider: 'fixture',
      modelId: 'tool-stream',
      doGenerate() {
        throw new Error('stream only');
      },
      doStream() {
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue(part);
              controller.enqueue({
                type: 'finish',
                finishReason: 'tool-calls',
                usage,
              });
              controller.close();
            },
          }),
        };
      },
    },
    {},
    { stream: true },
  );
}
const toolPart = () => ({
  type: 'tool-call',
  toolCallId: 'call',
  toolName: 'danger',
  input: '{"payload":"allowed"}',
  providerExecuted: undefined,
  dynamic: undefined,
  providerMetadata: undefined,
});
it('captures only declared optional undefined fields and retains null metadata', async () => {
  const part: Record<string, unknown> = {
    ...toolPart(),
    providerMetadata: { fixture: { nullable: null } },
  };
  const events: Record<string, unknown>[] = [];
  for await (const event of toolStream(part).stream!(request(undefined)))
    events.push(event);
  const completed = events.find((event) => event.type === 'response.completed');
  expect(completed).toBeDefined();
  expect(JSON.stringify(completed)).toContain('allowed');
  expect(part.providerMetadata).toEqual({ fixture: { nullable: null } });
  expect(Object.hasOwn(part, 'providerExecuted')).toBe(true);
});
it('refuses non-JSON required payloads and unknown undefined fields', async () => {
  for (const override of [
    { input: undefined },
    { input: () => 'unsafe' },
    { input: NaN },
    { unrecognized: undefined },
  ]) {
    const events: Record<string, unknown>[] = [];
    await expect(
      (async () => {
        for await (const event of toolStream({ ...toolPart(), ...override })
          .stream!(request(undefined)))
          events.push(event);
      })(),
    ).rejects.toThrow('finite JSON');
    expect(events.some((event) => event.type === 'response.completed')).toBe(
      false,
    );
  }
});
