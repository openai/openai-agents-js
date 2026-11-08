import { Agent, NativeProvider } from '@openai/agents';

// Set OPENAI_API_KEY and build this branch, or use the matching release example.
// pnpm exec tsx examples/codex/native-realtime-voice.ts 'Your question' 30 > answer.pcm
// Output is mono PCM16 at 24 kHz. The fixed window includes delegated work.
async function main(): Promise<void> {
  const prompt = process.argv[2];
  const durationMs = Number(process.argv[3] ?? 30) * 1000;
  if (!prompt || !Number.isFinite(durationMs) || durationMs <= 0)
    throw new Error(
      'Provide a prompt and a positive recording duration in seconds.',
    );

  const provider = new NativeProvider();
  try {
    const agent = new Agent({
      provider,
      instructions:
        "Solve the user's request and return a concise answer for speech.",
    });
    await using session = await agent.session();
    await using realtime = await session.realtime({
      instructions:
        "Use background_agent to solve the user's request, then speak its answer.",
    });
    await realtime.sendText(prompt);
    const recording = (async () => {
      for await (const event of realtime.events()) {
        if (event.type === 'audio') process.stdout.write(event.data);
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        recording,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, durationMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await realtime.close();
    await recording;
  } finally {
    await provider.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
