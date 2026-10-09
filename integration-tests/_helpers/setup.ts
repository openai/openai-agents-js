import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const fixtureDirectories = [
  'bun',
  'cloudflare-workers/worker',
  'deno',
  'node',
  'node-ai-sdk-v2-ts',
  'node-ai-sdk-v3-ts',
  'node-ai-sdk-v4-ts',
  'node-openai-client-types',
  'node-sdk-behavior',
  'node-zod3',
  'node-zod4',
  'node-zod4-ts',
  'vite-react',
];

export async function setup() {
  const response = await fetch('http://localhost:4873/');
  if (response.status !== 200) {
    throw new Error('Local npm registry not running');
  }

  // Read every original before changing any fixture, including custom settings.
  const originals = await Promise.all(
    fixtureDirectories.map(async (directory) => {
      const file = path.resolve('integration-tests', directory, '.npmrc');
      return { file, content: await readFile(file) };
    }),
  );
  const changed: typeof originals = [];
  const restore = async () => {
    const results = await Promise.allSettled(
      changed.map(({ file, content }) => writeFile(file, content)),
    );
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        'Could not restore integration npm configs',
      );
    }
  };

  try {
    for (const original of originals) {
      // Register before writing so a partial write is also restored.
      changed.push(original);
      await writeFile(
        original.file,
        `${original.content.toString()}\n@openai:registry=http://localhost:4873\n`,
      );
    }
  } catch (error) {
    try {
      await restore();
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        'Integration npm config setup and restoration failed',
        { cause: error },
      );
    }
    throw error;
  }

  return restore;
}
