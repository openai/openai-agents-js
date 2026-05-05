import {
  filesystem,
  Manifest,
  memory,
  SandboxAgent,
  shell,
} from '@openai/agents/sandbox';

const manifest = new Manifest({
  entries: {
    'README.md': {
      type: 'file',
      content: '# Memory demo\n\nA workspace for follow-up runs.\n',
    },
  },
});

const agent = new SandboxAgent({
  name: 'Memory-enabled reviewer',
  model: 'gpt-5.5',
  instructions:
    'Inspect the workspace, verify important claims, and preserve useful lessons for follow-up runs.',
  defaultManifest: manifest,
  capabilities: [filesystem(), shell(), memory()],
});
