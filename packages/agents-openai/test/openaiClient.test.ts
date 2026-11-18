import { expectTypeOf, test } from 'vitest';
import {
  getDefaultOpenAIClient,
  type OpenAIClient,
  type OpenAIProviderOptions,
  type OpenAIConversationsSessionOptions,
  type OpenAIResponsesCompactionSessionOptions,
} from '../src';

test('preserves the full exported OpenAI client and default option clients', () => {
  expectTypeOf<OpenAIClient>().toHaveProperty('files');
  expectTypeOf<OpenAIClient>().toHaveProperty('models');
  expectTypeOf<OpenAIClient['responses']>().toHaveProperty('retrieve');
  expectTypeOf<
    NonNullable<OpenAIProviderOptions['openAIClient']>
  >().toEqualTypeOf<OpenAIClient>();
  expectTypeOf<
    NonNullable<OpenAIConversationsSessionOptions['client']>
  >().toEqualTypeOf<OpenAIClient>();
  expectTypeOf<
    NonNullable<OpenAIResponsesCompactionSessionOptions['client']>
  >().toEqualTypeOf<OpenAIClient>();
  expectTypeOf(getDefaultOpenAIClient()).toEqualTypeOf<
    OpenAIClient | undefined
  >();
});
