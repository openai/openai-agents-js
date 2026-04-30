import { getGlobalTraceProvider } from '@openai/agents';
import { spawnSync } from 'node:child_process';

export const DEFAULT_MODEL =
  process.env.SANDBOX_EXAMPLE_MODEL ?? 'gpt-5.4-mini';
export const DEFAULT_DOCKER_IMAGE =
  process.env.SANDBOX_EXAMPLE_DOCKER_IMAGE ?? 'node:22-bookworm-slim';

export function requireOpenAIKey(): void {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY must be set before running sandbox examples.',
    );
  }
}

export function hasFlag(
  name: string,
  argv: string[] = process.argv.slice(2),
): boolean {
  return argv.includes(name);
}

export function getStringArg(
  name: string,
  fallback: string,
  argv: string[] = process.argv.slice(2),
): string {
  const index = argv.indexOf(name);
  if (index === -1 || index === argv.length - 1) {
    return fallback;
  }
  return argv[index + 1] ?? fallback;
}

export function getOptionalStringArg(
  name: string,
  argv: string[] = process.argv.slice(2),
): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1 || index === argv.length - 1) {
    return undefined;
  }
  return argv[index + 1];
}

export function getOptionalNumberArg(
  name: string,
  argv: string[] = process.argv.slice(2),
): number | undefined {
  const value = getOptionalStringArg(name, argv);
  if (typeof value === 'undefined') {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number, received ${value}.`);
  }
  return parsed;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set before running this example.`);
  }
  return value;
}

export function ensureDockerAvailable(): void {
  const result = spawnSync('docker', ['version'], {
    stdio: 'ignore',
  });
  if (result.status !== 0) {
    throw new Error(
      'Docker sandbox examples require a working Docker CLI and daemon.',
    );
  }
}

export async function runExampleMain(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    // Short-lived CLI examples can exit before the unref'ed trace export loop flushes.
    // Await shutdown here so failures still export traces deterministically.
    await getGlobalTraceProvider().shutdown();
  }
}
