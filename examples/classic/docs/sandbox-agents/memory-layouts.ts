import { memory } from '@openai/agents/sandbox';

const engineeringMemory = memory({
  layout: {
    memoriesDir: 'memories/engineering',
    sessionsDir: 'sessions/engineering',
  },
});

const financeMemory = memory({
  layout: {
    memoriesDir: 'memories/finance',
    sessionsDir: 'sessions/finance',
  },
});
