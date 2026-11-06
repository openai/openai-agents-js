import { file, gitRepo, Manifest } from '@openai/agents/sandbox';

const manifest = new Manifest({
  root: '/workspace',
  entries: {
    'task.md': file({
      content: 'Fix the failing test and summarize the change.',
    }),
    repo: gitRepo({
      repo: 'openai/openai-agents-js',
      ref: 'main',
    }),
  },
  environment: {
    NODE_ENV: 'test',
  },
});
