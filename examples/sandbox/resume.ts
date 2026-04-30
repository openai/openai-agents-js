import { RunState, run } from '@openai/agents';
import {
  filesystem,
  Manifest,
  shell,
  SandboxAgent,
} from '@openai/agents/sandbox';
import {
  DockerSandboxClient,
  UnixLocalSandboxClient,
} from '@openai/agents/sandbox/local';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_DOCKER_IMAGE,
  DEFAULT_MODEL,
  ensureDockerAvailable,
  getStringArg,
  hasFlag,
  requireOpenAIKey,
  runExampleMain,
} from './support';

const DEFAULT_QUESTION =
  'Finish the seeded warehouse-robot operations API with Node.js built-ins only. Keep it compact. Complete the health check, the GET /robots/:robotId/status endpoint backed by the provided in-memory fixture, make 404 behavior clear, smoke test it locally with `node` and `fetch`, then stop and summarize what you built.';
const RESUME_QUESTION =
  'Now add node:test coverage for the health check, the robot status success case, and the unknown robot 404 case. Keep the tests compact, run `node --test`, then stop and summarize the files you changed.';
const AGENTS_MD = `# AGENTS.md

- When asked to build an app, make it a Node.js app that uses only built-in modules.
- Use ESM modules.
- Run commands with \`node\`.
- Smoke test local HTTP endpoints with \`node\` and \`fetch\`.
- Test the app locally before finishing.
- The shell already starts in the workspace root, so prefer relative paths instead of changing to /workspace.
`;

async function main() {
  requireOpenAIKey();

  const useDocker = hasFlag('--docker');
  const model = getStringArg('--model', DEFAULT_MODEL);
  const question = getStringArg('--question', DEFAULT_QUESTION);
  const image = getStringArg('--image', DEFAULT_DOCKER_IMAGE);
  const snapshotBaseDir = await mkdtemp(
    join(tmpdir(), 'openai-agents-sandbox-example-snapshots-'),
  );

  const manifest = new Manifest({
    entries: {
      'AGENTS.md': {
        type: 'file',
        content: AGENTS_MD,
      },
      'package.json': {
        type: 'file',
        content: `{
  "name": "warehouse-robot-status",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node src/server.mjs",
    "test": "node --test"
  }
}
`,
      },
      'src/data.mjs': {
        type: 'file',
        content: `export const ROBOTS = {
  atlas: {
    robotId: 'atlas',
    state: 'idle',
    batteryPercent: 92,
    zone: 'A1',
  },
  bolt: {
    robotId: 'bolt',
    state: 'charging',
    batteryPercent: 34,
    zone: 'Dock-2',
  },
};
`,
      },
      'src/server.mjs': {
        type: 'file',
        content: `import http from 'node:http';
import { ROBOTS } from './data.mjs';

function json(response, statusCode, body) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

export function createApp() {
  return http.createServer((request, response) => {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (method === 'GET' && url.pathname === '/health') {
      // TODO: report an ok health response.
      return json(response, 501, { error: 'not implemented' });
    }

    const match = url.pathname.match(/^\\/robots\\/([^/]+)\\/status$/);
    if (method === 'GET' && match) {
      const robotId = match[1];
      // TODO: return a robot status payload when found.
      // TODO: return a clear 404 payload when the robot is unknown.
      return json(response, 501, { error: 'not implemented', robotId });
    }

    return json(response, 404, {
      error: 'not_found',
      message: 'Route not found',
    });
  });
}

export function startServer(port = 3000) {
  const server = createApp();
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (import.meta.url === \`file://\${process.argv[1]}\`) {
  const server = await startServer(Number(process.env.PORT ?? 3000));
  console.log('server listening on', server.address());
}
`,
      },
    },
  });

  const snapshot = {
    type: 'local' as const,
    baseDir: snapshotBaseDir,
  };
  const client = useDocker
    ? (() => {
        ensureDockerAvailable();
        return new DockerSandboxClient({
          image,
          snapshot,
        });
      })()
    : new UnixLocalSandboxClient({ snapshot });
  const initialSession = await client.create(manifest);
  const resumableClient = client as {
    backendId: string;
    serializeSessionState: (
      state: typeof initialSession.state,
    ) => Promise<Record<string, unknown>>;
    deserializeSessionState: (
      state: Record<string, unknown>,
    ) => Promise<typeof initialSession.state>;
    resume: (
      state: typeof initialSession.state,
    ) => Promise<typeof initialSession>;
  };

  const agent = new SandboxAgent({
    name: 'Vibe Coder',
    model,
    instructions: AGENTS_MD,
    defaultManifest: manifest,
    capabilities: [filesystem(), shell()],
  });

  let resumedSession:
    | Awaited<ReturnType<typeof resumableClient.resume>>
    | undefined = undefined;

  try {
    const firstResult = await run(agent, question, {
      maxTurns: 30,
      sandbox: { session: initialSession },
    });

    const serializedRunState = firstResult.state.toString();
    await RunState.fromString(agent, serializedRunState);

    const serializedSessionState = await resumableClient.serializeSessionState(
      initialSession.state,
    );
    const frozenSessionState = await resumableClient.deserializeSessionState(
      serializedSessionState,
    );
    resumedSession = await resumableClient.resume(frozenSessionState);

    const secondResult = await run(
      agent,
      [
        ...firstResult.history,
        {
          role: 'user',
          content: RESUME_QUESTION,
        },
      ],
      {
        maxTurns: 30,
        sandbox: { session: resumedSession },
      },
    );

    const verification = await resumedSession.execCommand!({
      cmd: 'node --test',
      yieldTimeMs: 1_500,
      maxOutputTokens: 600,
    });

    if (!verification.includes('Process exited with code 0')) {
      throw new Error(`Expected node --test to pass:\n${verification}`);
    }

    console.log(
      `run_state_schema: ${JSON.parse(serializedRunState).$schemaVersion}`,
    );
    console.log(`backend: ${resumableClient.backendId}`);
    console.log('step_1:', firstResult.finalOutput);
    console.log('step_2:', secondResult.finalOutput);
    console.log('verification_command: node --test');
    console.log('verification_result:', verification);
  } finally {
    if (resumedSession) {
      await resumedSession.close?.().catch(() => {});
    }
    await initialSession.close?.().catch(() => {});
    await rm(snapshotBaseDir, { recursive: true, force: true }).catch(() => {});
  }
}

await runExampleMain(main);
