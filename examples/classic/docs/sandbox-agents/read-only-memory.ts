import { memory } from '@openai/agents/sandbox';

const readOnlyMemory = memory({
  read: { liveUpdate: false },
  generate: false,
});
