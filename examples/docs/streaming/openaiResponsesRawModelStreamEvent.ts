import type { RunStreamEvent } from '@openai/agents/classic';
import { isOpenAIResponsesRawModelStreamEvent } from '@openai/agents/classic';

export function isOpenAIResponsesTextDelta(event: RunStreamEvent): boolean {
  return (
    isOpenAIResponsesRawModelStreamEvent(event) &&
    event.data.event.type === 'response.output_text.delta'
  );
}
