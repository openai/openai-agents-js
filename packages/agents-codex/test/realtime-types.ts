import type {
  ResponseCreateEvent,
  ResponseCancelEvent,
  ConversationItem,
} from 'openai/resources/realtime/realtime';
import type { Session, NativeRealtimeSession } from '../src';

async function publicRealtimeTypes(session: Session) {
  await session.buildRealtimeSipConfig({
    instructions: 'Accept inbound calls.',
  });
  // @ts-expect-error SIP configuration does not resolve credentials or connect media.
  await session.buildRealtimeSipConfig({ apiKey: 'not-a-credential' });
  await session.buildRealtimeSipConfig({
    // @ts-expect-error A WebSocket URL is unavailable for SIP acceptance.
    url: 'wss://gateway.invalid/realtime',
  });
  await session.buildRealtimeSipConfig({
    // @ts-expect-error Hosted MCP continuation is configured on attachment.
    automaticallyTriggerResponseForMcpToolCalls: false,
  });
  const voice: NativeRealtimeSession = await session.realtime({
    model: 'gpt-realtime',
    instructions: 'Delegate work.',
    url: 'wss://gateway.invalid/realtime',
  });
  const create: ResponseCreateEvent = { type: 'response.create' };
  const cancel: ResponseCancelEvent = { type: 'response.cancel' };
  const item: ConversationItem = {
    type: 'message',
    role: 'user',
    id: 'typed-item',
    content: [{ type: 'input_text', text: 'hello' }],
  };
  // @ts-expect-error A provider event requires a type or generic JSON fields.
  await voice.sendEvent(new Date());
  // @ts-expect-error A provider item requires a type or generic JSON fields.
  await voice.updateHistory([new Date()]);
  await voice.sendEvent(create);
  await voice.sendEvent(cancel);
  await voice.updateHistory([item]);
  await voice.updateHistory((history) => [...history, item]);
  // @ts-expect-error Provider events must be objects.
  await voice.sendEvent('response.create');
  // @ts-expect-error Provider history items must be objects.
  await voice.updateHistory(['typed-item']);
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
