import type { LanguageModelV2 } from '@ai-sdk/provider';
import { ReadableStream } from 'node:stream/web';

// Exercise provider-wire shapes across AI SDK versions without live requests.
export function stubModel(
  partial: Partial<Pick<LanguageModelV2, 'doGenerate' | 'doStream'>>,
  options?: {
    provider?: string;
    modelId?: string;
    specificationVersion?: string;
  },
): LanguageModelV2 {
  return {
    specificationVersion: options?.specificationVersion ?? 'v2',
    provider: options?.provider ?? 'stub',
    modelId: options?.modelId ?? 'm',
    supportedUrls: {} as any,
    async doGenerate(options) {
      if (partial.doGenerate) {
        return partial.doGenerate(options) as any;
      }
      return {
        content: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        response: { id: 'id' },
        providerMetadata: {},
        finishReason: 'stop',
        warnings: [],
      } as any;
    },
    async doStream(options) {
      if (partial.doStream) {
        return partial.doStream(options);
      }
      return {
        stream: new ReadableStream(),
      } as any;
    },
  } as LanguageModelV2;
}
