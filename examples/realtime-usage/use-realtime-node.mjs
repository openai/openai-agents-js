// examples/realtime-usage/use-realtime-node.mjs
// Node ESM example that imports the built ESM bundle
// Adjust the import path if your build outputs to a different location.
import * as realtime from '../../packages/agents-realtime/dist/bundle/openai-realtime-agents.mjs';

console.log('Available exports from realtime bundle:', Object.keys(realtime));

async function run() {
  const { OpenAIRealtimeWebSocket } = realtime;
  if (!OpenAIRealtimeWebSocket) {
    throw new Error('OpenAIRealtimeWebSocket not found in bundle exports');
  }

  const ws = new OpenAIRealtimeWebSocket({
    url: 'wss://api.openai.com/v1/realtime?model=gpt-5-mini',
  });

  ws.on('connection_change', (s) => console.log('connection_change', s));
  ws.on('message', (m) => console.log('message', m));
  ws.on('audio', (a) => console.log('audio event', a && a.responseId));

  // Provide API key via env var
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('Please set OPENAI_API_KEY');
    process.exit(1);
  }

  await ws.connect({ apiKey });
  console.log('connected:', ws.status);

  ws.sendEvent({
    type: 'response.create',
    response: {
      instructions: [{ role: 'user', content: 'Say hello' }],
    },
  });

  // Wait then close
  await new Promise((r) => setTimeout(r, 5000));
  ws.close();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
