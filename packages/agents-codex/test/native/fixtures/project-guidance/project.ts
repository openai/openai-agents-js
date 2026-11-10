import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Environment, NativeProvider } from '@openai/agents';
import { ModelServer } from '../model-server';
import { startPublicExecutor } from '../public-executor';

// A valid one-pixel PNG, read by the real native view_image tool.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);

export async function writeRule(root: string, name: string, source: string) {
  const directory = join(root, '.agents', 'rules');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${name}.md`);
  await writeFile(path, source);
  return path;
}

export function pathRule(
  marker: string,
  paths: readonly string[] = ['src/**'],
) {
  return `---\npaths: ${JSON.stringify(paths)}\n---\n${marker}\n`;
}

export async function seedProject(root: string, marker: string) {
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'source.txt'), 'executor text content');
  await writeFile(join(root, 'src', 'pixel.png'), png);
  await writeFile(join(root, 'src', 'invalid.png'), 'not a PNG image');
  await writeRule(root, 'general', `${marker}_GENERAL`);
  await writeRule(root, 'scoped', pathRule(`${marker}_SCOPED`));
  await writeRule(
    root,
    'unrelated',
    pathRule(`${marker}_UNRELATED`, ['docs/**']),
  );
}

export async function startProjectExecutor() {
  const executor = await startPublicExecutor();
  return {
    ...executor,
    environment(cwd: string) {
      return new Environment({
        url: executor.url,
        cwd,
        headers: executor.headers,
      });
    },
    readRequested(path: string) {
      return executor.requests.some(
        (request) =>
          ['fs/open', 'fs/readFile', 'fs/readFileStream'].includes(
            String(request.method),
          ) &&
          JSON.stringify(request.params).includes(pathToFileURL(path).href),
      );
    },
    [Symbol.asyncDispose]: executor.close,
  };
}

export async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-project-guidance',
    supportsWebsockets: false,
  });
}

export function modelInput(request: ModelServer['requests'][number]) {
  return JSON.stringify(request.input ?? []);
}

export function functionOutput(
  request: ModelServer['requests'][number],
  callId: string,
) {
  if (!Array.isArray(request.input)) return undefined;
  return request.input.find(
    (item) =>
      item !== null &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      item.type === 'function_call_output' &&
      item.call_id === callId,
  );
}
