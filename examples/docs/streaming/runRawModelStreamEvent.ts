import type { RunRawModelStreamEvent, RunStreamEvent } from '@openai/agents';

export function isRunRawModelStreamEvent(
  event: RunStreamEvent,
): event is RunRawModelStreamEvent {
  return event.type === 'raw_model_stream_event';
}
