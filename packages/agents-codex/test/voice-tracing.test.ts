import { beforeEach, expect, it, vi } from 'vitest';
const recorder = vi.hoisted(() => ({
  allowed: true,
  failEnd: false,
  spans: [] as Array<{
    name: string;
    parent: unknown;
    ended?: { status: string; data?: Record<string, unknown> };
    closed: boolean;
  }>,
}));
// This double isolates host capture/bounds and cleanup; native ancestry is covered
// separately by voice-tracing-native.test.ts with a real trace processor.
vi.mock('../src/runtime/tracing-context', () => ({
  startSpan: async (options: {
    name: string;
    parent?: unknown;
    includeSensitiveData?: boolean;
  }) => {
    const record = {
      name: options.name,
      parent: options.parent,
      closed: false,
    } as (typeof recorder.spans)[number];
    recorder.spans.push(record);
    return {
      context: {
        includeSensitiveData: recorder.allowed && options.includeSensitiveData,
      },
      end: (outcome: { status: string; data?: Record<string, unknown> }) => {
        if (recorder.failEnd) throw new Error('trace cleanup failed');
        record.ended = structuredClone(outcome);
      },
      close: () => {
        record.closed = true;
      },
    };
  },
}));
import { VoicePipeline, type AudioFrame } from '../src/voice';
const input: AudioFrame = {
  data: new Int16Array(100000).fill(123),
  sampleRate: 24000,
  channels: 1,
};
async function run(
  tracing: { captureText?: boolean; captureAudio?: boolean },
  fail = false,
) {
  const pipeline = new VoicePipeline({
    tracing,
    workflow: {
      run: async function* () {
        if (fail) throw new Error('processing failed');
        yield 'accepted secret ' + '\u0000'.repeat(100000);
      },
    },
    provider: {
      transcribe: async function* () {
        yield 'transcript secret';
      },
      synthesize: async function* () {
        yield input;
      },
    },
  });
  for await (const _event of pipeline.run(input)) {
    /* Drain without retaining audio. */
  }
}
beforeEach(() => {
  recorder.allowed = true;
  recorder.failEnd = false;
  recorder.spans.length = 0;
});
it.each([
  { captureText: false, captureAudio: false },
  { captureText: true, captureAudio: false },
  { captureText: false, captureAudio: true },
  { captureText: true, captureAudio: true },
])('captures bounded independent speech prefixes: %j', async (options) => {
  await run(options);
  expect(recorder.spans.map((span) => span.name)).toEqual([
    'voice.pipeline',
    'voice.transcription',
    'voice.workflow',
    'voice.synthesis',
  ]);
  for (const span of recorder.spans) {
    expect(span.closed).toBe(true);
    expect(span.ended?.status).toBe('ok');
    expect(
      Buffer.byteLength(JSON.stringify(span.ended?.data)),
    ).toBeLessThanOrEqual(4096);
    const data = span.ended?.data ?? {};
    expect(!!(data.inputText || data.outputText)).toBe(
      options.captureText && span.name !== 'voice.pipeline',
    );
    expect(typeof data.audio === 'string').toBe(
      options.captureAudio &&
        ['voice.transcription', 'voice.synthesis'].includes(span.name),
    );
    if (typeof data.audio === 'string')
      expect(Buffer.from(data.audio, 'base64').length).toBeLessThanOrEqual(512);
  }
});
it('retains only lifecycle/status when native ancestry denies sensitive payloads', async () => {
  recorder.allowed = false;
  await run({ captureText: true, captureAudio: true });
  expect(recorder.spans).toHaveLength(4);
  expect(
    recorder.spans.every((span) => JSON.stringify(span.ended?.data) === '{}'),
  ).toBe(true);
});
it('keeps the processing error when optional trace cleanup fails', async () => {
  recorder.failEnd = true;
  await expect(
    run({ captureText: true, captureAudio: true }, true),
  ).rejects.toThrow('processing failed');
  expect(recorder.spans.every((span) => span.closed)).toBe(true);
});
it('ends an early-exited audio consumer as cancelled without retaining remaining segments', async () => {
  const pipeline = new VoicePipeline({
    tracing: { captureAudio: true },
    workflow: {
      run: async function* () {
        yield 'one. two';
      },
    },
    provider: {
      transcribe: async function* () {
        yield 'question';
      },
      synthesize: async function* () {
        yield input;
        yield input;
      },
    },
  });
  for await (const event of pipeline.run(input))
    if (event.type === 'audio') break;
  expect(recorder.spans.every((span) => span.closed)).toBe(true);
  expect(
    recorder.spans.find((span) => span.name === 'voice.pipeline')?.ended
      ?.status,
  ).toBe('cancelled');
});

it('captures privacy options at construction instead of enabling capture after caller mutation', async () => {
  const tracing = { captureText: false, captureAudio: false };
  const pipeline = new VoicePipeline({
    tracing,
    workflow: {
      run: async function* () {
        yield 'accepted secret';
      },
    },
    provider: {
      transcribe: async function* () {
        yield 'transcript secret';
      },
      synthesize: async function* () {
        yield input;
      },
    },
  });
  tracing.captureText = true;
  tracing.captureAudio = true;
  for await (const _event of pipeline.run(input)) {
    /* Drain without retaining audio. */
  }
  expect(
    recorder.spans.every((span) => JSON.stringify(span.ended?.data) === '{}'),
  ).toBe(true);
});
