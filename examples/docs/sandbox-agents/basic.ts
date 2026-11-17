import { run } from '@openai/agents';
import {
  Capabilities,
  Manifest,
  SandboxAgent,
  localDir,
  skills,
} from '@openai/agents/sandbox';
import {
  UnixLocalSandboxClient,
  localDirLazySkillSource,
} from '@openai/agents/sandbox/local';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exampleDir = dirname(fileURLToPath(import.meta.url));
const hostRepoDir = join(exampleDir, 'repo');
const hostSkillsDir = join(exampleDir, 'skills');

const manifest = new Manifest({
  entries: {
    repo: localDir({ src: hostRepoDir }),
  },
});

const agent = new SandboxAgent({
  name: 'Sandbox engineer',
  instructions:
    'Use the SDK sandbox tools for the copied `repo/`. Read `repo/task.md` with `cat` and load the `$invoice-total-fixer` skill. Read `repo/src/invoice.mjs` and `repo/tests/invoice.test.mjs` with `cat`. The test passes tax as a fraction. Use the SDK sandbox apply_patch tool to edit the copied file before testing. Use the SDK tool namespace if your provider exposes one. Patch paths are relative to the sandbox workspace root. Run `node --test` in `repo/` and report its result.',
  defaultManifest: manifest,
  capabilities: [
    ...Capabilities.default(),
    skills({
      lazyFrom: localDirLazySkillSource({
        src: hostSkillsDir,
      }),
    }),
  ],
});

const result = await run(
  agent,
  'Open `repo/task.md`, fix the issue, run the targeted test, and summarize the change.',
  {
    maxTurns: 20,
    sandbox: {
      client: new UnixLocalSandboxClient(),
    },
  },
);

console.log(result.finalOutput);
