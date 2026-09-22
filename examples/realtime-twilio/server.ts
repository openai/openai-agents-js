import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import twilio from 'twilio';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents/realtime';
import { TwilioRealtimeTransportLayer } from '@openai/agents-extensions';
import { hostedMcpTool } from '@openai/agents';
import { z } from 'zod';
import process from 'node:process';

export type TwilioServerConfig = {
  openAiApiKey: string;
  twilioAuthToken: string;
  publicBaseUrl: string;
};

export function buildServer(config: TwilioServerConfig): FastifyInstance {
  if (!config.openAiApiKey || !config.twilioAuthToken) {
    throw new Error('OPENAI_API_KEY and TWILIO_AUTH_TOKEN are required.');
  }
  let publicUrl: URL;
  try {
    publicUrl = new URL(config.publicBaseUrl);
  } catch {
    throw new Error('TWILIO_PUBLIC_BASE_URL must be a valid HTTPS origin.');
  }
  if (
    publicUrl.protocol !== 'https:' ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.pathname !== '/' ||
    publicUrl.search ||
    publicUrl.hash
  ) {
    throw new Error(
      'TWILIO_PUBLIC_BASE_URL must be an HTTPS origin without credentials, a path, query, or fragment.',
    );
  }
  const publicOrigin = publicUrl.origin;
  const streamUrl =
    publicOrigin.replace('https://', 'wss://') + '/media-stream';
  const signature = (request: FastifyRequest) => {
    const value = request.headers['x-twilio-signature'];
    return typeof value === 'string' ? value : '';
  };

  const debugRealtimeEventTypes = new Set([
    'session.created',
    'session.updated',
    'input_audio_buffer.speech_started',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.committed',
    'conversation.item.input_audio_transcription.completed',
    'response.created',
    'response.output_audio.done',
    'response.done',
    'error',
  ]);

  function decodeMuLawSample(value: number): number {
    const sample = ~value & 0xff;
    const sign = sample & 0x80;
    const exponent = (sample >> 4) & 0x07;
    const mantissa = sample & 0x0f;
    const magnitude = ((mantissa << 3) + 0x84) * 2 ** exponent - 0x84;
    return sign === 0 ? magnitude : -magnitude;
  }

  // Initialize Fastify.
  const fastify = Fastify();
  fastify.register(fastifyFormBody);
  fastify.register(fastifyWs);

  const weatherTool = tool({
    name: 'weather',
    description: 'Get the weather in a given location.',
    parameters: z.object({
      location: z.string(),
    }),
    execute: async ({ location }: { location: string }) => {
      return `The weather in ${location} is sunny.`;
    },
  });

  const secretTool = tool({
    name: 'secret',
    description: 'A secret tool to tell the special number.',
    parameters: z.object({
      question: z
        .string()
        .describe(
          'The question to ask the secret tool; mainly about the special number.',
        ),
    }),
    execute: async ({ question }: { question: string }) => {
      return `The answer to ${question} is 42.`;
    },
    needsApproval: true,
  });

  const agent = new RealtimeAgent({
    name: 'Voice Assistant',
    instructions:
      'You are a friendly voice assistant. Respond naturally and concisely. When you use a tool, always first say what you are about to do.',
    tools: [
      hostedMcpTool({
        serverLabel: 'deepwiki',
        serverUrl: 'https://mcp.deepwiki.com/mcp',
      }),
      secretTool,
      weatherTool,
    ],
  });

  // Root route.
  fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
  });

  // Authenticate call webhooks before returning call instructions.
  fastify.route({
    method: ['GET', 'POST'],
    url: '/incoming-call',
    exposeHeadRoute: false,
    onRequest: async (request, reply) => {
      if (!signature(request)) {
        return reply.code(403).send('Invalid Twilio signature.');
      }
      if (
        request.method === 'POST' &&
        request.headers['content-type']?.split(';')[0].trim().toLowerCase() !==
          'application/x-www-form-urlencoded'
      ) {
        return reply.code(415).send('Expected a form-encoded Twilio webhook.');
      }
    },
    preValidation: async (request, reply) => {
      const rawUrl = request.raw.url ?? '';
      const queryStart = rawUrl.indexOf('?');
      const query = queryStart < 0 ? '' : rawUrl.slice(queryStart);
      const url = publicOrigin + '/incoming-call' + query;
      const params =
        request.method === 'POST'
          ? (request.body as Record<string, string | string[]>)
          : {};
      if (
        !twilio.validateRequest(
          config.twilioAuthToken,
          signature(request),
          url,
          params,
        )
      ) {
        return reply.code(403).send('Invalid Twilio signature.');
      }
    },
    handler: async (_request, reply) => {
      const response = new twilio.twiml.VoiceResponse();
      response.say('O.K. you can start talking!');
      response.connect().stream({ url: streamUrl });
      return reply.type('text/xml').send(response.toString());
    },
  });

  // WebSocket route for media-stream.
  fastify.register(async (scopedFastify: FastifyInstance) => {
    scopedFastify.get(
      '/media-stream',
      {
        websocket: true,
        preValidation: async (request, reply) => {
          const signed = signature(request);
          if (
            !signed ||
            request.raw.url?.includes('?') ||
            !(
              twilio.validateRequest(
                config.twilioAuthToken,
                signed,
                streamUrl,
                {},
              ) ||
              twilio.validateRequest(
                config.twilioAuthToken,
                signed,
                streamUrl + '/',
                {},
              )
            )
          ) {
            return reply.code(403).send('Invalid Twilio signature.');
          }
        },
      },
      async (connection: any) => {
        let twilioTransportLayer: TwilioRealtimeTransportLayer | undefined;
        let session: RealtimeSession | undefined;
        try {
          twilioTransportLayer = new TwilioRealtimeTransportLayer({
            twilioWebSocket: connection,
          });

          session = new RealtimeSession(agent, {
            transport: twilioTransportLayer,
            model: 'gpt-realtime-2.1',
            config: {
              audio: {
                output: {
                  voice: 'verse',
                },
              },
            },
          });

          const connectedSession = session;
          session.on('error', (error: unknown) => {
            console.error('Realtime session error.', error);
          });

          if (process.env.DEBUG) {
            connection.addEventListener('close', (event: any) => {
              console.log(
                'Twilio WebSocket closed:',
                JSON.stringify({
                  code: event.code,
                  reason: event.reason ? String(event.reason) : undefined,
                }),
              );
            });
            let inputSampleCount = 0;
            let inputSquareSum = 0;
            let inputPeak = 0;
            let mediaFrameCount = 0;
            let mediaByteCount = 0;
            let minimumMediaBytes = Number.POSITIVE_INFINITY;
            let maximumMediaBytes = 0;
            let previousMediaTimestamp: number | undefined;
            let previousMediaArrivalTime: number | undefined;
            let previousMediaChunk: string | undefined;
            const mediaTracks = new Set<string>();

            session.on(
              'transport_event',
              (event: {
                type: string;
                message?: {
                  event?: string;
                  start?: {
                    mediaFormat?: {
                      encoding?: string;
                      sampleRate?: number;
                      channels?: number;
                    };
                  };
                  media?: {
                    payload?: string;
                    track?: string;
                    chunk?: string;
                    timestamp?: string;
                  };
                };
                session?: {
                  audio?: {
                    input?: {
                      format?: unknown;
                      noise_reduction?: unknown;
                      turn_detection?: unknown;
                    };
                  };
                };
                response?: {
                  status?: string;
                  status_details?: unknown;
                };
              }) => {
                if (debugRealtimeEventTypes.has(event.type)) {
                  console.log(`Realtime transport event: ${event.type}`);
                }
                if (
                  event.type === 'twilio_message' &&
                  event.message?.event === 'start'
                ) {
                  console.log(
                    'Twilio media format:',
                    JSON.stringify(event.message.start?.mediaFormat),
                  );
                }
                if (
                  event.type === 'twilio_message' &&
                  event.message?.event === 'stop'
                ) {
                  console.log('Twilio media stream stopped.');
                }
                if (
                  event.type === 'twilio_message' &&
                  event.message?.event === 'media' &&
                  typeof event.message.media?.payload === 'string'
                ) {
                  const payload = event.message.media.payload;
                  const media = event.message.media;
                  const audio = Buffer.from(payload, 'base64');
                  const arrivalTime = Date.now();
                  const mediaTimestamp = Number(media.timestamp);
                  const arrivalGap =
                    previousMediaArrivalTime === undefined
                      ? undefined
                      : arrivalTime - previousMediaArrivalTime;
                  const timestampGap =
                    previousMediaTimestamp === undefined ||
                    !Number.isFinite(mediaTimestamp)
                      ? undefined
                      : mediaTimestamp - previousMediaTimestamp;

                  if (typeof media.track === 'string') {
                    mediaTracks.add(media.track);
                  }
                  mediaFrameCount += 1;
                  mediaByteCount += audio.byteLength;
                  minimumMediaBytes = Math.min(
                    minimumMediaBytes,
                    audio.byteLength,
                  );
                  maximumMediaBytes = Math.max(
                    maximumMediaBytes,
                    audio.byteLength,
                  );

                  if (
                    (arrivalGap !== undefined && arrivalGap > 100) ||
                    (timestampGap !== undefined && timestampGap > 100)
                  ) {
                    console.log(
                      'Twilio media gap:',
                      JSON.stringify({
                        arrivalMs: arrivalGap,
                        timestampMs: timestampGap,
                        previousChunk: previousMediaChunk,
                        chunk: media.chunk,
                      }),
                    );
                  }

                  if (mediaFrameCount % 50 === 0) {
                    console.log(
                      'Twilio media frames:',
                      JSON.stringify({
                        frames: mediaFrameCount,
                        averageBytes: Math.round(
                          mediaByteCount / mediaFrameCount,
                        ),
                        minimumBytes: minimumMediaBytes,
                        maximumBytes: maximumMediaBytes,
                        tracks: [...mediaTracks],
                        latestTimestamp: Number.isFinite(mediaTimestamp)
                          ? mediaTimestamp
                          : media.timestamp,
                      }),
                    );
                  }

                  previousMediaArrivalTime = arrivalTime;
                  previousMediaTimestamp = Number.isFinite(mediaTimestamp)
                    ? mediaTimestamp
                    : undefined;
                  previousMediaChunk = media.chunk;

                  for (const value of audio) {
                    const sample = decodeMuLawSample(value);
                    inputSampleCount += 1;
                    inputSquareSum += sample * sample;
                    inputPeak = Math.max(inputPeak, Math.abs(sample));
                  }
                  if (inputSampleCount >= 8000) {
                    const rms = Math.sqrt(inputSquareSum / inputSampleCount);
                    const rmsDbfs =
                      rms === 0 ? -96 : 20 * Math.log10(rms / 32768);
                    const peakDbfs =
                      inputPeak === 0
                        ? -96
                        : 20 * Math.log10(inputPeak / 32768);
                    console.log(
                      `Twilio input level: rms=${rmsDbfs.toFixed(1)} dBFS peak=${peakDbfs.toFixed(1)} dBFS`,
                    );
                    inputSampleCount = 0;
                    inputSquareSum = 0;
                    inputPeak = 0;
                  }
                }
                if (event.type === 'session.updated') {
                  const inputAudio = event.session?.audio?.input;
                  console.log(
                    'Realtime input configuration:',
                    JSON.stringify({
                      format: inputAudio?.format,
                      noiseReduction: inputAudio?.noise_reduction,
                      turnDetection: inputAudio?.turn_detection,
                    }),
                  );
                }
                if (event.type === 'response.done') {
                  console.log(
                    'Realtime response completed:',
                    JSON.stringify({
                      status: event.response?.status,
                      statusDetails: event.response?.status_details,
                    }),
                  );
                }
              },
            );
            session.on('audio_start', () => {
              console.log('Realtime audio started.');
            });
            session.on('audio_stopped', () => {
              console.log('Realtime audio stopped.');
            });
            session.on('audio_interrupted', () => {
              console.log('Realtime audio interrupted.');
            });
          }

          session.on('mcp_tools_changed', (tools: { name: string }[]) => {
            const toolNames = tools.map((tool) => tool.name).join(', ');
            console.log(`Available MCP tools: ${toolNames || 'None'}`);
          });

          session.on(
            'tool_approval_requested',
            (_context: unknown, _agent: unknown, approvalRequest: any) => {
              console.log(
                `Approving tool call for ${approvalRequest.approvalItem.rawItem.name}.`,
              );
              connectedSession
                .approve(approvalRequest.approvalItem)
                .catch((error: unknown) =>
                  console.error('Failed to approve tool call.', error),
                );
            },
          );

          session.on(
            'mcp_tool_call_completed',
            (_context: unknown, _agent: unknown, toolCall: unknown) => {
              console.log('MCP tool call completed.', toolCall);
            },
          );

          await session.connect({
            apiKey: config.openAiApiKey,
          });
          console.log('Connected to the OpenAI Realtime API');
        } catch {
          console.error('Twilio session startup failed.');
          try {
            if (session) session.close();
            else twilioTransportLayer?.close();
          } catch {
            console.error('Twilio session cleanup failed.');
          } finally {
            connection.close(1011, 'Session startup failed.');
          }
        }
      },
    );
  });

  return fastify;
}
