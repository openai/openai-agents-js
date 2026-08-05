import type { ChatCompletion } from 'openai/resources/chat';

export const CONTENT_FILTER_REFUSAL_MESSAGE =
  "Response withheld by the provider's content filter.";

type ContentFilterState = {
  finishReason:
    ChatCompletion['choices'][number]['finish_reason'] | null | undefined;
  content: string | null | undefined;
  refusal: string | null | undefined;
  hasToolCalls: boolean;
};

export function shouldSynthesizeContentFilterRefusal({
  finishReason,
  content,
  refusal,
  hasToolCalls,
}: ContentFilterState): boolean {
  return (
    finishReason === 'content_filter' && !content && !refusal && !hasToolCalls
  );
}
