import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import type { RealtimeItem } from '@openai/agents/realtime';
import { APIError, InvalidWebhookSignatureError } from 'openai/error';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accept: vi.fn(),
  unwrap: vi.fn(),
  buildInitialConfig: vi.fn(),
  connect: vi.fn(),
  sendEvent: vi.fn(),
  closeSession: vi.fn(),
  listen: vi.fn(),
  startup: vi.fn(),
  sessions: [] as FakeSession[],
  app: undefined as FastifyInstance | undefined,
}));

// SIP events and failures require controlled transport delivery, not a text model.
class FakeSession extends EventEmitter {
  transport = Object.assign(new EventEmitter(), { sendEvent: mocks.sendEvent });
  connect = mocks.connect;
  close = mocks.closeSession;
}

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));
vi.mock('openai', () => ({
  default: class {
    realtime = { calls: { accept: mocks.accept } };
    webhooks = { unwrap: mocks.unwrap };
  },
}));
vi.mock('@openai/agents/realtime', () => ({
  OpenAIRealtimeSIP: class {
    static buildInitialConfig = mocks.buildInitialConfig;
  },
  RealtimeSession: class extends FakeSession {
    constructor() {
      super();
      mocks.sessions.push(this);
    }
  },
}));
vi.mock('./agents', () => ({
  getStartingAgent: () => {
    mocks.startup();
    return { name: 'Triage Agent' };
  },
  WELCOME_MESSAGE: 'Synthetic welcome.',
}));
vi.mock('fastify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fastify')>();
  return {
    ...actual,
    default: () => {
      const app = actual.default();
      mocks.app = app;
      // Inject exercises real routes and raw-body parsing without opening a port.
      app.listen = mocks.listen;
      return app;
    },
  };
});

const consoleMethods = ['info', 'warn', 'error', 'log', 'debug'] as const;
let logs: unknown[][];
let signals: Map<string, () => void>;
let exit: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-test-key');
  vi.stubEnv('OPENAI_WEBHOOK_SECRET', 'synthetic-test-secret');
  vi.stubEnv('TWILIO_SIP_LOG_TRANSCRIPTS', undefined);
  logs = [];
  signals = new Map();
  mocks.sessions = [];
  mocks.app = undefined;
  mocks.unwrap.mockResolvedValue({
    type: 'realtime.call.incoming',
    data: { call_id: 'call-test' },
  });
  mocks.buildInitialConfig.mockResolvedValue({ model: 'synthetic-model' });
  for (const method of consoleMethods) {
    vi.spyOn(console, method).mockImplementation((...args) => logs.push(args));
  }
  exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const originalOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation((event, listener) => {
    if (event === 'SIGINT' || event === 'SIGTERM') {
      signals.set(event, listener);
      return process;
    }
    return originalOn(event, listener);
  });
});

afterEach(async () => {
  for (const session of mocks.sessions) {
    session.transport.emit('disconnected');
  }
  await flushTasks();
  await mocks.app?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function flushTasks() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function start(setting?: string) {
  vi.stubEnv('TWILIO_SIP_LOG_TRANSCRIPTS', setting);
  await import('./server');
  await flushTasks();
  return mocks.app!;
}

async function incoming(app: FastifyInstance) {
  return app.inject({
    method: 'POST',
    url: '/openai/webhook',
    payload: { synthetic: true },
  });
}

function assertSafeDiagnostics() {
  expect(logs.length).toBeGreaterThan(0);
  for (const args of logs) {
    for (const arg of args) {
      // Reject raw objects too: JSON.stringify(Error) would miss message/stack.
      expect(typeof arg).toBe('string');
      expect(arg).not.toContain('sentinel');
    }
  }
}

function errorPayload() {
  return Object.assign(new Error('message-sentinel'), {
    cause: new Error('cause-sentinel'),
    detail: { body: 'body-sentinel' },
  });
}

describe('Twilio SIP example logging', () => {
  it.each([undefined, '', '0', 'true', '1'])(
    'requires exact transcript opt-in %s and preserves call lifecycle',
    async (setting) => {
      const app = await start(setting);
      const response = await incoming(app);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      const session = mocks.sessions[0];
      session.emit('history_added', {
        itemId: 'user-message',
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [
          { type: 'input_text', text: 'caller-text-sentinel' },
          { type: 'input_audio', transcript: 'caller-audio-sentinel' },
        ],
      } satisfies RealtimeItem);
      session.emit('history_added', {
        itemId: 'assistant-message',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          { type: 'output_text', text: 'assistant-text-sentinel' },
          { type: 'output_audio', transcript: 'assistant-audio-sentinel' },
        ],
      } satisfies RealtimeItem);
      session.emit('history_added', {
        itemId: 'tool-item',
        type: 'function_call',
        name: 'faq_lookup_tool',
        status: 'completed',
        arguments: '{"question":"tool-arguments-sentinel"}',
        output: 'tool-output-sentinel',
      } satisfies RealtimeItem);
      session.emit(
        'agent_handoff',
        {},
        { name: 'Triage Agent' },
        { name: 'FAQ Agent' },
      );
      if (setting === '1') {
        expect(logs).toEqual(
          expect.arrayContaining([
            ['Caller: caller-text-sentinel'],
            ['Caller (audio transcript): caller-audio-sentinel'],
            ['Assistant (text): assistant-text-sentinel'],
            ['Assistant (audio transcript): assistant-audio-sentinel'],
          ]),
        );
        expect(logs.flat().join(' ')).not.toContain('tool-');
      } else {
        assertSafeDiagnostics();
      }
      expect(logs).toContainEqual([
        'Handing off from Triage Agent to FAQ Agent.',
      ]);
      expect(logs).toContainEqual(['Accepted call call-test']);
      expect(mocks.sendEvent).toHaveBeenCalledWith({
        type: 'response.create',
        response: {
          instructions:
            "Say exactly 'Synthetic welcome.' now before continuing the conversation.",
        },
      });
      await incoming(app);
      expect(mocks.sessions).toHaveLength(1);
      session.transport.emit('disconnected');
      await flushTasks();
      expect(session.transport.listenerCount('disconnected')).toBe(0);
      expect(mocks.closeSession).toHaveBeenCalledTimes(1);
      expect(logs).toContainEqual(['Call call-test ended']);
      await incoming(app);
      expect(mocks.sessions).toHaveLength(2);
    },
  );

  it.each([undefined, '1'])(
    'omits arbitrary error event payloads and continues with opt-in %s',
    async (setting) => {
      await incoming(await start(setting));
      const session = mocks.sessions[0];
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      const hostile = new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error('prototype-sentinel');
          },
          get() {
            throw new Error('property-sentinel');
          },
        },
      );
      for (const error of [
        errorPayload(),
        'string-sentinel',
        { data: 'object-sentinel' },
        revoked.proxy,
        hostile,
      ]) {
        expect(() => session.emit('error', { error })).not.toThrow();
      }
      expect(mocks.closeSession).not.toHaveBeenCalled();
      session.transport.emit('disconnected');
      await flushTasks();
      expect(mocks.closeSession).toHaveBeenCalledTimes(1);
      expect(
        logs.filter(
          ([message]) =>
            message === 'Realtime session error for call call-test.',
        ),
      ).toHaveLength(5);
      assertSafeDiagnostics();
    },
  );

  it.each([undefined, '1'])(
    'contains observer failures and cleans up with opt-in %s',
    async (setting) => {
      for (const failure of ['connect', 'send', 'close'] as const) {
        const app = mocks.app ?? (await start(setting));
        if (failure === 'connect')
          mocks.connect.mockRejectedValueOnce(errorPayload());
        if (failure === 'send')
          mocks.sendEvent.mockImplementationOnce(() => {
            throw errorPayload();
          });
        if (failure === 'close')
          mocks.closeSession.mockImplementationOnce(() => {
            throw errorPayload();
          });
        const response = await incoming(app);
        expect(response.statusCode).toBe(200);
        mocks.sessions[mocks.sessions.length - 1].transport.emit(
          'disconnected',
        );
        await flushTasks();
      }
      expect(mocks.sessions).toHaveLength(3);
      expect(mocks.closeSession).toHaveBeenCalledTimes(3);
      expect(logs).toContainEqual(['Error while observing call call-test.']);
      expect(logs).toContainEqual([
        'Unhandled error while observing call call-test.',
      ]);
      assertSafeDiagnostics();
    },
  );

  it.each([undefined, '1'])(
    'preserves webhook responses without errors in logs with opt-in %s',
    async (setting) => {
      const app = await start(setting);
      const missing = await app.inject({
        method: 'POST',
        url: '/openai/webhook',
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toEqual({
        error: 'Missing raw body for webhook verification.',
      });
      mocks.unwrap.mockRejectedValueOnce(
        new InvalidWebhookSignatureError('signature-sentinel'),
      );
      const signature = await incoming(app);
      expect(signature.statusCode).toBe(400);
      expect(signature.json()).toEqual({ error: 'Invalid webhook signature.' });
      mocks.unwrap.mockRejectedValueOnce(errorPayload());
      const parse = await incoming(app);
      expect(parse.statusCode).toBe(500);
      expect(parse.json()).toEqual({
        error: 'Failed to parse webhook payload.',
      });
      mocks.accept.mockRejectedValueOnce(
        new APIError(
          500,
          { message: 'provider-sentinel' },
          'response-sentinel',
          new Headers(),
        ),
      );
      const accept = await incoming(app);
      expect(accept.statusCode).toBe(500);
      expect(accept.json()).toEqual({ error: 'Failed to accept call.' });
      expect(mocks.sessions).toHaveLength(0);
      mocks.accept.mockRejectedValueOnce(
        new APIError(
          404,
          { message: 'provider-sentinel' },
          'response-sentinel',
          new Headers(),
        ),
      );
      const gone = await incoming(app);
      expect(gone.statusCode).toBe(200);
      expect(gone.json()).toEqual({ ok: true });
      expect(logs).toContainEqual([
        'Call call-test no longer exists when attempting accept. Skipping.',
      ]);
      assertSafeDiagnostics();
    },
  );

  it.each(['listen', 'startup', 'shutdown'] as const)(
    'omits %s exception details and preserves exit status',
    async (failure) => {
      if (failure === 'listen')
        mocks.listen.mockRejectedValueOnce(errorPayload());
      if (failure === 'startup')
        mocks.startup.mockImplementationOnce(() => {
          throw errorPayload();
        });
      const app = await start('1');
      if (failure === 'shutdown') {
        const close = vi
          .spyOn(app, 'close')
          .mockRejectedValueOnce(errorPayload());
        await signals.get('SIGTERM')!();
        close.mockRestore();
      }
      expect(exit).toHaveBeenCalledWith(failure === 'shutdown' ? 0 : 1);
      expect(logs).toContainEqual([
        failure === 'shutdown'
          ? 'Error during shutdown.'
          : 'Failed to start server.',
      ]);
      assertSafeDiagnostics();
    },
  );
});
