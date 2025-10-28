import fastifyFactory from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { APIError, InvalidWebhookSignatureError } from 'openai/error';
import {
  OpenAIRealtimeSIP,
  RealtimeItem,
  RealtimeSession,
} from '@openai/agents/realtime';
import { getStartingAgent, WELCOME_MESSAGE } from './agents';

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_WEBHOOK_SECRET = process.env.OPENAI_WEBHOOK_SECRET;
const PORT = Number(process.env.PORT ?? 8000);

if (!OPENAI_API_KEY || !OPENAI_WEBHOOK_SECRET) {
  console.error(
    'Missing OPENAI_API_KEY or OPENAI_WEBHOOK_SECRET environment variables.',
  );
  process.exit(1);
}

const apiKey = OPENAI_API_KEY!;
const webhookSecret = OPENAI_WEBHOOK_SECRET!;

const openai = new OpenAI({
  apiKey,
  webhookSecret,
});

async function main() {
  const fastify = fastifyFactory();
  await fastify.register(fastifyRawBody, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
    routes: ['/openai/webhook'],
  });

  const activeCallTasks = new Map<string, Promise<void>>();
  const startingAgent = getStartingAgent();

  function getDefaultInstructions(): string {
    if (typeof startingAgent.instructions === 'string') {
      return startingAgent.instructions;
    }
    return 'You are a helpful triage agent for ABC customer service.';
  }

  async function acceptCall(callId: string): Promise<void> {
    try {
      await openai.realtime.calls.accept(callId, {
        type: 'realtime',
        model: 'gpt-realtime',
        instructions: getDefaultInstructions(),
      });
      console.info(`Accepted call ${callId}`);
    } catch (error) {
      if (error instanceof APIError && error.status === 404) {
        console.warn(
          `Call ${callId} no longer exists when attempting accept. Skipping.`,
        );
        return;
      }
      throw error;
    }
  }

  function logHistoryItem(item: RealtimeItem): void {
    if (item.type !== 'message') {
      return;
    }

    if (item.role === 'user') {
      for (const content of item.content) {
        if (content.type === 'input_text' && content.text) {
          console.info(`Caller: ${content.text}`);
        } else if (content.type === 'input_audio' && content.transcript) {
          console.info(`Caller (audio transcript): ${content.transcript}`);
        }
      }
    } else if (item.role === 'assistant') {
      for (const content of item.content) {
        if (content.type === 'output_text' && content.text) {
          console.info(`Assistant (text): ${content.text}`);
        } else if (content.type === 'output_audio' && content.transcript) {
          console.info(`Assistant (audio transcript): ${content.transcript}`);
        }
      }
    }
  }

  async function observeCall(callId: string): Promise<void> {
    const session = new RealtimeSession(startingAgent, {
      transport: new OpenAIRealtimeSIP(),
      model: 'gpt-realtime',
      config: {
        audio: {
          input: {
            turnDetection: {
              type: 'semantic_vad',
              interruptResponse: true,
            },
          },
        },
      },
    });

    session.on('history_added', (item: RealtimeItem) => logHistoryItem(item));
    session.on('agent_handoff', (_context, fromAgent, toAgent) => {
      console.info(`Handing off from ${fromAgent.name} to ${toAgent.name}.`);
    });
    session.on('error', (event) => {
      console.error('Realtime session error:', event.error);
    });

    try {
      await session.connect({ apiKey, callId });
      console.info(`Attached to realtime call ${callId}`);

      session.transport.sendEvent({
        type: 'response.create',
        response: {
          instructions: `Say exactly '${WELCOME_MESSAGE}' now before continuing the conversation.`,
        },
      });

      await new Promise<void>((resolve) => {
        const handleDisconnect = () => {
          session.transport.off('disconnected', handleDisconnect);
          resolve();
        };
        session.transport.on('disconnected', handleDisconnect);
      });
    } catch (error) {
      console.error(`Error while observing call ${callId}:`, error);
    } finally {
      session.close();
      console.info(`Call ${callId} ended`);
    }
  }

  fastify.post('/openai/webhook', async (request, reply) => {
    const rawBody = (request as unknown as { rawBody?: string | Buffer })
      .rawBody;
    const payload =
      typeof rawBody === 'string' ? rawBody : rawBody?.toString('utf8');

    if (!payload) {
      reply
        .status(400)
        .send({ error: 'Missing raw body for webhook verification.' });
      return;
    }

    let event: Awaited<ReturnType<typeof openai.webhooks.unwrap>>;
    try {
      event = await openai.webhooks.unwrap(payload, request.headers);
    } catch (error) {
      if (error instanceof InvalidWebhookSignatureError) {
        console.warn('Invalid webhook signature.');
        reply.status(400).send({ error: 'Invalid webhook signature.' });
        return;
      }
      console.error('Failed to parse webhook payload.', error);
      reply.status(500).send({ error: 'Failed to parse webhook payload.' });
      return;
    }

    if (event.type === 'realtime.call.incoming') {
      const callId = event.data.call_id;
      try {
        await acceptCall(callId);
      } catch (error) {
        console.error(`Failed to accept call ${callId}:`, error);
        reply.status(500).send({ error: 'Failed to accept call.' });
        return;
      }

      if (!activeCallTasks.has(callId)) {
        const task = observeCall(callId)
          .catch((error) => {
            console.error(
              `Unhandled error while observing call ${callId}:`,
              error,
            );
          })
          .finally(() => {
            activeCallTasks.delete(callId);
          });
        activeCallTasks.set(callId, task);
      } else {
        console.info(
          `Call ${callId} already being observed; skipping duplicate webhook.`,
        );
      }
    }

    reply.status(200).send({ ok: true });
  });

  fastify.get('/', async () => ({ status: 'ok' }));

  const shutdown = async () => {
    try {
      await fastify.close();
    } catch (error) {
      console.error('Error during shutdown.', error);
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await fastify.listen({ host: '0.0.0.0', port: PORT });
    console.log(`Server listening on port ${PORT}`);
  } catch (error) {
    console.error('Failed to start server.', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Failed to start server.', error);
  process.exit(1);
});
