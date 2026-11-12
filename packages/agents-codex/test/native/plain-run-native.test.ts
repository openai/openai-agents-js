import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, NativeError, NativeProvider } from '../../src';
import { binding, type JsonObject } from '../../src/runtime/binding';
import { ModelServer, message } from './fixtures/model-server';

function responseFrames(
  index: number,
  chunks = ['answer ', String(index)],
  phase?: 'final_answer',
) {
  const responseId = `plain-response-${index}`;
  const item = {
    ...message(chunks.join('')),
    id: `plain-message-${index}`,
    ...(phase === undefined ? {} : { phase }),
  };
  return [
    { type: 'response.created', response: { id: responseId } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, content: [] },
    },
    ...chunks.map((delta) => ({
      type: 'response.output_text.delta',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta,
    })),
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        status: 'completed',
        usage: {
          input_tokens: 20,
          input_tokens_details: { cached_tokens: 5 },
          output_tokens: 10,
          output_tokens_details: { reasoning_tokens: 3 },
          total_tokens: 30,
        },
      },
    },
  ];
}

function response(
  index: number,
  chunks = ['answer ', String(index)],
  phase?: 'final_answer',
) {
  return {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'x-request-id': `plain-upstream-${index}`,
      'x-ratelimit-remaining-requests': '7',
    },
    body: responseFrames(index, chunks, phase)
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(''),
  };
}

async function providerFor(server: ModelServer, streamMaxRetries = 0) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-plain-run',
    supportsWebsockets: false,
    requestMaxRetries: 0,
    streamMaxRetries,
  });
}

const websocketCleanup: (() => Promise<void>)[] = [];

async function plainWebsocketPeer(
  first?: 'stall' | 'disconnect' | 'connection-limit',
  streamMaxRetries = 0,
) {
  const directory = await mkdtemp(join(tmpdir(), 'agents-plain-wss-'));
  const ca = join(directory, 'ca.pem');
  const caKey = join(directory, 'ca.key');
  const cert = join(directory, 'server.pem');
  const key = join(directory, 'server.key');
  const csr = join(directory, 'server.csr');
  const extensions = join(directory, 'extensions');
  const openssl = (...args: string[]) =>
    execFileSync('openssl', args, { stdio: 'ignore' });
  const peer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  });
  websocketCleanup.push(async () => {
    for (const socket of peer.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      peer.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  });
  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=Plain WSS test CA',
    '-keyout',
    caKey,
    '-out',
    ca,
  );
  openssl(
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=localhost',
    '-keyout',
    key,
    '-out',
    csr,
  );
  await writeFile(
    extensions,
    'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n',
  );
  openssl(
    'x509',
    '-req',
    '-days',
    '1',
    '-in',
    csr,
    '-CA',
    ca,
    '-CAkey',
    caKey,
    '-CAcreateserial',
    '-extfile',
    extensions,
    '-out',
    cert,
  );
  vi.stubEnv('CODEX_CA_CERTIFICATE', ca);
  const server = new ModelServer([], [], undefined, undefined, undefined, {
    key: await readFile(key),
    cert: await readFile(cert),
  });
  const generations: {
    request: JsonObject;
    socket: WebSocket;
    closed: () => Promise<void>;
  }[] = [];
  const warmups: JsonObject[] = [];
  const failures: unknown[] = [];
  const deltaReceived = vi.fn();
  server.onUpgrade((request, socket, head) => {
    peer.handleUpgrade(request, socket, head, (connection) => {
      const closedEvent = new Promise<void>((resolve) =>
        connection.once('close', () => resolve()),
      );
      const closed = async () => {
        await vi.waitFor(
          () => expect(connection.readyState).toBe(WebSocket.CLOSED),
          { timeout: 5000 },
        );
        await closedEvent;
      };
      connection.on('error', (error) => failures.push(error));
      connection.on('message', (data) => {
        try {
          const request = JSON.parse(data.toString()) as JsonObject;
          if (request.generate === false) {
            warmups.push(request);
            connection.send(
              JSON.stringify({
                type: 'response.completed',
                response: { id: `plain-warmup-${warmups.length}` },
              }),
            );
            return;
          }
          generations.push({ request, socket: connection, closed });
          const index = generations.length;
          if (index === 1 && first === 'disconnect') {
            connection.terminate();
            return;
          }
          if (index === 1 && first === 'connection-limit') {
            connection.send(
              JSON.stringify({
                type: 'error',
                status: 400,
                error: {
                  code: 'websocket_connection_limit_reached',
                  message: 'The connection has reached its time limit.',
                },
              }),
            );
            return;
          }
          const frames = responseFrames(index);
          for (const frame of frames) {
            connection.send(JSON.stringify(frame));
            if (
              first === 'stall' &&
              index === 1 &&
              frame.type === 'response.output_text.delta'
            ) {
              // The pong follows the text on the same socket: the native peer
              // has read the actual delta, without claiming a live public observation.
              connection.once('pong', deltaReceived);
              connection.ping('after-text-delta');
              return;
            }
          }
        } catch (error) {
          failures.push(error);
          connection.close(1011);
        }
      });
    });
  });
  const provider = new NativeProvider({
    baseUrl: `https://127.0.0.1:${await server.port()}/v1`,
    apiKey: 'synthetic-plain-wss',
    supportsWebsockets: true,
    requestMaxRetries: 0,
    streamMaxRetries,
  });
  return { provider, server, generations, warmups, failures, deltaReceived };
}

function plainMetadata(
  request: ModelServer['requests'][number],
  startedAt: number,
  finishedAt: number,
) {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  expect(request).toMatchObject({
    model: 'gpt-5',
    reasoning: { effort: 'low' },
  });
  const metadata = request.client_metadata as Record<string, string>;
  expect(metadata).toMatchObject({
    'x-codex-installation-id': expect.stringMatching(uuid),
    session_id: expect.stringMatching(uuid),
    turn_id: expect.stringMatching(uuid),
  });
  expect(metadata.thread_id).toBe(metadata.session_id);
  expect(metadata.root_turn_id).toBe(metadata.turn_id);
  expect(request.prompt_cache_key).toBe(metadata.session_id);
  expect(metadata['x-codex-window-id']).toBe(`${metadata.thread_id}:0`);
  const turnMetadata = JSON.parse(metadata['x-codex-turn-metadata']!) as Record<
    string,
    unknown
  >;
  expect(turnMetadata).toMatchObject({
    installation_id: metadata['x-codex-installation-id'],
    session_id: metadata.session_id,
    thread_id: metadata.thread_id,
    turn_id: metadata.turn_id,
    root_turn_id: metadata.root_turn_id,
    window_id: metadata['x-codex-window-id'],
    window_number: 0,
    context_window_id: expect.stringMatching(uuid),
    request_kind: 'turn',
    agent_name: '/root',
    sandbox: expect.any(String),
    sandbox_mode: 'read-only',
    auto_review_enabled: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    model: 'gpt-5',
    reasoning_effort: 'low',
  });
  if (process.platform === 'linux') {
    expect(turnMetadata.sandbox).toBe('seccomp');
  }
  expect(turnMetadata.context_window_id).not.toBe(metadata.thread_id);
  expect(turnMetadata.context_window_id).not.toBe(metadata.turn_id);
  expect(Number.isSafeInteger(turnMetadata.turn_started_at_unix_ms)).toBe(true);
  expect(turnMetadata.turn_started_at_unix_ms).toBeGreaterThanOrEqual(
    startedAt,
  );
  expect(turnMetadata.turn_started_at_unix_ms).toBeLessThanOrEqual(finishedAt);
  expect(turnMetadata).not.toHaveProperty('analytics_enabled');
  expect(turnMetadata).not.toHaveProperty('workspaces');
  expect(turnMetadata).not.toHaveProperty('tool_namespaces_info');
  expect(metadata).not.toHaveProperty('mcp_attribution');
  return turnMetadata;
}

afterEach(async () => {
  vi.restoreAllMocks();
  try {
    for (const close of websocketCleanup.splice(0).reverse()) await close();
  } finally {
    try {
      await ModelServer.closeAll();
    } finally {
      vi.unstubAllEnvs();
    }
  }
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'plain Agent.run',
  () => {
    it.each([
      ['ASCII whitespace', ' \t\r\n', '', 'final_answer'],
      [
        'Unicode whitespace including NEL',
        '\u0085\u00a0\u1680\u2003\u2028\u2029\u202f\u205f\u3000',
        '',
        'final_answer',
      ],
      ['Unicode whitespace unphased', '\u0085\u2003', '', undefined],
      ['empty final answer', '', '', 'final_answer'],
      [
        'nonblank unphased answer',
        ' \u0085answer\n ',
        ' \u0085answer\n ',
        undefined,
      ],
      [
        'nonblank final answer',
        ' \u0085answer\n ',
        ' \u0085answer\n ',
        'final_answer',
      ],
      ['BOM final answer', '\ufeff', '\ufeff', 'final_answer'],
      [
        'BOM with surrounding whitespace',
        ' \ufeff\n',
        ' \ufeff\n',
        'final_answer',
      ],
      [
        'citation text with original deltas',
        'a<oai-mem-citation>one</oai-mem-citation>b',
        'ab',
        undefined,
      ],
    ] as const)(
      'single-message output parity: %s',
      async (_name, text, expected, phase) => {
        const server = new ModelServer([
          response(1, [text], phase),
          response(2, [text], phase),
        ]);
        await using provider = await providerFor(server);
        const agent = new Agent({
          instructions: 'Answer the request.',
          model: 'gpt-5',
          modelSettings: { reasoningEffort: 'low' },
          provider,
        });
        const native = await binding();
        const run = vi.spyOn(native.Engine.prototype, '_plain_run');
        const open = vi.spyOn(
          native.Engine.prototype,
          'start_replaceable_thread',
        );
        const direct = await agent.run('same input');
        expect(run).toHaveBeenCalledTimes(1);
        expect(open).not.toHaveBeenCalled();

        await using session = await agent.session();
        const ordinary = await (await session.submit('same input')).wait();
        expect(run).toHaveBeenCalledTimes(1);
        expect(open).toHaveBeenCalledTimes(1);
        expect(ordinary.finalOutput).toBe(expected);
        expect(direct.finalOutput).toBe(ordinary.finalOutput);
        const observations = await Array.fromAsync(direct.turn.events());
        expect(
          observations
            .filter((event) => event.type === 'output_text_delta')
            .map((event) => event.delta)
            .join(''),
        ).toBe(text);
        expect(server.requests).toHaveLength(2);
        server.assertExhausted();
      },
      30_000,
    );

    it.each([
      [
        'unphased blank tail',
        [message('kept answer'), message('\u0085\u2003')],
        'kept answer',
      ],
      [
        'unphased empty tail',
        [message('kept answer'), message('')],
        'kept answer',
      ],
      [
        'explicit blank final tail',
        [
          message('kept answer'),
          { ...message('\u0085\u2003'), phase: 'final_answer' },
        ],
        '',
      ],
      [
        'citation text',
        [message('a<oai-mem-citation>one</oai-mem-citation>b')],
        'ab',
      ],
      [
        'citation-only tail',
        [
          message('kept answer'),
          message('<oai-mem-citation>one</oai-mem-citation>'),
        ],
        'kept answer',
      ],
      [
        'citation only',
        [message('<oai-mem-citation>one</oai-mem-citation>')],
        '',
      ],
      [
        'commentary tail',
        [
          message('kept answer'),
          { ...message('later commentary'), phase: 'commentary' },
        ],
        'later commentary',
      ],
      [
        'commentary only',
        [{ ...message('commentary'), phase: 'commentary' }],
        'commentary',
      ],
      [
        'blank final then citation-only',
        [
          message('kept answer'),
          { ...message('\u0085\u2003'), phase: 'final_answer' },
          message('<oai-mem-citation>one</oai-mem-citation>'),
        ],
        'kept answer',
      ],
      [
        'blank final then empty content',
        [
          message('kept answer'),
          { ...message('\u0085\u2003'), phase: 'final_answer' },
          { ...message(''), content: [] },
          message(''),
        ],
        'kept answer',
      ],
      [
        'blank final then empty text',
        [
          message('kept answer'),
          { ...message('\u0085\u2003'), phase: 'final_answer' },
          message(''),
        ],
        '',
      ],
      [
        'mixed text parts',
        [
          {
            ...message(''),
            content: [
              { type: 'input_text', text: 'one' },
              { type: 'output_text', text: 'two' },
            ],
          },
        ],
        'onetwo',
      ],
      [
        'citation split between content parts',
        [
          {
            ...message(''),
            content: [
              { type: 'input_text', text: 'a<oai-mem-' },
              {
                type: 'output_text',
                text: 'citation>one</oai-mem-citation>b',
              },
            ],
          },
        ],
        'ab',
      ],
      [
        'empty content followed by empty text',
        [{ ...message(''), content: [] }, message('')],
        '',
      ],
      [
        'literal proposed plan outside plan mode',
        [message('a<proposed_plan>one</proposed_plan>b')],
        'a<proposed_plan>one</proposed_plan>b',
      ],
      ['BOM tail', [message('earlier answer'), message('\ufeff')], '\ufeff'],
    ] as [string, JsonObject[], string][])(
      'visible-output parity: %s',
      async (_name, items, expected) => {
        const server = new ModelServer([items, items]);
        await using provider = await providerFor(server);
        const agent = new Agent({
          instructions: 'Answer the request.',
          model: 'gpt-5',
          modelSettings: { reasoningEffort: 'low' },
          provider,
        });
        const native = await binding();
        const run = vi.spyOn(native.Engine.prototype, '_plain_run');
        const open = vi.spyOn(
          native.Engine.prototype,
          'start_replaceable_thread',
        );
        const direct = await agent.run('same input');
        expect(run).toHaveBeenCalledTimes(1);
        expect(open).not.toHaveBeenCalled();

        await using session = await agent.session();
        const ordinary = await (await session.submit('same input')).wait();
        expect(run).toHaveBeenCalledTimes(1);
        expect(open).toHaveBeenCalledTimes(1);
        expect(ordinary.finalOutput).toBe(expected);
        expect(direct.finalOutput).toBe(ordinary.finalOutput);
        expect(server.requests).toHaveLength(2);
        server.assertExhausted();
      },
      30_000,
    );

    it('preserves buffered response mode for a plain public run', async () => {
      const server = new ModelServer([
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: 'plain-buffered-response',
            object: 'response',
            status: 'completed',
            model: 'gpt-5',
            output: [message('buffered answer')],
            usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
          }),
        },
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-plain-buffered-run',
        supportsWebsockets: false,
        responseMode: 'buffered',
        requestMaxRetries: 0,
        streamMaxRetries: 0,
      });
      const agent = new Agent({
        instructions: 'Answer the request.',
        model: 'gpt-5',
        modelSettings: { reasoningEffort: 'low' },
        provider,
      });

      expect((await agent.run('buffered input')).finalOutput).toBe(
        'buffered answer',
      );
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]).toHaveProperty('stream', false);
      expect(server.requests[0]).not.toHaveProperty('stream_options');
    });

    it('preserves the public result and ordered observations without opening a native thread', async () => {
      const server = new ModelServer([response(1), response(2)]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        instructions: 'Follow the application instructions.',
        model: 'gpt-5',
        modelSettings: { reasoningEffort: 'low' },
        provider,
      });
      const native = await binding();
      const run = vi.spyOn(native.Engine.prototype, '_plain_run');
      const open = vi.spyOn(
        native.Engine.prototype,
        'start_replaceable_thread',
      );
      const firstStartedAt = Date.now();
      const first = await agent.run('first input');
      const firstFinishedAt = Date.now();
      agent.instructions = 'Updated application instructions.';
      const secondStartedAt = Date.now();
      const second = await agent.run('second input');
      const secondFinishedAt = Date.now();

      expect([first.finalOutput, second.finalOutput]).toEqual([
        'answer 1',
        'answer 2',
      ]);
      expect(run).toHaveBeenCalledTimes(2);
      expect(open).not.toHaveBeenCalled();
      expect(first.turn.sessionId).not.toBe(second.turn.sessionId);
      expect(first.turn.turnId).not.toBe(second.turn.turnId);
      expect(first.turn.submissionId).not.toBe(second.turn.submissionId);
      const firstMetadata = plainMetadata(
        server.requests[0]!,
        firstStartedAt,
        firstFinishedAt,
      );
      const secondMetadata = plainMetadata(
        server.requests[1]!,
        secondStartedAt,
        secondFinishedAt,
      );
      expect(firstMetadata).toMatchObject({
        session_id: first.turn.sessionId,
        turn_id: first.turn.turnId,
      });
      expect(secondMetadata).toMatchObject({
        session_id: second.turn.sessionId,
        turn_id: second.turn.turnId,
      });
      expect(secondMetadata.context_window_id).not.toBe(
        firstMetadata.context_window_id,
      );
      expect(await first.turn.wait()).toBe(first);
      const aborted = AbortSignal.abort(new Error('only this late waiter'));
      expect(
        await first.turn.wait({ until: 'interaction', signal: aborted }),
      ).toBe(first);
      await expect(first.turn.cancel()).resolves.toBeUndefined();
      await expect(first.turn.steer('late input')).rejects.toBeInstanceOf(
        NativeError,
      );
      expect(first.repairAttempts).toEqual([]);
      expect(first.threadUsage?.totalTokenUsage).toEqual({
        inputTokens: 20,
        cachedInputTokens: 5,
        cacheWriteInputTokens: 0,
        outputTokens: 10,
        reasoningOutputTokens: 3,
        totalTokens: 30,
      });
      expect(first.threadUsage?.lastTokenUsage).toEqual(
        first.threadUsage?.totalTokenUsage,
      );

      const events = await Array.fromAsync(first.turn.events());
      expect(await Array.fromAsync(first.turn.events())).toEqual(events);
      const dispatch = events.find(
        (event) => event.type === 'model_request_dispatching',
      );
      expect(dispatch).toMatchObject({
        sessionId: first.turn.sessionId,
        turnId: first.turn.turnId,
        submissionId: first.turn.submissionId,
        model: 'gpt-5',
        reasoningEffort: 'low',
        wire: 'responses',
        transport: 'http_sse',
      });
      expect(
        events
          .filter((event) => event.type === 'output_text_delta')
          .map((event) => event.delta),
      ).toEqual(['answer ', '1']);
      expect(
        events
          .filter((event) => event.type === 'output_text_delta')
          .every((event) => event.itemId === 'plain-message-1'),
      ).toBe(true);
      expect(
        events.find((event) => event.type === 'api_rate_limits_updated'),
      ).toMatchObject({
        snapshot: { requests: { remaining: 7 } },
      });
      const types = events.map((event) => event.type);
      expect(types.indexOf('model_request_dispatching')).toBeLessThan(
        types.indexOf('output_text_delta'),
      );
      expect(types.indexOf('usage_updated')).toBeLessThan(
        types.indexOf('turn_finished'),
      );
      expect(
        events.find((event) => event.type === 'turn_finished'),
      ).toMatchObject({ status: 'completed' });
      expect(events.every(Object.isFrozen)).toBe(true);

      const firstRequest = JSON.stringify(server.requests[0]);
      const secondRequest = JSON.stringify(server.requests[1]);
      expect(firstRequest).toContain('Follow the application instructions.');
      expect(secondRequest).toContain('Updated application instructions.');
      expect(secondRequest).toContain('second input');
      expect(secondRequest).not.toContain('first input');
      expect(secondRequest).not.toContain('answer 1');
      expect(
        server.requests.every(
          (request) =>
            Array.isArray(request.tools) && request.tools.length === 0,
        ),
      ).toBe(true);
      expect(
        server.requestHeaders.map((headers) => headers.authorization),
      ).toEqual(['Bearer synthetic-plain-run', 'Bearer synthetic-plain-run']);
      server.assertExhausted();
    }, 30_000);

    it.each(['all', 'bounded'] as const)(
      'applies %s observation retention for independent late readers',
      async (retention) => {
        const chunks = Array.from({ length: 350 }, (_, index) => `${index},`);
        const server = new ModelServer([response(1, chunks)]);
        await using provider = await providerFor(server);
        const completed = await new Agent({
          instructions: 'Answer.',
          model: 'gpt-5',
          provider,
        }).run('start', { observationRetention: retention });
        const first = await Array.fromAsync(completed.turn.events());
        const second = await Array.fromAsync(completed.turn.events());
        expect(first).toEqual(second);
        const deltas = first
          .filter((event) => event.type === 'output_text_delta')
          .map((event) => event.delta);
        if (retention === 'all') {
          expect(first.some((event) => event.type === 'gap')).toBe(false);
          expect(deltas).toEqual(chunks);
        } else {
          expect(first[0]?.type).toBe('gap');
          expect(first.length).toBeLessThanOrEqual(257);
          expect(deltas.length).toBeGreaterThan(0);
          expect(deltas).toEqual(chunks.slice(-deltas.length));
        }
        expect(completed.finalOutput).toBe(chunks.join(''));
        server.assertExhausted();
      },
      30_000,
    );

    it('preserves exact token counts beyond JavaScript safe integers', async () => {
      const reply = response(1);
      reply.body = reply.body
        .replace('"input_tokens":20', '"input_tokens":9007199254740993')
        .replace('"total_tokens":30', '"total_tokens":9007199254741003');
      const server = new ModelServer([reply]);
      await using provider = await providerFor(server);
      const completed = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      }).run('start');
      expect(completed.threadUsage?.totalTokenUsage.inputTokens).toBe(
        9_007_199_254_740_993n,
      );
      expect(completed.threadUsage?.totalTokenUsage.totalTokens).toBe(
        9_007_199_254_741_003n,
      );
      expect(completed.threadUsage?.lastTokenUsage).toEqual(
        completed.threadUsage?.totalTokenUsage,
      );
      server.assertExhausted();
    }, 30_000);

    it('preserves HTTP error metadata after native authentication recovery', async () => {
      const rejection = {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'plain-rejected-request',
        },
        body: JSON.stringify({
          error: {
            message: 'Synthetic rejection',
            code: 'invalid_api_key',
            type: 'invalid_request_error',
          },
        }),
      };
      const server = new ModelServer([rejection, rejection]);
      await using provider = await providerFor(server);
      const native = await binding();
      const run = vi.spyOn(native.Engine.prototype, '_plain_run');
      const open = vi.spyOn(
        native.Engine.prototype,
        'start_replaceable_thread',
      );
      const failure: unknown = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      })
        .run('start')
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(NativeError);
      expect(failure).toMatchObject({
        statusCode: 401,
        code: 'invalid_api_key',
        requestId: 'plain-rejected-request',
      });
      expect(failure).not.toHaveProperty('body');
      expect(failure).not.toHaveProperty('headers');
      expect(run).toHaveBeenCalledTimes(1);
      expect(open).not.toHaveBeenCalled();
      expect(server.requests).toHaveLength(2);
      server.assertExhausted();
    }, 30_000);

    it.each([
      ['missing assistant output', []],
      ['empty assistant content', [{ ...message(''), content: [] }]],
    ] as [string, JsonObject[]][])(
      'preserves response-integrity failures without a second model request: %s',
      async (_name, items) => {
        const server = new ModelServer([items]);
        await using provider = await providerFor(server, 1);
        const failure: unknown = await new Agent({
          instructions: 'Answer.',
          model: 'gpt-5',
          provider,
        })
          .run('start')
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(NativeError);
        expect(failure).toMatchObject({
          responseIntegrityReason: 'missing_supported_terminal_output',
        });
        server.assertExhausted();
      },
      30_000,
    );

    it('reuses native guidance when retrying a content-filter response', async () => {
      const terminal = JSON.stringify({
        type: 'response.incomplete',
        response: {
          id: 'response-1',
          incomplete_details: { reason: 'content_filter' },
          usage: { input_tokens: 7, output_tokens: 0, total_tokens: 7 },
        },
      });
      const server = new ModelServer([[], response(2)], [], undefined, [
        terminal,
      ]);
      await using provider = await providerFor(server, 1);
      const startedAt = Date.now();
      const completed = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        modelSettings: { reasoningEffort: 'low' },
        provider,
      }).run('start');
      const finishedAt = Date.now();
      expect(completed.finalOutput).toBe('answer 2');
      expect(server.requests).toHaveLength(2);
      const firstMetadata = plainMetadata(
        server.requests[0]!,
        startedAt,
        finishedAt,
      );
      const retriedMetadata = plainMetadata(
        server.requests[1]!,
        startedAt,
        finishedAt,
      );
      expect(retriedMetadata).toEqual(firstMetadata);
      expect(server.requests[1]!.client_metadata).toEqual(
        server.requests[0]!.client_metadata,
      );
      expect(firstMetadata).toMatchObject({
        session_id: completed.turn.sessionId,
        turn_id: completed.turn.turnId,
      });
      const originalInput = server.requests[0]!.input as unknown[];
      const recoveredInput = server.requests[1]!.input as unknown[];
      expect(recoveredInput.slice(0, originalInput.length)).toEqual(
        originalInput,
      );
      expect(recoveredInput).toHaveLength(originalInput.length + 1);
      expect(recoveredInput.at(-1)).toMatchObject({ role: 'developer' });
      expect(JSON.stringify(recoveredInput.at(-1))).toContain(
        '<content_filter_guidance>',
      );
      server.assertExhausted();
    }, 30_000);

    it('reports a provider refusal without exposing its private text', async () => {
      const refusal = 'synthetic-private-refusal';
      const events = [
        {
          type: 'response.created',
          response: { id: 'plain-refused-response' },
        },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'message',
            id: 'plain-refusal',
            role: 'assistant',
            content: [],
          },
        },
        {
          type: 'response.refusal.delta',
          item_id: 'plain-refusal',
          content_index: 0,
          delta: refusal,
        },
        {
          type: 'response.refusal.done',
          item_id: 'plain-refusal',
          content_index: 0,
          refusal,
        },
      ];
      const server = new ModelServer([
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: events
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(''),
        },
      ]);
      await using provider = await providerFor(server, 1);
      const failure: unknown = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      })
        .run('start')
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(NativeError);
      expect(failure).toMatchObject({
        responseIntegrityReason: 'provider_refusal',
      });
      expect(String(failure)).not.toContain(refusal);
      server.assertExhausted();
    }, 30_000);

    it('uses plain public WSS runs with independent inputs and retains callback fallback', async () => {
      const peer = await plainWebsocketPeer();
      await using provider = peer.provider;
      const agent = new Agent({
        instructions: 'Answer the request.',
        model: 'gpt-5',
        modelSettings: { reasoningEffort: 'low' },
        provider,
      });
      const native = await binding();
      const plain = vi.spyOn(native.Engine.prototype, '_plain_run');
      const open = vi.spyOn(
        native.Engine.prototype,
        'start_replaceable_thread',
      );
      const reuse = vi.spyOn(native.Engine.prototype, '_private_start_thread');
      const first = await agent.run('first independent question');
      const second = await agent.run('second independent question');
      expect([first.finalOutput, second.finalOutput]).toEqual([
        'answer 1',
        'answer 2',
      ]);
      expect(plain).toHaveBeenCalledTimes(2);
      expect(open).not.toHaveBeenCalled();
      expect(reuse).not.toHaveBeenCalled();
      expect(peer.generations).toHaveLength(2);
      for (const [index, generation] of peer.generations.entries()) {
        const wire = JSON.stringify(generation.request.input);
        expect(wire).toContain(
          index === 0
            ? 'first independent question'
            : 'second independent question',
        );
        expect(wire).not.toContain(
          index === 0
            ? 'second independent question'
            : 'first independent question',
        );
        expect(generation.request.previous_response_id ?? null).toBeNull();
        expect(generation.request.type).toBe('response.create');
        expect(JSON.stringify(generation.request)).toContain(
          'Answer the request.',
        );
        await generation.closed();
      }
      expect(first.turn.turnId).not.toBe(second.turn.turnId);
      expect(first.runUsage).toMatchObject({
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        requests: 1,
      });
      expect(second.runUsage).toEqual(first.runUsage);
      const beforeComplete = vi.fn();
      agent.beforeComplete = beforeComplete;
      expect((await agent.run('callback question')).finalOutput).toBe(
        'answer 3',
      );
      expect(beforeComplete).toHaveBeenCalledTimes(1);
      expect(plain).toHaveBeenCalledTimes(2);
      expect(open.mock.calls.length + reuse.mock.calls.length).toBeGreaterThan(
        0,
      );
      expect(peer.generations).toHaveLength(3);
      await peer.generations[2]!.closed();
      expect(peer.server.requests).toHaveLength(0);
      expect(peer.failures).toEqual([]);
      peer.server.assertExhausted();
    }, 30_000);

    it('joins WSS cancellation after a received delta before same-Provider recovery', async () => {
      const peer = await plainWebsocketPeer('stall');
      await using provider = peer.provider;
      const agent = new Agent({
        instructions: 'Answer the request.',
        model: 'gpt-5',
        provider,
      });
      const native = await binding();
      const plain = vi.spyOn(native.Engine.prototype, '_plain_run');
      const open = vi.spyOn(
        native.Engine.prototype,
        'start_replaceable_thread',
      );
      const reuse = vi.spyOn(native.Engine.prototype, '_private_start_thread');
      const controller = new AbortController();
      const reason = new Error('cancel after WSS text delta');
      const running = agent.run('cancel this question', {
        signal: controller.signal,
      });
      void running.catch(() => undefined);
      try {
        await vi.waitFor(
          () => expect(peer.deltaReceived).toHaveBeenCalledTimes(1),
          { timeout: 10_000 },
        );
        expect(peer.generations).toHaveLength(1);
        controller.abort(reason);
        await expect(running).rejects.toBe(reason);
        await peer.generations[0]!.closed();
      } finally {
        controller.abort(reason);
        await running.catch(() => undefined);
      }
      expect(
        (await agent.run('recover with a fresh question')).finalOutput,
      ).toBe('answer 2');
      expect(plain).toHaveBeenCalledTimes(2);
      expect(open).not.toHaveBeenCalled();
      expect(reuse).not.toHaveBeenCalled();
      expect(peer.generations).toHaveLength(2);
      expect(
        peer.generations[1]!.request.previous_response_id ?? null,
      ).toBeNull();
      const recoveryInput = JSON.stringify(peer.generations[1]!.request.input);
      expect(recoveryInput).toContain('recover with a fresh question');
      expect(recoveryInput).not.toContain('cancel this question');
      await peer.generations[1]!.closed();
      expect(peer.server.requests).toHaveLength(0);
      expect(peer.failures).toEqual([]);
      peer.server.assertExhausted();
    }, 30_000);

    it('does not replay a one-shot WSS request after the peer receives it', async () => {
      const peer = await plainWebsocketPeer('disconnect', 1);
      await using provider = peer.provider;
      const agent = new Agent({
        instructions: 'Answer the request.',
        model: 'gpt-5',
        provider,
      });
      const native = await binding();
      const plain = vi.spyOn(native.Engine.prototype, '_plain_run');
      await expect(agent.run('Do this once.')).rejects.toMatchObject({
        message:
          'Native WebSocket request outcome is unknown after a send or disconnect; it will not be replayed.',
        category: 'internal_error',
        retryable: false,
      });
      expect(plain).toHaveBeenCalledTimes(1);
      expect(peer.generations).toHaveLength(1);
      await peer.generations[0]!.closed();
      expect(peer.server.requests).toHaveLength(0);
      expect(peer.failures).toEqual([]);
      peer.server.assertExhausted();
    }, 30_000);

    it('retries an explicit one-shot WSS connection-limit rejection', async () => {
      const peer = await plainWebsocketPeer('connection-limit', 1);
      await using provider = peer.provider;
      const agent = new Agent({
        instructions: 'Answer the request.',
        model: 'gpt-5',
        provider,
      });
      const native = await binding();
      const plain = vi.spyOn(native.Engine.prototype, '_plain_run');
      expect(
        (await agent.run('Answer on a fresh connection.')).finalOutput,
      ).toBe('answer 2');
      expect(plain).toHaveBeenCalledTimes(1);
      expect(peer.generations).toHaveLength(2);
      expect(peer.generations[0]!.socket).not.toBe(peer.generations[1]!.socket);
      for (const generation of peer.generations) await generation.closed();
      expect(peer.server.requests).toHaveLength(0);
      expect(peer.failures).toEqual([]);
      peer.server.assertExhausted();
    }, 30_000);

    it('joins cancellation and keeps the Provider usable for a later run', async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const server = new ModelServer(
        [response(1), response(2)],
        [],
        undefined,
        undefined,
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
      await using provider = await providerFor(server);
      const agent = new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      });
      const controller = new AbortController();
      const reason = new Error('caller cancellation');
      const running = agent.run('cancel me', { signal: controller.signal });
      void running.catch(() => undefined);
      try {
        await entered.promise;
        controller.abort(reason);
        await expect(running).rejects.toBe(reason);
      } finally {
        release.resolve();
      }
      expect((await agent.run('after cancellation')).finalOutput).toBe(
        'answer 2',
      );
      server.assertExhausted();
    }, 30_000);

    it('preserves the prompt when reusing the owner after native preflight declines', async () => {
      const server = new ModelServer([response(1), response(2)]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        modelSettings: { reasoningEffort: 'low' },
        provider,
      });
      const preflight = vi
        .spyOn((await binding()).Engine.prototype, '_plain_run_supported')
        .mockResolvedValue(false);
      expect((await agent.run('same input')).finalOutput).toBe('answer 1');
      preflight.mockRestore();
      expect((await agent.run('same input')).finalOutput).toBe('answer 2');
      const prompt = (request: (typeof server.requests)[number]) =>
        JSON.stringify(
          {
            model: request.model,
            reasoning: request.reasoning,
            instructions: request.instructions,
            input: request.input,
            tools: request.tools,
            tool_choice: request.tool_choice,
          },
          // Per-run message identities; all roles, content and context retained.
          (key, value) => (key === 'id' ? undefined : value),
        ).replace(
          /msg_sdk_application_[A-Za-z0-9_-]+/g,
          'APPLICATION_REVISION',
        );
      expect(JSON.parse(prompt(server.requests[1]!))).toEqual(
        JSON.parse(prompt(server.requests[0]!)),
      );
      server.assertExhausted();
    }, 30_000);

    it.each([
      [undefined, false, false],
      [0, false, false],
      [1, false, false],
      [1, true, false],
      [1, true, true],
    ] as const)(
      'preserves dropped-stream recovery with retry budget %s, completed item %s and blank success %s',
      async (streamMaxRetries, completedItem, blankSuccess) => {
        const finalChunks = blankSuccess ? ['\u0085\u2003'] : ['answer ', '2'];
        const dropped = {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: [
            {
              type: 'response.created',
              response: { id: 'dropped-response' },
            },
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: {
                type: 'message',
                id: 'dropped-message',
                role: 'assistant',
                content: [],
              },
            },
            {
              type: 'response.output_text.delta',
              item_id: 'dropped-message',
              output_index: 0,
              content_index: 0,
              delta: 'partial output',
            },
            ...(completedItem
              ? [
                  {
                    type: 'response.output_item.done',
                    output_index: 0,
                    item: {
                      ...message('partial output'),
                      id: 'dropped-message',
                    },
                  },
                ]
              : []),
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(''),
        };
        const server = new ModelServer([
          dropped,
          ...(streamMaxRetries === 0 ? [] : [response(2, finalChunks)]),
        ]);
        const config = await server.config();
        await using provider = new NativeProvider({
          baseUrl: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'synthetic-plain-retry',
          supportsWebsockets: false,
          requestMaxRetries: 0,
          streamMaxRetries,
        });
        const agent = new Agent({
          instructions: 'Answer.',
          model: 'gpt-5',
          provider,
        });
        const running = agent.run('recover the response');
        if (streamMaxRetries === 0) {
          await expect(running).rejects.toBeInstanceOf(NativeError);
        } else {
          const completed = await running;
          expect(completed.finalOutput).toBe(blankSuccess ? '' : 'answer 2');
          const originalInput = server.requests[0]!.input as unknown[];
          const recoveredInput = server.requests[1]!.input as unknown[];
          expect(recoveredInput.slice(0, originalInput.length)).toEqual(
            originalInput,
          );
          expect(recoveredInput).toHaveLength(
            originalInput.length + (completedItem ? 1 : 0),
          );
          if (completedItem) {
            expect(recoveredInput.at(-1)).toMatchObject({ role: 'assistant' });
            expect(JSON.stringify(recoveredInput.at(-1))).toContain(
              'partial output',
            );
          }
          const observations = await Array.fromAsync(completed.turn.events());
          expect(
            observations
              .filter((event) => event.type === 'output_text_delta')
              .map((event) => event.delta),
          ).toEqual(['partial output', ...finalChunks]);
          const dispatched = observations.filter(
            (event) => event.type === 'model_request_dispatching',
          );
          expect(dispatched).toHaveLength(2);
          expect(new Set(dispatched.map((event) => event.requestId)).size).toBe(
            2,
          );
        }
        expect(server.requests).toHaveLength(streamMaxRetries === 0 ? 1 : 2);
        server.assertExhausted();
      },
      30_000,
    );

    it('matches ordinary model defaults after a different Agent uses the Provider', async () => {
      const server = new ModelServer([response(1), response(2), response(3)]);
      await using provider = await providerFor(server);
      await new Agent({
        instructions: 'First agent.',
        model: 'gpt-5',
        provider,
      }).run('first');
      const agent = new Agent({ instructions: 'Default model.', provider });
      expect((await agent.run('default model')).finalOutput).toBe('answer 2');
      vi.spyOn(
        (await binding()).Engine.prototype,
        '_plain_run_supported',
      ).mockResolvedValue(false);
      expect((await agent.run('ordinary default model')).finalOutput).toBe(
        'answer 3',
      );
      expect(server.requests[1]?.model).toBe(server.requests[2]?.model);
      server.assertExhausted();
    }, 30_000);

    it('uses ordinary Sessions for callbacks, invocation deadlines and explicit Sessions', async () => {
      const server = new ModelServer([response(1), response(2), response(3)]);
      await using provider = await providerFor(server);
      const beforeComplete = vi.fn();
      const agent = new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
        beforeComplete,
      });
      const run = vi.spyOn((await binding()).Engine.prototype, '_plain_run');
      expect((await agent.run('callback')).finalOutput).toBe('answer 1');
      expect(beforeComplete).toHaveBeenCalledTimes(1);
      agent.beforeComplete = undefined;
      expect(
        (
          await agent.run('deadline', {
            modelSettings: { invocationTimeoutMs: 10_000 },
          })
        ).finalOutput,
      ).toBe('answer 2');
      await using session = await agent.session();
      expect(
        (await (await session.submit('explicit session')).wait()).finalOutput,
      ).toBe('answer 3');
      expect(run).not.toHaveBeenCalled();
      server.assertExhausted();
    }, 30_000);
  },
);
