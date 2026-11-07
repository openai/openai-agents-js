import { readFile, writeFile } from 'node:fs/promises';
import { Agent, NativeProvider } from '@openai/agents';
import {
  NativeSessionVoiceWorkflow,
  OpenAISpeechProvider,
  VoicePipeline,
} from '@openai/agents/voice';

/** Transcribe mono PCM16 24 kHz input and speak the validated final native answer. */
export async function speakFile(inputPath: string, outputPath: string) {
  const bytes = await readFile(inputPath);
  if (bytes.length % 2)
    throw new Error('Input ends with an incomplete PCM16 sample');
  const data = new Int16Array(bytes.length / 2);
  for (let i = 0; i < data.length; i++) data[i] = bytes.readInt16LE(i * 2);
  const provider = new NativeProvider();
  try {
    const agent = new Agent({
      instructions: 'Answer spoken questions concisely.',
      provider,
      model: 'gpt-5.5',
    });
    // Applications needing approvals supply onInteraction here. Speech cannot approve work.
    await using session = await agent.session();
    const pipeline = new VoicePipeline({
      workflow: new NativeSessionVoiceWorkflow(session),
      provider: new OpenAISpeechProvider(),
    });
    const output: Buffer[] = [];
    for await (const event of pipeline.run({
      data,
      sampleRate: 24000,
      channels: 1,
    })) {
      if (event.type === 'audio') {
        const pcm = Buffer.alloc(event.frame.data.length * 2);
        for (let i = 0; i < event.frame.data.length; i++)
          pcm.writeInt16LE(event.frame.data[i], i * 2);
        output.push(pcm);
      }
    }
    await writeFile(outputPath, Buffer.concat(output));
  } finally {
    await provider.close();
  }
}

async function main(): Promise<void> {
  if (!process.argv[2] || !process.argv[3])
    throw new Error(
      'Usage: pnpm exec tsx examples/codex/voice.ts input.pcm output.pcm',
    );
  await speakFile(process.argv[2], process.argv[3]);
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
