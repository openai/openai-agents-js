import { once } from 'node:events';
import { IncomingMessage, Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { expect, it, vi } from 'vitest';
import { NativeProvider } from '../../src/runtime/provider';
import {
  customToolCall,
  httpError,
  text,
  toolCall,
  withScriptedResponses,
  type ScriptedResponses,
  type ScriptedResponse,
} from '../../src/testing';

const post = (peer: ScriptedResponses, body: unknown = {}) =>
  fetch(`${peer.provider.baseUrl}/responses`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'x-synthetic-secret': 'header-only-marker' },
  });

it('emits namespaced functions and raw custom calls without changing ordinary function calls', async () => {
  const input = 'const result = await tools.lookup({ sku: "PAPER" });\nresult;';
  const options = { callId: 'lookup', namespace: 'mcp__catalog' };
  const namespaced = toolCall('lookup', { sku: 'PAPER' }, options);
  options.namespace = 'changed';
  await withScriptedResponses(
    [
      [
        toolCall('lookup', { sku: 'PAPER' }, { callId: 'plain' }),
        namespaced,
        customToolCall('exec', input, { callId: 'aggregate' }),
      ],
    ],
    async (peer) => {
      const wire = await (await post(peer)).text();
      const events = wire
        .trim()
        .split('\n\n')
        .map((part) => JSON.parse(part.slice(6)));
      expect(
        events
          .filter((event) => event.type === 'response.output_item.done')
          .map((event) => event.item),
      ).toEqual([
        {
          type: 'function_call',
          name: 'lookup',
          call_id: 'plain',
          arguments: '{"sku":"PAPER"}',
        },
        {
          type: 'function_call',
          name: 'lookup',
          namespace: 'mcp__catalog',
          call_id: 'lookup',
          arguments: '{"sku":"PAPER"}',
        },
        {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'aggregate',
          input,
        },
      ]);
    },
  );
});

it.each([
  { type: 'custom_tool_call', name: 'exec', call_id: 'call', input: {} },
  { type: 'custom_tool_call', name: 'exec', call_id: 'call', input: [] },
  {
    type: 'function_call',
    name: 'lookup',
    call_id: 'call',
    arguments: '{}',
    namespace: 42,
  },
  { type: 'unknown', name: 'exec', call_id: 'call', input: 'raw' },
  { type: 42, name: 'exec', call_id: 'call', input: 'raw' },
  {
    type: 'custom_tool_call',
    name: 'exec',
    call_id: 'call',
    input: 'raw',
    namespace: 'unsupported',
  },
  {
    type: 'function_call',
    name: 'lookup',
    call_id: 'call',
    arguments: '{}',
    namespace: 'mcp__catalog',
    extra: true,
  },
])('rejects malformed tool items before admission: %j', async (item) => {
  const callback = vi.fn();
  const listen = vi.spyOn(Server.prototype, 'listen');
  try {
    // Parse untyped JSON to exercise the public runtime validation boundary.
    const result = withScriptedResponses(
      JSON.parse(JSON.stringify([[item]])),
      callback,
    );
    await expect(result).rejects.toBeInstanceOf(TypeError);
    await expect(result).rejects.toThrow(
      'Invalid scripted response at index 0',
    );
    expect(listen).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  } finally {
    listen.mockRestore();
  }
});

it.each(['function_call_output', 'custom_tool_call_output'])(
  'reads newest string and rich text outputs across both kinds: %s',
  async (type) => {
    await withScriptedResponses([[], []], async (peer) => {
      const otherType =
        type === 'function_call_output'
          ? 'custom_tool_call_output'
          : 'function_call_output';
      await (
        await post(peer, {
          input: [{ type: otherType, call_id: 'call', output: 'first' }],
        })
      ).text();
      expect(peer.toolOutput('call')).toBe('first');
      await (
        await post(peer, {
          input: [
            { type: otherType, call_id: 'call', output: 'older' },
            { type, call_id: 'string', output: 'raw string' },
            {
              type,
              call_id: 'call',
              output: [
                { type: 'text', text: 'new' },
                { type: 'image', image_url: 'synthetic-image' },
                { type: 'text', text: 'est' },
              ],
            },
            { type, call_id: 'other', output: 'unrelated' },
            { type: 'message', call_id: 'call', output: 'ignored' },
          ],
        })
      ).text();
      expect(peer.toolOutput('call')).toBe('newest');
      expect(peer.toolOutput('string')).toBe('raw string');
      expect(peer.toolOutput('unknown')).toBeUndefined();
      Reflect.set(peer.requests[1], 'input', []);
      expect(peer.toolOutput('call')).toBe('newest');
    });
  },
);

it('captures scripts before yielding and provides detached, body-only readback', async () => {
  const args = { key: 'first' };
  const call = toolCall('lookup', args, { callId: 'call-1' });
  args.key = 'later';
  const script: ScriptedResponse[] = [[call, text('done')]];
  let retained!: ScriptedResponses;
  const scope = withScriptedResponses(script, async (peer) => {
    retained = peer;
    const result = await post(peer, {
      input: [
        { type: 'function_call_output', call_id: 'call-1', output: 'old' },
        {
          type: 'function_call_output',
          call_id: 'call-1',
          output: [
            { type: 'text', text: 'new' },
            { type: 'text', text: 'est' },
          ],
        },
      ],
    });
    const wire = await result.text();
    expect(wire).toContain('first');
    expect(wire).not.toContain('later');
    const events = wire
      .trim()
      .split('\n\n')
      .map((part) => JSON.parse(part.slice(6)));
    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.output_item.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events[0].response.id).toBe(events[3].response.id);
    const snapshot = peer.requests;
    (snapshot[0].input as unknown[]).length = 0;
    expect(peer.toolOutput('call-1')).toBe('newest');
    expect(peer.toolOutput('unknown')).toBeUndefined();
    expect(JSON.stringify(peer.requests)).not.toContain('header-only-marker');
    return 42;
  });
  script.length = 0;
  expect(await scope).toBe(42);
  expect(retained.requests).toHaveLength(1);
  retained.assertExhausted();
  expect(() => retained.provider).toThrow('scope has ended');
});

it('captures HTTP errors and validates scripts before invoking the callback', async () => {
  const body = { error: { message: 'synthetic' } };
  const error = httpError(400, body);
  body.error.message = 'changed';
  await withScriptedResponses([error], async (peer) => {
    const response = await post(peer);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { message: 'synthetic' } });
  });
  const callback = vi.fn();
  await expect(
    withScriptedResponses([[{ type: 'unsupported' }] as never], callback),
  ).rejects.toThrow('index 0');
  expect(callback).not.toHaveBeenCalled();
  expect(() => httpError(200)).toThrow('status or JSON body');
  expect(() => httpError(400, { value: Infinity })).toThrow(
    'status or JSON body',
  );
});

it.each([0, 1])(
  'rejects a missing script at index %i before starting the listener or callback',
  async (missingIndex) => {
    const responses = new Array<ScriptedResponse>(missingIndex + 1);
    if (missingIndex > 0) responses[0] = [text('valid first step')];
    const callback = vi.fn();
    const listen = vi.spyOn(Server.prototype, 'listen');
    try {
      const result = withScriptedResponses(responses, callback);
      await expect(result).rejects.toBeInstanceOf(TypeError);
      await expect(result).rejects.toThrow(
        `Invalid scripted response at index ${missingIndex}`,
      );
      expect(listen).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();
    } finally {
      listen.mockRestore();
    }
  },
);

it('rejects non-array scripts before starting the listener or callback', async () => {
  const callback = vi.fn();
  const listen = vi.spyOn(Server.prototype, 'listen');
  try {
    const result = withScriptedResponses({} as never, callback);
    await expect(result).rejects.toBeInstanceOf(TypeError);
    expect(listen).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  } finally {
    listen.mockRestore();
  }
});

it('rejects invalid traffic without consuming the next step and records overflow bodies', async () => {
  let retained!: ScriptedResponses;
  await expect(
    withScriptedResponses([[text('kept')]], async (peer) => {
      retained = peer;
      for (const [path, method, body] of [
        ['/wrong', 'POST', '{}'],
        ['/responses', 'GET', undefined],
        ['/responses', 'POST', '{'],
        ['/responses', 'POST', '[]'],
      ] as const) {
        expect(
          (await fetch(`${peer.provider.baseUrl}${path}`, { method, body }))
            .status,
        ).toBe(400);
      }
      expect(await (await post(peer)).text()).toContain('kept');
      expect((await post(peer, { overflow: true })).status).toBe(400);
    }),
  ).rejects.toThrow('0 remaining, 5 unexpected requests, 0 internal failures');
  expect(retained.requests).toEqual([{}, { overflow: true }]);
  expect(() => retained.assertExhausted()).toThrow('5 unexpected');
});

it.each([undefined, null, false, 0, '', new Error('original')])(
  'preserves exact callback errors: %s',
  async (original) => {
    await withScriptedResponses([[text('unused')]], () => {
      throw original;
    }).then(
      () => {
        throw new Error('unexpected success');
      },
      (error) => expect(error).toBe(original),
    );
  },
);

it('aggregates a real provider close error with the original callback value', async () => {
  const cleanup = new Error('controlled cleanup');
  const close = vi
    .spyOn(NativeProvider.prototype, 'close')
    .mockRejectedValueOnce(cleanup);
  try {
    await withScriptedResponses([], () => {
      throw false;
    }).then(
      () => {
        throw new Error('unexpected success');
      },
      (error) => {
        expect(error).toBeInstanceOf(AggregateError);
        expect(error.errors).toEqual([false, cleanup]);
        expect(error.cause).toBe(false);
      },
    );
  } finally {
    close.mockRestore();
  }
});

async function partial(peer: ScriptedResponses): Promise<Socket[]> {
  const address = new URL(peer.provider.baseUrl!);
  const idle = connect(Number(address.port), address.hostname);
  const body = connect(Number(address.port), address.hostname);
  await Promise.all([once(idle, 'connect'), once(body, 'connect')]);
  body.write(
    'POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nContent-Length: 200\r\n\r\n{"partial":',
  );
  // A complete second connection round-trip proves the server is processing I/O.
  await post(peer);
  return [idle, body];
}
it.each([false, true])(
  'joins idle and incomplete reads without fabricating failures (throws=%s)',
  async (throws) => {
    let retained!: ScriptedResponses;
    let sockets: Socket[] = [];
    const scope = withScriptedResponses([[]], async (peer) => {
      retained = peer;
      sockets = await partial(peer);
      if (throws) throw 0;
      return 'complete';
    });
    if (throws)
      await scope.then(
        () => {
          throw new Error('unexpected success');
        },
        (error) => expect(error).toBe(0),
      );
    else expect(await scope).toBe('complete');
    await Promise.all(
      sockets.map((socket) =>
        socket.closed ? undefined : once(socket, 'close'),
      ),
    );
    retained.assertExhausted();
    expect(retained.requests).toEqual([{}]);
  },
);

it('keeps peers independent and claims steps by complete-body admission', async () => {
  await Promise.all(
    ['one', 'two'].map((label) =>
      withScriptedResponses([[text(label)]], async (peer) => {
        expect(await (await post(peer)).text()).toContain(label);
      }),
    ),
  );
});

it('keeps earlier peer aborts visible during later owned teardown', async () => {
  let retained!: ScriptedResponses;
  let observed!: () => void;
  const aborted = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const emit = Server.prototype.emit;
  const spy = vi.spyOn(Server.prototype, 'emit').mockImplementation(function (
    this: Server,
    event: string,
    ...args: unknown[]
  ) {
    const request = args[0];
    if (
      event === 'request' &&
      request instanceof IncomingMessage &&
      request.headers['content-length'] === '200'
    )
      request.once('aborted', observed);
    return Reflect.apply(emit, this, [event, ...args]);
  });
  try {
    await expect(
      withScriptedResponses([], async (peer) => {
        retained = peer;
        const address = new URL(peer.provider.baseUrl!);
        const socket = connect(Number(address.port), address.hostname);
        await once(socket, 'connect');
        socket.write(
          'POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nContent-Length: 200\r\n\r\n{',
        );
        expect((await post(peer)).status).toBe(400);
        socket.destroy();
        await aborted;
      }),
    ).rejects.toThrow('1 unexpected requests, 1 internal failures');
    expect(() => retained.assertExhausted()).toThrow('1 internal failures');
  } finally {
    spy.mockRestore();
  }
});

it('does not consume a step until the entire request body arrives', async () => {
  await withScriptedResponses(
    [[text('first')], [text('second')]],
    async (peer) => {
      const address = new URL(peer.provider.baseUrl!);
      const socket = connect(Number(address.port), address.hostname);
      await once(socket, 'connect');
      const chunks: Buffer[] = [];
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.write(
        'POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 2\r\n\r\n{',
      );
      expect(await (await post(peer)).text()).toContain('first');
      socket.write('}');
      await once(socket, 'close');
      expect(Buffer.concat(chunks).toString()).toContain('second');
      expect(peer.requests).toHaveLength(2);
    },
  );
});

it('preserves startup failure and closes an allocated listener without publishing a peer', async () => {
  const original = new Error('controlled startup failure');
  const listen = Server.prototype.listen;
  const servers: Server[] = [];
  const spy = vi
    .spyOn(Server.prototype, 'listen')
    .mockImplementationOnce(function (
      this: Server,
      ...args: Parameters<typeof listen>
    ) {
      servers.push(this);
      Reflect.apply(listen, this, args);
      throw original;
    });
  const callback = vi.fn();
  try {
    await withScriptedResponses([], callback).then(
      () => {
        throw new Error('unexpected success');
      },
      (error) => expect(error).toBe(original),
    );
    expect(callback).not.toHaveBeenCalled();
    expect(servers[0]?.listening).toBe(false);
  } finally {
    spy.mockRestore();
  }
  expect(await withScriptedResponses([], () => 42)).toBe(42);
});

it('joins a controlled admitted handler after the listener closes', async () => {
  const admitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const iterator = IncomingMessage.prototype[Symbol.asyncIterator];
  const spy = vi
    .spyOn(IncomingMessage.prototype, Symbol.asyncIterator)
    .mockImplementation(async function* (this: IncomingMessage) {
      for await (const chunk of Reflect.apply(iterator, this, [])) yield chunk;
      admitted.resolve();
      await release.promise;
      return undefined;
    });
  let finished = false;
  let request: Promise<unknown> | undefined;
  const scope = withScriptedResponses([[]], async (peer) => {
    request = post(peer).catch(() => undefined);
    await admitted.promise;
  }).then(() => {
    finished = true;
  });
  try {
    await admitted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    release.resolve();
    await scope;
    expect(finished).toBe(true);
    await request;
  } finally {
    release.resolve();
    spy.mockRestore();
    await scope;
  }
});
