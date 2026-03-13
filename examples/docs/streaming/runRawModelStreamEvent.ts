import {
  isOpenAIChatCompletionsRawModelStreamEvent,
  isOpenAIResponsesRawModelStreamEvent,
  type RunStreamEvent,
} from '@openai/agents';

export function logOpenAIRawModelEvent(event: RunStreamEvent) {
  if (isOpenAIResponsesRawModelStreamEvent(event)) {
    console.log(event.source);
    console.log(event.data.event.type);
    return;
  }

  if (isOpenAIChatCompletionsRawModelStreamEvent(event)) {
    console.log(event.source);
    console.log(event.data.event.object);
  }
}
