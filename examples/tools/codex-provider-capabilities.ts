import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent, Runner, handoff, tool } from '@openai/agents';
import { z } from 'zod';

const reportSchema = z.object({
  animal: z.literal('bison'),
  recordId: z.literal('synthetic-bison-001'),
  description: z.string(),
});

async function codexProvider(workspace: string) {
  const { CodexProvider } =
    await import('@openai/agents-extensions/experimental/codex');
  return new CodexProvider({
    threadOptions: {
      workingDirectory: workspace,
      skipGitRepoCheck: true,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
    },
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== 'openai' && mode !== 'codex') {
    throw new Error('Usage: tsx codex-provider-capabilities.ts <openai|codex>');
  }

  const workspace = await mkdtemp(
    path.join(os.tmpdir(), 'codex-capabilities-'),
  );
  let handoffCount = 0;
  let toolCount = 0;

  try {
    const image = await readFile(
      path.join(import.meta.dirname, '../basic/media/image_bison.jpg'),
    );
    const lookupAnimal = tool({
      name: 'lookup_animal_record',
      description:
        'Look up a synthetic catalog record for an identified animal.',
      parameters: z.object({ animal: z.literal('bison') }),
      execute: async ({ animal }) => {
        toolCount += 1;
        return { animal, recordId: 'synthetic-bison-001' };
      },
    });
    const specialist = new Agent({
      name: 'Wildlife specialist',
      instructions: [
        'Inspect the user-supplied image and identify the animal.',
        'Call lookup_animal_record with the identified animal before answering.',
        'Use the returned recordId in your final JSON report.',
        'Include a brief description of visible features in description.',
        'Do not use shell commands, native tools, or external research.',
      ].join(' '),
      tools: [lookupAnimal],
      outputType: reportSchema,
    });
    const triage = Agent.create({
      name: 'Image triage',
      instructions: [
        'Immediately hand off this image identification request to the wildlife specialist.',
        'Invoke transfer_to_wildlife_specialist before producing any answer.',
        'Do not identify the animal yourself or use native tools.',
      ].join(' '),
      handoffs: [
        handoff(specialist, {
          toolNameOverride: 'transfer_to_wildlife_specialist',
          onHandoff: () => {
            handoffCount += 1;
          },
        }),
      ],
    });
    const runner = new Runner({
      tracingDisabled: true,
      model:
        mode === 'codex' ? process.env.CODEX_MODEL : process.env.OPENAI_MODEL,
      modelProvider:
        mode === 'codex' ? await codexProvider(workspace) : undefined,
    });
    const result = await runner.run(
      triage,
      [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Hand this image to the wildlife specialist. Identify the animal from the image, call lookup_animal_record, then return the structured report using the recordId from the tool. Describe visible features rather than relying on a filename.',
            },
            {
              type: 'input_image',
              image: `data:image/jpeg;base64,${image.toString('base64')}`,
            },
          ],
        },
      ],
      { stream: true, maxTurns: 8 },
    );
    let textDeltaCount = 0;
    for await (const event of result) {
      if (
        event.type === 'raw_model_stream_event' &&
        event.data.type === 'output_text_delta'
      ) {
        textDeltaCount += 1;
        process.stdout.write(event.data.delta);
      }
    }
    await result.completed;
    const report: z.infer<typeof reportSchema> = reportSchema.parse(
      result.finalOutput,
    );
    if (
      handoffCount === 0 ||
      toolCount === 0 ||
      textDeltaCount === 0 ||
      !report.description.trim() ||
      result.lastAgent?.name !== specialist.name
    ) {
      throw new Error(
        `Incomplete workflow: ${JSON.stringify({ handoffCount, toolCount, textDeltaCount, lastAgent: result.lastAgent?.name })}`,
      );
    }
    console.log(`\nProvider: ${mode}`);
    console.log(JSON.stringify(report, null, 2));
    console.log(
      `Verified image, handoff, SDK tool, structured output, and ${textDeltaCount} text deltas.`,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
