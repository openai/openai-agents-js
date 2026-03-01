import type { RunItem } from '@openai/agents';

type RunItemStreamEventName =
  | 'message_output_created'
  | 'handoff_requested'
  | 'handoff_occurred'
  | 'tool_called'
  | 'tool_output'
  | 'reasoning_item_created'
  | 'tool_approval_requested';

type RunItemStreamEvent = {
  type: 'run_item_stream_event';
  name: RunItemStreamEventName;
  item: RunItem;
};

void ({} as RunItemStreamEvent);
