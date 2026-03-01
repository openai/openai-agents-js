import type { ResponseStreamEvent } from '@openai/agents';

type RunRawModelStreamEvent = {
  type: 'raw_model_stream_event';
  data: ResponseStreamEvent;
};

void ({} as RunRawModelStreamEvent);
