import type { RunItemStreamEvent, RunStreamEvent } from '@openai/agents';

export function isRunItemStreamEvent(
  event: RunStreamEvent,
): event is RunItemStreamEvent {
  return event.type === 'run_item_stream_event';
}
