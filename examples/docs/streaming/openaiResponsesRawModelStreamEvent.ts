import type { RunStreamEvent } from '@openai/agents';
import { isOpenAIResponsesRawModelStreamEvent } from '@openai/agents';

export function isOpenAIResponsesTextDelta(event: RunStreamEvent): boolean {
  return (
    isOpenAIResponsesRawModelStreamEvent(event) &&
    event.data.event.type === 'response.output_text.delta'
  );
}
