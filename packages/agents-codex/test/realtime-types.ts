import type { Session, NativeRealtimeSession } from '../src';

async function publicRealtimeTypes(session: Session) {
  const voice: NativeRealtimeSession = await session.realtime({
    model: 'gpt-realtime',
    instructions: 'Delegate work.',
  });
  await voice.sendText('hello');
  await voice.sendAudio(Int16Array.of(1, 2));
  // @ts-expect-error Verified graph teardown is not a public media capability.
  await voice._nativeShutdown();
  // @ts-expect-error Authoritative event routing is private to Session.
  voice._ingest({});
  await voice.close();
}
void publicRealtimeTypes;
