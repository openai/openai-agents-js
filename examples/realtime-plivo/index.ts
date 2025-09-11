import express from 'express';
import type { Request, Response } from 'express';
import expressWs from 'express-ws';
import type { WebSocket } from 'ws';
import dotenv from 'dotenv';
import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';
import { PlivoRealtimeTransportLayer } from '@openai/agents-extensions';
import process from 'node:process';

// Load environment variables from .env file
dotenv.config();

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

// WebSocket route for media-stream
expressWsApp.ws('/stream', async (ws: WebSocket, _: Request) => {
  const plivoTransportLayer = new PlivoRealtimeTransportLayer({
    plivoWebSocket: ws,
  });

  const session = new RealtimeSession(agent, {
    apiKey: OPENAI_API_KEY,
    transport: plivoTransportLayer,
    model: 'gpt-realtime',
    config: {
      audio: {
        output: {
          voice: 'verse',
        },
      },
    },
  });
  session.on('error', (error: any) => {
    console.error('Error', error);
  });

  await session.connect({
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
