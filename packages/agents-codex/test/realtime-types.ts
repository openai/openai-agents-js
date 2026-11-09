import type { Session, NativeRealtimeSession } from '../src';

async function publicRealtimeTypes(session: Session) {
  await session.buildRealtimeSipConfig({
    instructions: 'Accept inbound calls.',
  });
  // @ts-expect-error SIP configuration does not resolve credentials or connect media.
  await session.buildRealtimeSipConfig({ apiKey: 'not-a-credential' });
  await session.buildRealtimeSipConfig({
    // @ts-expect-error Hosted MCP continuation is configured on attachment.
    automaticallyTriggerResponseForMcpToolCalls: false,
  });
  const voice: NativeRealtimeSession = await session.realtime({
    model: 'gpt-realtime',
    instructions: 'Delegate work.',
  });
  await voice.updateHistory([]);
  await voice.retrieveConversationItem('provider-item');
  await voice.retrieveConversationHistory();
  await voice.sendText('hello');
  await voice.sendAudio(Int16Array.of(1, 2));
  // @ts-expect-error Verified graph teardown is not a public media capability.
  await voice._nativeShutdown();
  // @ts-expect-error Authoritative event routing is private to Session.
  voice._ingest({});
  await voice.close();
}
void publicRealtimeTypes;
