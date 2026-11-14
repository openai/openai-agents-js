import { expect, it } from 'vitest';
import type { JsonObject } from '../src/runtime/binding';
import {
  AiSdkModel,
  type AiSdkLanguageModel,
  type ModelRequest,
} from '../src/runtime/models';

function request(content: JsonObject[]): ModelRequest {
  return {
    body: {
      model: 'image-reference',
      input: [
        {
          type: 'function_call',
          call_id: 'image-call',
          name: 'supply_image',
          arguments: '{}',
        },
        {
          type: 'function_call_output',
          call_id: 'image-call',
          output: content,
        },
      ],
    },
    context: null,
    sessionId: 'image-reference',
    turnId: 'turn',
    signal: new AbortController().signal,
  };
}
function fixture(
  version: AiSdkLanguageModel['specificationVersion'],
  provider: string,
) {
  const prompts: unknown[] = [];
  const model: AiSdkLanguageModel = {
    specificationVersion: version,
    provider,
    modelId: 'image-reference',
    doGenerate(options: { prompt: unknown }) {
      prompts.push(structuredClone(options.prompt));
      return {
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        content: [{ type: 'text', text: 'accepted' }],
      };
    },
  };
  return { adapter: new AiSdkModel(model), prompts };
}
it.each([
  [
    'v3',
    'openai.responses',
    { type: 'image-file-id', fileId: 'file-owned-image' },
  ],
  [
    'v4',
    'openai.responses',
    {
      type: 'file',
      mediaType: 'image',
      data: { type: 'reference', reference: { openai: 'file-owned-image' } },
    },
  ],
  [
    'v4',
    'renamed.responses',
    {
      type: 'file',
      mediaType: 'image',
      data: { type: 'reference', reference: { renamed: 'file-owned-image' } },
    },
  ],
] as const)(
  'preserves %s image references for %s',
  async (version, provider, expected) => {
    const { adapter, prompts } = fixture(version, provider);
    const result = await adapter.complete(
      request([{ type: 'input_image', file_id: 'file-owned-image' }]),
    );
    expect(result.output).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'message' })]),
    );
    expect(prompts).toEqual([
      expect.arrayContaining([
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'image-call',
              toolName: 'supply_image',
              output: { type: 'content', value: [expected] },
            },
          ],
        },
      ]),
    ]);
  },
);
it('retains the v2 provider-reference boundary before generation', async () => {
  const { adapter, prompts } = fixture('v2', 'fixture');
  await expect(
    adapter.complete(
      request([{ type: 'input_image', file_id: 'file-owned-image' }]),
    ),
  ).rejects.toThrow('v2 does not support provider image tool outputs');
  expect(prompts).toEqual([]);
});
it('rejects ambiguous image authorities before generation', async () => {
  const { adapter, prompts } = fixture('v4', 'openai.responses');
  await expect(
    adapter.complete(
      request([
        {
          type: 'input_image',
          file_id: 'file-owned-image',
          image_url: 'https://example.test/other.png',
        },
      ]),
    ),
  ).rejects.toThrow('exactly one image_url or file_id');
  expect(prompts).toEqual([]);
});
