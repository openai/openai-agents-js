import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  Agent,
  NativeProvider,
  ToolOutput,
  tool,
  type NativeProviderOptions,
  type ToolContext,
} from '@openai/agents';
import { z } from 'zod';
import {
  readMemory,
  type ApplicationMemory,
  type MemoryContext,
} from './application-memory';

/** The application chooses the memory scope and destination file. */
export interface ArtifactContext extends MemoryContext {
  readonly outputPath: string;
}

const presentation = z.strictObject({
  slides: z.array(z.strictObject({ text: z.string().min(1) })).min(1),
});

/** Validate the candidate before writing to the application-selected path. */
export async function publishArtifact(
  context: ArtifactContext,
  json: string,
): Promise<ToolOutput> {
  let candidate: unknown;
  try {
    candidate = JSON.parse(json);
  } catch {
    return new ToolOutput(
      [
        {
          type: 'inputText',
          text: 'JSON is not well formed. Fix it and call publish_json again.',
        },
      ],
      false,
    );
  }
  const validated = presentation.safeParse(candidate);
  if (!validated.success)
    return new ToolOutput(
      [
        {
          type: 'inputText',
          text: 'Use an object with only slides: a nonempty array of objects containing only nonempty text. Fix it and call publish_json again.',
        },
      ],
      false,
    );

  // Unexpected filesystem failures fail the run instead of requesting a repair.
  await writeFile(
    context.outputPath,
    `${JSON.stringify(validated.data, null, 2)}\n`,
    'utf8',
  );
  return new ToolOutput([
    {
      type: 'inputText',
      text: `Published validated JSON: ${basename(context.outputPath)}`,
    },
  ]);
}

export const publishJson = tool({
  name: 'publish_json',
  description:
    'Validate a JSON presentation and publish it to the application-selected file.',
  parameters: z.strictObject({ json: z.string() }),
  execute: ({ json }, { context }: ToolContext<ArtifactContext>) =>
    publishArtifact(context, json),
});

/** Read the audience note, then validate and publish one JSON slide. */
export async function runValidatedArtifact(
  context: ArtifactContext,
  options: NativeProviderOptions = {},
): Promise<string> {
  await using provider = new NativeProvider(options);
  const agent = new Agent<ArtifactContext>({
    instructions:
      'Read the audience memory note, then publish a short JSON presentation. ' +
      'Use an object with a nonempty slides array; each slide has only nonempty text. ' +
      'If validation fails, repair the JSON and call publish_json again before reporting completion.',
    tools: [readMemory, publishJson],
    provider,
  });
  const result = await agent.run('Create one slide about our new report.', {
    context,
  });
  return result.finalOutput;
}

async function main(): Promise<void> {
  await using directory = {
    path: await mkdtemp(join(tmpdir(), 'agents-artifact-')),
    async [Symbol.asyncDispose]() {
      await rm(this.path, { recursive: true, force: true });
    },
  };
  const memory: ApplicationMemory = {
    async readNote(tenantId, key) {
      return tenantId === 'tenant-a' && key === 'audience'
        ? 'Explain the result in plain language.'
        : undefined;
    },
  };
  const context: ArtifactContext = {
    tenantId: 'tenant-a',
    memory,
    outputPath: join(directory.path, 'presentation.json'),
  };
  console.log(
    await runValidatedArtifact(context, {
      baseUrl: process.env.OPENAI_BASE_URL,
    }),
  );
  console.log(await readFile(context.outputPath, 'utf8'));
}

// tsx runs these source examples as CommonJS in this checkout.
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
