import { expect, it } from 'vitest';
import { Agent, realtime } from '@openai/agents';
import { Agent as NativeAgent } from '@openai/agents-codex';
import { RealtimeSession } from '@openai/agents/realtime';

it('preserves the native root and the Classic realtime namespace identity', () => {
  expect(Agent).toBe(NativeAgent);
  expect(realtime.RealtimeSession).toBe(RealtimeSession);
});
