import type {
  RunAgentUpdatedStreamEvent,
  RunStreamEvent,
} from '@openai/agents/classic';

export function isRunAgentUpdatedStreamEvent(
  event: RunStreamEvent,
): event is RunAgentUpdatedStreamEvent {
  return event.type === 'agent_updated_stream_event';
}
