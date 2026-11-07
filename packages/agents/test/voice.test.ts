import { expect, it } from 'vitest';
import * as voice from '@openai/agents/voice';
import * as owningVoice from '@openai/agents-codex/voice';

it('exposes the native speech implementations through the convenience voice subpath', () => {
  expect(voice.NativeSessionVoiceWorkflow).toBe(
    owningVoice.NativeSessionVoiceWorkflow,
  );
  expect(voice.VoicePipeline).toBe(owningVoice.VoicePipeline);
  expect(voice.OpenAISpeechProvider).toBe(owningVoice.OpenAISpeechProvider);
  expect(voice.VoiceEventGapError).toBe(owningVoice.VoiceEventGapError);
});
