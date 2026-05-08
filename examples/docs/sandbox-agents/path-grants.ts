import { Manifest, localDir, skills } from '@openai/agents/sandbox';
import { localDirLazySkillSource } from '@openai/agents/sandbox/local';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = dirname(fileURLToPath(import.meta.url));
const repoDir = join(appRoot, 'repo');
const sharedSkillsDir = '/opt/company/agent-skills';

const manifest = new Manifest({
  extraPathGrants: [
    {
      path: sharedSkillsDir,
      readOnly: true,
      description: 'Shared skill bundle.',
    },
  ],
  entries: {
    repo: localDir({ src: repoDir }),
  },
});

const skillCapability = skills({
  lazyFrom: localDirLazySkillSource({
    src: sharedSkillsDir,
  }),
});
