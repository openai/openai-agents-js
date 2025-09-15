import express from 'express';
import type { Request, Response } from 'express';
import expressWs from 'express-ws';
import type { WebSocket } from 'ws';
import dotenv from 'dotenv';
import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';
import { PlivoRealtimeTransportLayer } from '@openai/agents-extensions';
import process from 'node:process';
import * as Plivo from 'plivo';
// Load environment variables from .env file
dotenv.config();
const LOCAL_TUNNEL_URL = process.env.LOCAL_TUNNEL_URL;
let realtimeSession: RealtimeSession | null = null;
let plivoTransportLayer: PlivoRealtimeTransportLayer | null = null;

// Retrieve the OpenAI API key from environment variables. You must have OpenAI Realtime API access.
const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error('Missing OpenAI API key. Please set it in the .env file.');
  process.exit(1);
}
const PORT = +(process.env.PORT || 5050);

// Initialize Express
const app = express();
const expressWsApp = expressWs(app).app;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const agent = new RealtimeAgent({
  name: 'Plivogue',
  // system prompt
  instructions: `You are Plivogue, a friendly assistant by Plivo.
    Any query about Plivo should be answered by you.
    Greet the user with a friendly message which also tells the user about you.
    `,
});

// Root Route
app.get('/', (_: Request, res: Response) => {
  res.json({ message: 'Plivo Media Stream Server is running!' });
});

app.post(`/update-agent`, async (req: Request, res: Response) => {
  try {
    const { instructions, prompt } = req.body;
    if (!realtimeSession) {
      return res.status(400).json({ message: 'Session not found' });
    }
    plivoTransportLayer?.updateSessionConfig({
      instructions,
      prompt,
    });

    return res.json({ message: 'Agent updated', agent: prompt });
  } catch (error) {
    console.error('Error updating agent', error);
    return res.status(500).json({ message: 'Error updating agent' });
  }
});

app.get('/client', (_: Request, res: Response) => {
  let modifiedUrl = LOCAL_TUNNEL_URL;
  if (modifiedUrl?.includes(`https://`) || modifiedUrl?.includes(`http://`)) {
    modifiedUrl = modifiedUrl.replace(/^https?:\/\//, '');
  }
  const plivoResponse = new (Plivo as any).Response();
  plivoResponse.addSpeak('You can now chat with Plivogue');
  const params = {
    contentType: 'audio/x-mulaw;rate=8000',
    keepCallAlive: true,
    bidirectional: true,
  };
  plivoResponse.addStream(`wss://${modifiedUrl}/stream`, params);
  res.header('Content-Type', 'application/xml');
  res.header('Content-Length', plivoResponse.toString().length.toString());
  res.header('Connection', 'keep-alive');
  res.header('Keep-Alive', 'timeout=60');
  const xml = plivoResponse.toXML();
  res.send(xml);
});

// WebSocket route for media-stream
expressWsApp.ws('/stream', async (ws: WebSocket, _: Request) => {
  plivoTransportLayer = new PlivoRealtimeTransportLayer({
    plivoWebSocket: ws,
  });

  realtimeSession = new RealtimeSession(agent, {
    apiKey: OPENAI_API_KEY,
    transport: plivoTransportLayer,
    model: 'gpt-4o-realtime-preview',
    config: {
      audio: {
        output: {
          voice: 'verse',
        },
      },
    },
  });
  realtimeSession.on('error', (error: any) => {
    console.error('Error', error);
  });

  await realtimeSession.connect({
    apiKey: OPENAI_API_KEY,
  });
  console.log('Connected to the OpenAI Realtime API');
});

const server = app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
