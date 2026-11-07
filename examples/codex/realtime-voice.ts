import { Agent, NativeProvider, type Session } from '@openai/agents';
import { tool } from '@openai/agents/classic';
import {
  RealtimeAgent,
  RealtimeSession,
  type RealtimeSessionOptions,
} from '@openai/agents/realtime';
import { NativeSessionVoiceWorkflow } from '@openai/agents/voice';
import { z } from 'zod';

/** Record one prompt for a fixed window, then cancel unfinished native work.
 * The interval starts after connect and includes preambles and delayed answers.
 * It is a recording deadline, not a guarantee that delegated work finishes in time.
 * The caller owns the native Session and the audio sink.
 */
export async function recordDelegatedVoice(
  session: Session<string>,
  prompt: string,
  options: {
    apiKey: string;
    durationMs: number;
    onAudio(data: ArrayBuffer): void;
    transport?: RealtimeSessionOptions['transport'];
  },
): Promise<void> {
  if (!prompt.trim()) throw new Error('Provide a nonempty prompt');
  if (
    !Number.isFinite(options.durationMs) ||
    options.durationMs <= 0 ||
    options.durationMs > 2147483647
  )
    throw new Error(
      'Recording duration must be positive and at most 2147483647 milliseconds',
    );
  const workflow = new NativeSessionVoiceWorkflow(session);
  let closing = false;
  const askNative = tool({
    name: 'ask_native',
    description: 'Delegate substantive work to the native agent.',
    parameters: z.object({ input: z.string() }),
    errorFunction: null,
    execute: async ({ input }) => {
      if (closing) return '';
      try {
        let answer = '';
        for await (const delta of workflow.run(input)) answer += delta;
        return answer;
      } catch (error) {
        // Closing the connection retires its generation, so this late result is discarded.
        // Avoid an unhandled error from the old Realtime callback during native cancellation.
        if (closing) return '';
        throw error;
      }
    },
  });
  const agent = new RealtimeAgent({
    name: 'Voice concierge',
    instructions: 'Use ask_native for substantive work, then speak its answer.',
    tools: [askNative],
  });
  const realtime = new RealtimeSession(agent, {
    transport: options.transport ?? 'websocket',
  });
  let stop!: () => void;
  let fail!: (error: unknown) => void;
  const recording = new Promise<void>((resolve, reject) => {
    stop = resolve;
    fail = reject;
  });
  // A disconnect during connect is retained until connect settles and cleanup runs.
  void recording.catch(() => {});
  const disconnected = (status: string) => {
    if (status === 'disconnected')
      fail(new Error('Realtime disconnected during recording'));
  };
  const errored = ({ error }: { error: unknown }) => fail(error);
  const audio = ({ data }: { data: ArrayBuffer }) => {
    try {
      options.onAudio(data);
    } catch (error) {
      fail(error);
    }
  };
  realtime.transport.on('connection_change', disconnected);
  realtime.on('error', errored);
  realtime.on('audio', audio);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failure: { error: unknown } | undefined;
  try {
    await realtime.connect({ apiKey: options.apiKey });
    if (realtime.transport.status !== 'connected')
      throw new Error('Realtime disconnected before recording');
    timer = setTimeout(stop, options.durationMs);
    realtime.sendMessage(prompt);
    await recording;
  } catch (error) {
    failure = { error };
  } finally {
    closing = true;
    clearTimeout(timer);
    realtime.transport.off('connection_change', disconnected);
    realtime.off('error', errored);
    realtime.off('audio', audio);
    try {
      realtime.close();
    } catch (error) {
      failure ??= { error };
    }
    try {
      await workflow.cancel();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

// Server-side recording: one prompt, an explicit window, and raw PCM output.
// Usage: pnpm exec tsx examples/codex/realtime-voice.ts 'Your question' [seconds=30] > answer.pcm
// A browser should use its existing Realtime media integration and a server endpoint.
async function main(): Promise<void> {
  const prompt = process.argv[2];
  if (!prompt)
    throw new Error(
      'Usage: realtime-voice.ts "Your question" [seconds=30] > answer.pcm',
    );
  const provider = new NativeProvider();
  try {
    const agent = new Agent({
      instructions: 'Complete delegated work. Do not claim approvals.',
      model: 'gpt-5.5',
      provider,
    });
    await using session = await agent.session();
    await recordDelegatedVoice(session, prompt, {
      apiKey: process.env.OPENAI_API_KEY!,
      durationMs: Number(process.argv[3] ?? 30) * 1000,
      onAudio: (data) => {
        process.stdout.write(Buffer.from(data));
      },
    });
  } finally {
    await provider.close();
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
