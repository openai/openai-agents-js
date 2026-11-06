import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type NativeProvider, type UserMessage } from '@openai/agents';
import { text, withScriptedResponses } from '@openai/agents/testing';
import { z } from 'zod';

// A synthetic one-pixel red PNG; no network or image library is needed.
export const syntheticPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);
const answerSchema = z.strictObject({
  dominantColor: z.enum(['red', 'green', 'blue', 'unknown']),
  confidence: z.number().min(0).max(1),
});

export async function imageMessage(path: string): Promise<UserMessage> {
  return {
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: 'Name the dominant color in this synthetic image.',
      },
      {
        type: 'input_image',
        image_url: `data:image/png;base64,${(await readFile(path)).toString('base64')}`,
        detail: 'auto',
      },
    ],
  };
}

export function imageAgent(provider: NativeProvider) {
  return new Agent({
    instructions:
      'Inspect the image and report its dominant color and confidence.',
    outputType: answerSchema,
    provider,
  });
}

export async function runExample() {
  const directory = await mkdtemp(join(tmpdir(), 'agents-image-'));
  try {
    const path = join(directory, 'synthetic.png');
    await writeFile(path, syntheticPng);
    return await withScriptedResponses(
      [[text('{"dominantColor":"red","confidence":1}')]],
      async (peer) =>
        (await imageAgent(peer.provider).run(await imageMessage(path)))
          .finalOutput,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  runExample().then(console.log, (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
