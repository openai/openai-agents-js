import { ModelBehaviorError } from '@openai/agents-core';

export const CHAT_COMPLETIONS_EMPTY_TRUNCATION_ERROR =
  "Chat Completions response terminated with finish_reason='length' but produced no assistant text, tool call, or refusal.";

const CHAT_COMPLETIONS_TRUNCATION_ERROR_BRAND = Symbol(
  'openaiChatCompletionsTruncationError',
);

export type ChatCompletionTruncationError = ModelBehaviorError & {
  readonly unsafeToReplay: true;
  readonly responseStarted: true;
  readonly [CHAT_COMPLETIONS_TRUNCATION_ERROR_BRAND]: true;
};

export function createChatCompletionTruncationError(
  message = CHAT_COMPLETIONS_EMPTY_TRUNCATION_ERROR,
): ChatCompletionTruncationError {
  const error = new ModelBehaviorError(
    message,
  ) as ChatCompletionTruncationError;
  Object.defineProperties(error, {
    unsafeToReplay: { value: true },
    responseStarted: { value: true },
    [CHAT_COMPLETIONS_TRUNCATION_ERROR_BRAND]: { value: true },
  });
  return error;
}

export function isChatCompletionTruncationError(
  error: unknown,
): error is ChatCompletionTruncationError {
  return (
    error instanceof ModelBehaviorError &&
    (error as Partial<ChatCompletionTruncationError>)[
      CHAT_COMPLETIONS_TRUNCATION_ERROR_BRAND
    ] === true
  );
}

export type ChatCompletionsOutputState = {
  finishReason: string | null | undefined;
  hasText: boolean;
  hasRefusal: boolean;
  hasAudio: boolean;
  hasReasoning: boolean;
  hasFunctionCall: boolean;
};

export function isTruncatedEmptyChatCompletion({
  finishReason,
  hasText,
  hasRefusal,
  hasAudio,
  hasReasoning,
  hasFunctionCall,
}: ChatCompletionsOutputState): boolean {
  return (
    finishReason === 'length' &&
    !hasText &&
    !hasRefusal &&
    !hasAudio &&
    !hasReasoning &&
    !hasFunctionCall
  );
}
