import type { RealtimeSession } from '@openai/agents/realtime';

// Connect only after the server has authenticated the Twilio WebSocket upgrade.
async function connectAuthenticatedSession(
  session: RealtimeSession,
  apiKey: string,
) {
  await session.connect({ apiKey });
}
