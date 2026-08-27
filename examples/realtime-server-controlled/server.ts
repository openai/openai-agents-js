import dotenv from 'dotenv';
import OpenAI from 'openai';
import {
  DEFAULT_OPENAI_REALTIME_MODEL,
  RealtimeSession,
  type RealtimeSessionOptions,
} from '@openai/agents-realtime';
import { createVoiceAgent, type VoiceContext } from './src/server/agent';
import { createApiServer } from './src/server/apiServer';
import { DemoAuthStore } from './src/server/demoAuth';
import { createRealtimeCall } from './src/server/realtimeCall';
import { SessionManager } from './src/server/sessionManager';
import { shutdownApiServer } from './src/server/shutdown';
import { connectSidebandAndWaitForReady } from './src/server/sidebandReady';
import {
  VoiceController,
  type ControllerSession,
} from './src/server/voiceController';
import { parseApiPort } from './src/shared/config';

dotenv.config({ path: '.env.local' });

const apiKey = process.env.OPENAI_API_KEY;
const appOrigin = process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
const model =
  process.env.OPENAI_REALTIME_MODEL ?? DEFAULT_OPENAI_REALTIME_MODEL;
let port: number;
const voice = process.env.OPENAI_REALTIME_VOICE ?? 'marin';

if (!apiKey) {
  console.error('OPENAI_API_KEY is required in .env.local.');
  process.exit(1);
}
try {
  port = parseApiPort(process.env.PORT);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'PORT is invalid.');
  process.exit(1);
}

const openai = new OpenAI({ apiKey, timeout: 10_000 });
const sessions = new SessionManager({
  hangup: (callId) => openai.realtime.calls.hangup(callId),
  maxSessions: 100,
});

const sessionOptions: Partial<RealtimeSessionOptions<VoiceContext>> = {
  model,
  transport: 'websocket',
  config: {
    audio: {
      input: {
        turnDetection: {
          type: 'server_vad',
          createResponse: true,
          interruptResponse: true,
        },
      },
      output: { voice },
    },
  },
};

const controller = new VoiceController({
  apiKey,
  sessions,
  connectSideband: connectSidebandAndWaitForReady,
  createCall: ({ offerSdp, safetyIdentifier, signal }) =>
    createRealtimeCall({
      apiKey,
      hangupCall: (callId) => sessions.closeDetachedCall(callId),
      model,
      offerSdp,
      safetyIdentifier,
      signal,
      voice,
    }),
  createSession: (callbacks) => {
    const session = new RealtimeSession(createVoiceAgent(), {
      ...sessionOptions,
      context: { ownerId: callbacks.ownerId },
    }) as unknown as ControllerSession;
    VoiceController.wireSessionEvents(session, callbacks);
    return session;
  },
});

const auth = new DemoAuthStore({
  secureCookie: new URL(appOrigin).protocol === 'https:',
});
const server = createApiServer({ appOrigin, auth, controller, sessions });

const cleanupTimer = setInterval(() => {
  void sessions.closeExpired(30 * 60 * 1000);
}, 60_000);
cleanupTimer.unref();

server.listen(port, '127.0.0.1', () => {
  console.info(`Realtime BFF listening on http://127.0.0.1:${port}`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  clearInterval(cleanupTimer);
  await shutdownApiServer(server, sessions);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
