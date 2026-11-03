import { getLogger } from '@openai/agents-core';

const logger: ReturnType<typeof getLogger> = getLogger(
  'openai-agents:realtime',
);

export default logger;
