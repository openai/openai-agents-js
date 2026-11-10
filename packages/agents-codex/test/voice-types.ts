import {
  VoicePipeline,
  type AudioFrame,
  type SpeechProvider,
  type VoicePipelineOptions,
} from '../src/voice';

async function voiceOutputTypes(provider: SpeechProvider) {
  const workflow = {
    run: async function* () {
      yield 'accepted';
    },
  };
  const input: AudioFrame<Float32Array> = {
    data: Float32Array.of(0.5),
    sampleRate: 24000,
    channels: 1,
  };
  // @ts-expect-error A float32 promise needs its runtime discriminator.
  new VoicePipeline<'float32'>({ workflow, provider });
  // @ts-expect-error Options must carry the same runtime discriminator.
  const missingDtype: VoicePipelineOptions<'float32'> = { workflow, provider };
  void missingDtype;
  new VoicePipeline<'int16'>({ workflow, provider });
  new VoicePipeline<'int16' | 'float32'>({ workflow, provider });
  new VoicePipeline<'float32'>({ workflow, provider, outputDtype: 'float32' });
  for await (const event of new VoicePipeline({ workflow, provider }).run(
    input,
  )) {
    if (event.type === 'audio') {
      const pcm: Int16Array = event.frame.data;
      void pcm;
      // @ts-expect-error Default output remains int16.
      const floating: Float32Array = event.frame.data;
      void floating;
    }
  }
  for await (const event of new VoicePipeline({
    workflow,
    provider,
    outputDtype: 'float32',
    outputTransform: (frame) => {
      const pcm: Float32Array = frame.data;
      return { ...frame, data: pcm };
    },
  }).run(input))
    if (event.type === 'audio') {
      const floating: Float32Array = event.frame.data;
      void floating;
    }
}
void voiceOutputTypes;
