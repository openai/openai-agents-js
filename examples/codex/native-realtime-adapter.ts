import { once } from 'node:events';
import { Agent, NativeProvider } from '@openai/agents';
import type {
  NativeRealtimeAdapter,
  NativeRealtimeAdapterContext,
  NativeRealtimeConnection,
} from '@openai/agents';
import { WebSocket, createWebSocketStream } from 'ws';

/** Application-owned I/O; Core still owns canonical Realtime V2 interpretation. */
class SocketAdapter implements NativeRealtimeAdapter {
  async connect(
    context: NativeRealtimeAdapterContext,
  ): Promise<NativeRealtimeConnection> {
    context.signal.throwIfAborted();
    const socket = new WebSocket(context.url, {
      headers: { ...context.headers },
      maxPayload: 8 * 1024 * 1024,
      followRedirects: false,
    });
    // Readable object mode preserves one WebSocket message per iterator value.
    const stream = createWebSocketStream(socket, {
      readableObjectMode: true,
      highWaterMark: 1,
    });
    // Setup or iteration reports failures. Observe early errors before iteration starts.
    stream.on('error', () => {});
    const abort = () => socket.terminate();
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      await once(socket, 'open', { signal: context.signal });
      context.signal.throwIfAborted();
    } catch (error) {
      socket.terminate();
      stream.destroy();
      throw error;
    } finally {
      context.signal.removeEventListener('abort', abort);
    }
    return {
      incoming: (async function* () {
        for await (const frame of stream) {
          yield typeof frame === 'string'
            ? frame
            : new TextDecoder('utf-8', { fatal: true }).decode(frame);
        }
      })(),
      send(frame) {
        return new Promise<void>((resolve, reject) => {
          socket.send(frame, (error) => (error ? reject(error) : resolve()));
        });
      },
      async close() {
        if (socket.readyState === WebSocket.CLOSED) {
          stream.destroy();
          return;
        }
        const closed = once(socket, 'close');
        // Termination wakes pending reads and writes without waiting for a peer.
        socket.terminate();
        stream.destroy();
        await closed;
      },
    };
  }
}

// Build this branch, set OPENAI_API_KEY, and run from the repository root:
// pnpm exec tsx examples/codex/native-realtime-adapter.ts 'Explain a rainbow' > answer.pcm
// Live API requests; at most 30 seconds of mono PCM16 at 24 kHz, without a file header.
async function main(): Promise<void> {
  const prompt = process.argv[2];
  if (!prompt) throw new Error('Provide a prompt as the first argument.');
  await using provider = new NativeProvider();
  const agent = new Agent({
    provider,
    instructions: 'Answer spoken questions briefly.',
  });
  await using session = await agent.session();
  await using voice = await session.realtime({
    adapter: new SocketAdapter(),
    settings: { outputFormat: 'pcm16' },
  });
  await voice.sendText(prompt);
  const recording = (async () => {
    for await (const event of voice.events()) {
      if (event.type === 'audio') process.stdout.write(event.data);
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      recording,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  await voice.close();
  await recording;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
