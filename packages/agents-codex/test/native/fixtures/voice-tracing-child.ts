import assert from 'node:assert/strict';
import { VoicePipeline, type AudioFrame } from '../../../src/voice';
import {
  configure,
  withTrace,
  forceFlush,
  shutdown,
  type TraceEvent,
} from '../../../src/runtime/telemetry';

async function main(): Promise<void> {
  const events: TraceEvent[] = [];
  await configure({
    traceProcessors: [
      {
        onEvent: (event) => {
          events.push(event);
        },
      },
    ],
  });
  const frame: AudioFrame = {
    data: new Int16Array(100000).fill(42),
    sampleRate: 24000,
    channels: 1,
  };
  try {
    for (const capture of [false, true]) {
      const trace = await withTrace(
        { name: `voice privacy ${capture}`, includeSensitiveData: capture },
        async (root) => {
          const pipeline = new VoicePipeline({
            tracing: { captureText: true, captureAudio: true },
            workflow: {
              run: async function* () {
                yield 'native accepted secret ' + '\u0000'.repeat(100000);
              },
            },
            provider: {
              transcribe: async function* () {
                yield 'native transcript secret';
              },
              synthesize: async function* () {
                yield frame;
              },
            },
          });
          for await (const _event of pipeline.run(frame)) {
            /* Drain without retaining PCM. */
          }
          return root.context.traceId;
        },
      );
      assert.equal((await forceFlush()).status, 'success');
      const voice = events.filter(
        (event) =>
          event.trace_id === trace &&
          event.lifecycle === 'end' &&
          event.name.startsWith('voice.'),
      );
      assert.equal(voice.length, 4);
      const payloads = voice.map(
        (event) => event.attributes['sdk.outcome.data'],
      );
      if (!capture) assert(payloads.every((data) => data === undefined));
      else {
        assert(
          payloads.some(
            (data) =>
              typeof data === 'string' &&
              data.includes('native accepted secret'),
          ),
        );
        for (const value of payloads) {
          assert.equal(typeof value, 'string');
          assert(Buffer.byteLength(value as string) <= 4096);
          const data = JSON.parse(value as string);
          if (data.audio)
            assert(Buffer.from(data.audio, 'base64').length <= 512);
        }
      }
    }
  } finally {
    await shutdown();
  }
  console.log('native voice trace privacy passed');
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
