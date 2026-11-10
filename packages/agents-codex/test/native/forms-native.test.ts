import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { Agent, HttpMCP, NativeProvider, type FormRequest } from '../../src';
import {
  binding,
  type JsonObject,
  type NativeThread,
} from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

// Hold only the first compilation requested by a controlled lifecycle case.
// All schema admission and native traffic remain real, and the actual compiler
// runs after release rather than returning a manufactured validator.
const schemaPreparation = vi.hoisted(() => ({
  next: undefined as
    { entered: () => void; release: Promise<void> } | undefined,
}));
vi.mock('@hyperjump/json-schema/draft-2020-12', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@hyperjump/json-schema/draft-2020-12')
    >();
  return {
    ...actual,
    validate: async (url: string) => {
      const gate = schemaPreparation.next;
      schemaPreparation.next = undefined;
      if (gate) {
        gate.entered();
        await gate.release;
      }
      return actual.validate(url);
    },
  };
});

function holdNextSchemaPreparation() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  schemaPreparation.next = {
    entered: () => entered.resolve(),
    release: released.promise,
  };
  return {
    entered: entered.promise,
    release() {
      schemaPreparation.next = undefined;
      released.resolve();
    },
  };
}

afterEach(async () => {
  await ModelServer.closeAll();
});

type FormMode = 'form' | 'openai/form' | 'openaiForm';
interface PeerReply {
  id: number | string;
  result?: { action?: string; content?: unknown };
  error?: unknown;
}

const standardSchema = {
  type: 'object',
  properties: { value: { type: 'string', minLength: 2 } },
  required: ['value'],
};
const extensionSchema = {
  type: 'object',
  properties: {
    profile: {
      type: 'object',
      properties: { names: { type: 'array', items: { type: 'string' } } },
      required: ['names'],
      additionalProperties: false,
    },
  },
  required: ['profile'],
  additionalProperties: false,
};

// The server sends a real request on a held tools/call response. These tests
// establish original native turn ownership, not tool-call attribution.
async function formPeer(
  mode: FormMode = 'form',
  schema: unknown = standardSchema,
  requestId: number | string = 873,
  twoTurns = false,
  handoff = false,
) {
  const replies: PeerReply[] = [];
  const replyWaiters = new Map<
    number | string,
    ReturnType<typeof Promise.withResolvers<PeerReply>>
  >();
  const initialized: unknown[] = [];
  const failures: unknown[] = [];
  const streams = new Set<ServerResponse>();
  const finishTools = new Map<number | string, () => void>();
  let callCount = 0;
  const peer = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      if (!rpc.method) {
        replies.push(rpc);
        replyWaiters.get(rpc.id)?.resolve(rpc);
        replyWaiters.delete(rpc.id);
        response.writeHead(202).end();
        finishTools.get(rpc.id)?.();
        return;
      }
      let result: unknown;
      switch (rpc.method) {
        case 'initialize':
          initialized.push(rpc.params.capabilities);
          result = {
            protocolVersion: rpc.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'forms-fixture', version: '1' },
          };
          break;
        case 'tools/list':
          result = {
            tools: [
              {
                name: 'lookup',
                description: 'Read a synthetic fixture record',
                annotations: { readOnlyHint: true, destructiveHint: false },
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          };
          break;
        case 'tools/call': {
          callCount++;
          const formId =
            callCount === 1
              ? requestId
              : typeof requestId === 'number'
                ? requestId + callCount - 1
                : `${requestId}-${callCount}`;
          streams.add(response);
          response.once('close', () => {
            streams.delete(response);
            finishTools.delete(formId);
          });
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          finishTools.set(formId, () => {
            if (!response.destroyed && !response.writableEnded)
              response.end(
                `event: message\ndata: ${JSON.stringify({
                  jsonrpc: '2.0',
                  id: rpc.id,
                  result: {
                    content: [{ type: 'text', text: 'fixture result' }],
                  },
                })}\n\n`,
              );
          });
          response.write(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id: formId,
              method:
                mode === 'form'
                  ? 'elicitation/create'
                  : mode === 'openai/form'
                    ? 'openai/form'
                    : 'openai/elicitation/create',
              params: {
                ...(mode === 'openai/form' ? {} : { mode: 'form' }),
                message: 'Confirm a synthetic fixture value',
                requestedSchema: schema,
              },
            })}\n\n`,
          );
          return;
        }
        default:
          result = {};
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch (error) {
      failures.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  peer.listen(0, '127.0.0.1');
  await once(peer, 'listening');
  const address = peer.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP peer');
  const model = new ModelServer([
    ...(handoff
      ? [[call('transfer_to_b', {}, { callId: 'form-handoff' })]]
      : []),
    [call('lookup', {}, { namespace: 'mcp__fixture', callId: 'form-call' })],
    ...(twoTurns
      ? [
          [
            call(
              'lookup',
              {},
              {
                namespace: 'mcp__fixture',
                callId: 'form-call-B',
              },
            ),
          ],
        ]
      : []),
    [message('done')],
  ]);
  const config = await model.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'fixture',
  });
  const target = new Agent({
    name: handoff ? 'B' : undefined,
    instructions: 'Read lookup once.',
    model: handoff ? 'gpt-5.5' : 'gpt-5',
    provider,
    tools: [
      new HttpMCP({
        name: 'fixture',
        url: `http://127.0.0.1:${address.port}`,
        tools: ['lookup'],
        approvalMode: 'preapproved',
      }),
    ],
  });
  const agent = handoff
    ? new Agent({
        name: 'A',
        instructions: 'Hand off to B.',
        model: 'gpt-5.5',
        provider,
        handoffs: [target],
      })
    : target;
  return {
    agent,
    replies,
    initialized,
    waitForReply(id: number | string): Promise<PeerReply> {
      const received = replies.find((reply) => reply.id === id);
      if (received) return Promise.resolve(received);
      let waiter = replyWaiters.get(id);
      if (!waiter) {
        waiter = Promise.withResolvers<PeerReply>();
        replyWaiters.set(id, waiter);
      }
      return waiter.promise;
    },
    releaseTools() {
      for (const finish of finishTools.values()) finish();
    },
    async close() {
      const errors: unknown[] = [];
      try {
        await provider.close();
      } catch (error) {
        errors.push(error);
      }
      for (const stream of streams) stream.destroy();
      peer.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        peer.close((error) => (error ? reject(error) : resolve())),
      );
      errors.push(...failures);
      if (errors.length)
        throw new AggregateError(errors, 'Form peer cleanup failed');
    },
  };
}

for (const mode of ['form', 'openai/form', 'openaiForm'] as const) {
  it(`delivers and accepts a real ${mode} schema through a one-shot handler`, async () => {
    const schema = mode === 'form' ? standardSchema : extensionSchema;
    const values: JsonObject =
      mode === 'form'
        ? { value: 'Ada' }
        : { profile: { names: ['Ada', 'Grace'] } };
    const f = await formPeer(mode, schema, mode === 'openaiForm' ? '873' : 873);
    let count = 0;
    let issued: FormRequest | undefined;
    try {
      const result = await f.agent.run('Read the fixture', {
        onInteraction(request, signal) {
          if (request.type === 'action_requested')
            throw new Error('Unexpected manual request');

          if (request.type !== 'elicitation_request' || request.mode !== 'form')
            throw new Error('Expected form');
          issued = request;
          count++;
          expect(signal.aborted).toBe(false);
          expect(request).toMatchObject({
            subagentId: null,
            call: null,
          });
          expect(request.schema).toEqual(schema);
          return request.reply(values);
        },
      });
      expect(issued).toMatchObject({
        submissionId: result.turn.submissionId,
        turnId: result.turn.turnId,
      });
      expect(result.finalOutput).toBe('done');
      expect(count).toBe(1);
      expect(f.initialized).toHaveLength(1);
      expect((f.initialized[0] as JsonObject).extensions).toEqual({
        'openai/form': {},
        'openai/elicitation': { form: {} },
      });
      expect(f.replies).toEqual([
        {
          jsonrpc: '2.0',
          id: mode === 'openaiForm' ? '873' : 873,
          result: { action: 'accept', content: values },
        },
      ]);
    } finally {
      await f.close();
    }
  }, 30_000);
}

for (const mode of ['form', 'openai/form', 'openaiForm'] as const) {
  it(`validates JSON equality without object-method semantics for real ${mode} replies`, async () => {
    const offered: JsonObject = JSON.parse(
      '{"valueOf":"ordinary value","toString":"ordinary text","__proto__":{"marker":"literal data"}}',
    );
    const reordered: JsonObject = JSON.parse(
      '{"__proto__":{"marker":"literal data"},"toString":"ordinary text","valueOf":"ordinary value"}',
    );
    const distinct: JsonObject = JSON.parse(
      '{"valueOf":"different value","toString":"ordinary text","__proto__":{"marker":"literal data"}}',
    );
    const schema = {
      type: 'object',
      properties: {
        strings: {
          type: 'array',
          items: { type: 'string' },
          uniqueItems: true,
        },
        objects: {
          type: 'array',
          items: { type: 'object' },
          uniqueItems: true,
        },
        constant: { type: 'object', const: offered },
        choice: { type: 'object', enum: [offered] },
      },
      required: ['strings', 'objects', 'constant', 'choice'],
      anyOf: [
        { properties: { marker: { const: 'a' } } },
        { properties: { marker: { const: 'b' } } },
      ],
      unevaluatedProperties: false,
    };
    const values: JsonObject = {
      strings: ['__proto__', 'valueOf', 'toString'],
      objects: [offered, distinct],
      constant: reordered,
      choice: reordered,
    };
    const invalidValues: JsonObject[] = [
      { ...values, strings: ['__proto__', '__proto__'] },
      { ...values, objects: [offered, reordered] },
      { ...values, constant: distinct },
      { ...values, choice: distinct },
      { ...values, constructor: 'unoffered' },
    ];
    const f = await formPeer(mode, schema);
    let count = 0;
    try {
      const result = await f.agent.run('Read the fixture', {
        onInteraction(request) {
          if (request.type === 'action_requested')
            throw new Error('Unexpected manual request');

          if (request.type !== 'elicitation_request' || request.mode !== 'form')
            throw new Error('Expected form');
          count++;
          expect(request.schema).toEqual(schema);
          for (const invalid of invalidValues) {
            expect(() => request.reply(invalid)).toThrowError(
              new TypeError('MCP form failed validation'),
            );
            expect(f.replies).toEqual([]);
          }
          return request.reply(values);
        },
      });
      expect(result.finalOutput).toBe('done');
      expect(count).toBe(1);
      expect(f.replies).toEqual([
        {
          jsonrpc: '2.0',
          id: 873,
          result: { action: 'accept', content: values },
        },
      ]);
      const content = f.replies[0]?.result?.content as JsonObject;
      expect(Object.hasOwn(content.constant as JsonObject, '__proto__')).toBe(
        true,
      );
      expect(Object.hasOwn(content.choice as JsonObject, '__proto__')).toBe(
        true,
      );
    } finally {
      await f.close();
    }
  }, 30_000);
}

for (const mode of ['form', 'openai/form', 'openaiForm'] as const) {
  it(`keeps literal operands and precise numeric constraints in real ${mode} replies`, async () => {
    const literal = {
      undefined: 'literal',
      $schema: 'https://should-not-fetch.invalid/schema',
    };
    const schema = {
      type: 'object',
      properties: {
        constant: { const: literal },
        choice: { enum: [literal] },
        amount: { type: 'number', multipleOf: 0.01 },
      },
      required: ['constant', 'choice', 'amount'],
      additionalProperties: false,
      default: literal,
      examples: [literal],
    };
    const values: JsonObject = {
      constant: { ...literal },
      choice: { ...literal },
      amount: 0.02,
    };
    const invalidValues: JsonObject[] = [
      { ...values, amount: 0.01000005 },
      { ...values, amount: -0.01000005 },
      { ...values, constant: { ...literal, undefined: 'changed' } },
      { ...values, choice: { ...literal, undefined: 'changed' } },
    ];
    const f = await formPeer(mode, schema);
    let count = 0;
    try {
      const result = await f.agent.run('Read the fixture', {
        onInteraction(request) {
          if (request.type === 'action_requested')
            throw new Error('Unexpected manual request');

          if (request.type !== 'elicitation_request' || request.mode !== 'form')
            throw new Error('Expected form');
          count++;
          expect(request.schema).toEqual(schema);
          for (const invalid of invalidValues) {
            expect(() => request.reply(invalid)).toThrowError(
              new TypeError('MCP form failed validation'),
            );
            expect(f.replies).toEqual([]);
          }
          return request.reply(values);
        },
      });
      expect(result.finalOutput).toBe('done');
      expect(count).toBe(1);
      expect(f.replies).toEqual([
        {
          jsonrpc: '2.0',
          id: 873,
          result: { action: 'accept', content: values },
        },
      ]);
    } finally {
      await f.close();
    }
  }, 30_000);
}

it('keeps an invalid real form reply live, rejects foreign delivery and consumes once', async () => {
  const f = await formPeer();
  let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
  let foreign: Awaited<ReturnType<typeof f.agent.session>> | undefined;
  try {
    session = await f.agent.session();
    const interactions = session.interactions();
    const turn = await session.submit('Read the fixture');
    const next = await interactions.next();
    await interactions.return?.();
    if (
      next.done ||
      next.value.type !== 'elicitation_request' ||
      next.value.mode !== 'form'
    )
      throw new Error('Expected form');
    const request = next.value;
    expect(() => request.reply({ value: '' })).toThrow('failed validation');
    expect(f.replies).toEqual([]);
    expect(await session.pendingInteractions()).toEqual([request]);
    const reply = request.reply({ value: 'Ada' });
    foreign = await new Agent({
      instructions: 'Independent root',
      model: 'gpt-5',
      provider: f.agent.provider,
    }).session();
    await expect(foreign.respond(reply)).rejects.toThrow();
    expect(f.replies).toEqual([]);
    await session.respond(reply);
    await expect(session.respond(reply)).rejects.toThrow();
    expect(() => request.reply(null)).toThrow('expired');
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(f.replies).toMatchObject([
      { result: { action: 'accept', content: { value: 'Ada' } } },
    ]);
    expect(await session.pendingInteractions()).toEqual([]);
  } finally {
    try {
      await session?.close();
    } finally {
      try {
        await foreign?.close();
      } finally {
        await f.close();
      }
    }
  }
}, 30_000);

it('keeps a real URI form live after malformed authority answers and delivers one correction', async () => {
  const f = await formPeer('form', {
    type: 'object',
    properties: { value: { type: 'string', format: 'uri' } },
    required: ['value'],
  });
  let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
  try {
    session = await f.agent.session();
    const interactions = session.interactions();
    const turn = await session.submit('Read the fixture');
    const next = await interactions.next();
    await interactions.return?.();
    if (
      next.done ||
      next.value.type !== 'elicitation_request' ||
      next.value.mode !== 'form'
    )
      throw new Error('Expected URI form');
    const request = next.value;
    for (const value of [
      'https://example.com:abc',
      'https://[::1]:abc',
      'custom://user@@host/',
    ]) {
      expect(() => request.reply({ value })).toThrow(
        'MCP form failed validation',
      );
      expect(f.replies).toEqual([]);
      expect(await session.pendingInteractions()).toEqual([request]);
    }
    const value = 'custom://user%40name:pass@[::1]:123/path';
    await session.respond(request.reply({ value }));
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(f.replies).toMatchObject([
      { result: { action: 'accept', content: { value } } },
    ]);
    expect(f.replies).toHaveLength(1);
    expect(await session.pendingInteractions()).toEqual([]);
    expect(() => request.reply({ value })).toThrow('expired');
  } finally {
    try {
      await session?.close();
    } finally {
      await f.close();
    }
  }
}, 30_000);

it('delivers null as a real form decline without content', async () => {
  const f = await formPeer();
  try {
    const result = await f.agent.run('Read the fixture', {
      onInteraction(request) {
        if (request.type === 'action_requested')
          throw new Error('Unexpected manual request');

        if (request.type !== 'elicitation_request' || request.mode !== 'form')
          throw new Error('Expected form');
        return request.reply(null);
      },
    });
    expect(result.finalOutput).toBe('done');
    expect(f.replies).toMatchObject([{ result: { action: 'decline' } }]);
    expect(f.replies[0]?.result?.content ?? null).toBeNull();
  } finally {
    await f.close();
  }
}, 30_000);

it('refuses an unsupported real extension form schema without a callback', async () => {
  const f = await formPeer('openai/form', {
    type: 'object',
    properties: { value: { type: 'string', pattern: '^fixture$' } },
  });
  let count = 0;
  try {
    const result = await f.agent.run('Read the fixture', {
      onInteraction() {
        count++;
        throw new Error('Unsupported schema reached the application');
      },
    });
    expect(result.finalOutput).toBe('done');
    expect(count).toBe(0);
    expect(f.replies).toMatchObject([{ result: { action: 'decline' } }]);
  } finally {
    await f.close();
  }
}, 30_000);

for (const mode of ['force', 'graceful'] as const) {
  it(`expires registered A on ${mode} cancellation and never rebinds its reply to B`, async () => {
    const f = await formPeer('form', standardSchema, 873, true);
    let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
    try {
      session = await f.agent.session();
      const interactions = session.interactions();
      try {
        const a = await session.submit('Read A');
        const first = await interactions.next();
        if (
          first.done ||
          first.value.type !== 'elicitation_request' ||
          first.value.mode !== 'form'
        )
          throw new Error('Expected registered A form');
        const requestA = first.value;
        const preparedA = requestA.reply({ value: 'A value' });
        const completionA = a.wait();
        completionA.catch(() => {});
        const stopping = a.cancel({ mode });
        stopping.catch(() => {});
        // Cancellation retires the registration; no application reply releases A.
        // A peer response may already have completed through automatic decline.
        await stopping;
        f.releaseTools();
        await expect(completionA).rejects.toThrow();
        expect(() => requestA.reply({ value: 'A late value' })).toThrow(
          'expired',
        );
        await expect(session.respond(preparedA)).rejects.toThrow();
        expect(await session.pendingInteractions()).toEqual([]);

        const b = await session.submit('Read B');
        const second = await interactions.next();
        if (
          second.done ||
          second.value.type !== 'elicitation_request' ||
          second.value.mode !== 'form'
        )
          throw new Error('Expected newly registered B form');
        const requestB = second.value;
        expect(requestB).not.toBe(requestA);
        expect(requestB).toMatchObject({
          submissionId: b.submissionId,
          turnId: b.turnId,
          call: null,
        });
        expect(() => requestA.reply({ value: 'A during B' })).toThrow(
          'expired',
        );
        await expect(session.respond(preparedA)).rejects.toThrow();
        expect(await session.pendingInteractions()).toEqual([requestB]);
        expect(f.replies.filter((reply) => reply.id === 874)).toEqual([]);
        await session.respond(requestB.reply({ value: 'B value' }));
        expect((await b.wait()).finalOutput).toBe('done');
        expect(f.replies.filter((reply) => reply.id === 874)).toMatchObject([
          { result: { action: 'accept', content: { value: 'B value' } } },
        ]);
        await expect(session.respond(preparedA)).rejects.toThrow();
      } finally {
        await interactions.return?.();
      }
    } finally {
      f.releaseTools();
      try {
        await session?.close();
      } finally {
        await f.close();
      }
    }
  }, 30_000);
}

it('expires a pending real form and its prepared reply when Session closes', async () => {
  const f = await formPeer();
  let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
  try {
    session = await f.agent.session();
    const interactions = session.interactions();
    const turn = await session.submit('Read the fixture');
    const next = await interactions.next();
    await interactions.return?.();
    if (
      next.done ||
      next.value.type !== 'elicitation_request' ||
      next.value.mode !== 'form'
    )
      throw new Error('Expected pending form');
    const request = next.value;
    const prepared = request.reply({ value: 'prepared before close' });
    const completion = turn.wait();
    completion.catch(() => {});
    const closing = session.close();
    closing.catch(() => {});
    f.releaseTools();
    await closing;
    await expect(completion).rejects.toThrow();
    expect(() => request.reply(null)).toThrow('expired');
    await expect(session.respond(prepared)).rejects.toThrow();
    expect(f.replies.some((reply) => reply.result?.action === 'accept')).toBe(
      false,
    );
  } finally {
    f.releaseTools();
    try {
      await session?.close();
    } finally {
      await f.close();
    }
  }
}, 30_000);

it('preserves a form handler failure and expires its request before run rejects', async () => {
  const f = await formPeer();
  const failure = new Error('Application form collection failed');
  let issued: FormRequest | undefined;
  let callbackSignal: AbortSignal | undefined;
  try {
    await expect(
      f.agent.run('Read the fixture', {
        async onInteraction(request, signal) {
          if (request.type === 'action_requested')
            throw new Error('Unexpected manual request');

          if (request.type !== 'elicitation_request' || request.mode !== 'form')
            throw new Error('Expected form');
          issued = request;
          callbackSignal = signal;
          // A constructed response has no effect without successful delivery.
          request.reply({ value: 'collected but not delivered' });
          await Promise.resolve();
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(issued).toBeDefined();
    expect(callbackSignal?.aborted).toBe(true);
    expect(() => issued!.reply(null)).toThrow('expired');
    expect(f.replies.some((reply) => reply.result?.action === 'accept')).toBe(
      false,
    );
  } finally {
    await f.close();
  }
}, 30_000);

it('publishes a real extension form only after its owned schema preparation completes', async () => {
  const gate = holdNextSchemaPreparation();
  const f = await formPeer('openai/form', extensionSchema);
  let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
  try {
    session = await f.agent.session();
    const interactions = session.interactions();
    try {
      const turn = await session.submit('Read the fixture');
      await gate.entered;
      expect(await session.pendingInteractions()).toEqual([]);
      expect(f.replies).toEqual([]);
      gate.release();
      const next = await interactions.next();
      if (
        next.done ||
        next.value.type !== 'elicitation_request' ||
        next.value.mode !== 'form'
      )
        throw new Error('Expected prepared extension form');
      expect(next.value.schema).toEqual(extensionSchema);
      const reply = next.value.reply({ profile: { names: ['Ada'] } });
      // Public response construction stays synchronous after async preparation.
      expect(reply).not.toBeInstanceOf(Promise);
      await session.respond(reply);
      expect((await turn.wait()).finalOutput).toBe('done');
      expect(await f.waitForReply(873)).toMatchObject({
        result: { action: 'accept', content: { profile: { names: ['Ada'] } } },
      });
    } finally {
      await interactions.return?.();
    }
  } finally {
    gate.release();
    f.releaseTools();
    try {
      await session?.close();
    } finally {
      await f.close();
    }
  }
}, 30_000);

for (const { label, mode, escalate, repeatInterrupt } of [
  { label: 'force', mode: 'force', escalate: false, repeatInterrupt: false },
  {
    label: 'graceful',
    mode: 'graceful',
    escalate: false,
    repeatInterrupt: false,
  },
  {
    label: 'graceful-to-force',
    mode: 'graceful',
    escalate: true,
    repeatInterrupt: false,
  },
  {
    label: 'repeated-interrupt',
    mode: 'force',
    escalate: false,
    repeatInterrupt: true,
  },
] as const) {
  it(`declines an unpublished real form immediately on ${label} cancel and joins compilation before successor admission`, async () => {
    const gate = holdNextSchemaPreparation();
    const timeline: Array<{ phase: string; at: number }> = [];
    const mark = (phase: string) => timeline.push({ phase, at: Date.now() });
    const heldReply = mode === 'force' || escalate;
    const forceRequested = Promise.withResolvers<void>();
    const replyEntered = Promise.withResolvers<void>();
    const releaseReply = Promise.withResolvers<void>();
    let settleStarted = false;
    let forceRequests = 0;
    let declineAccepted: boolean | undefined;
    const restores: Array<{ mockRestore(): void }> = [];
    if (heldReply) {
      const { NativeThread: Thread } = await binding();
      const respond = Thread.prototype._respond_owned_native_question;
      restores.push(
        vi
          .spyOn(Thread.prototype, '_respond_owned_native_question')
          .mockImplementation(async function (this: NativeThread, id, raw) {
            if (JSON.parse(raw).kind === 'decline_elicitation') {
              mark('decline-enqueue-entered');
              replyEntered.resolve();
              await releaseReply.promise;
              const accepted = await respond.call(this, id, raw);
              declineAccepted = accepted;
              mark('decline-enqueue-completed');
              return accepted;
            }
            return respond.call(this, id, raw);
          }),
      );
      const request = Thread.prototype._request_graph_stop;
      restores.push(
        vi
          .spyOn(Thread.prototype, '_request_graph_stop')
          .mockImplementation(function (this: NativeThread, scope, stopMode) {
            const stop = request.call(this, scope, stopMode);
            const settle = stop.settle.bind(stop);
            restores.push(
              vi.spyOn(stop, 'settle').mockImplementation(() => {
                settleStarted = true;
                mark('native-stop-settle');
                return settle();
              }),
            );
            if (stopMode === 'force') {
              forceRequests++;
              forceRequested.resolve();
            }
            return stop;
          }),
      );
    }
    const f = await formPeer('openai/form', extensionSchema, 873, true);
    let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
    try {
      session = await f.agent.session();
      const interactions = session.interactions();
      try {
        const a = await session.submit('Read A');
        const completionA = a.wait();
        completionA.catch(() => {});
        await gate.entered;
        mark('schema-entered');
        expect(await session.pendingInteractions()).toEqual([]);
        const nextQuestion = interactions.next();
        nextQuestion.catch(() => {});
        let stopped = false;
        mark('cancel-called');
        const interrupting = repeatInterrupt
          ? session.interrupt({ mode })
          : undefined;
        interrupting?.catch(() => {});
        let stopping = a.cancel({ mode });
        if (interrupting)
          stopping = Promise.all([interrupting, stopping]).then(() => {});
        mark('cancel-returned');
        void stopping.then(
          () => {
            stopped = true;
          },
          () => {
            stopped = true;
          },
        );
        if (heldReply) {
          await replyEntered.promise;
          try {
            if (escalate) {
              const forcing = a.cancel({ mode: 'force' });
              forcing.catch(() => {});
              stopping = Promise.all([stopping, forcing]).then(() => {});
              await forceRequested.promise;
            }
            if (repeatInterrupt) {
              await session.interrupt({ mode: 'force' });
              expect(forceRequests).toBe(2);
            }
            // Native interruption must not overtake the negative reply enqueue.
            expect(settleStarted).toBe(false);
          } finally {
            releaseReply.resolve();
          }
        }
        const declined = await f.waitForReply(873);
        mark('peer-reply');
        if (process.env.EXECUTOR_EVIDENCE) {
          writeFileSync(
            join(process.env.EXECUTOR_EVIDENCE, `form-${label}-reply.json`),
            JSON.stringify(
              {
                mode: label,
                declined,
                declineAccepted,
                forceRequests,
                replies: f.replies,
                timeline,
                stopped,
                capturedBeforeSchemaRelease: true,
              },
              null,
              2,
            ),
            { flag: 'wx' },
          );
        }
        // The actual peer's decline is the barrier, not an elapsed-time scan.
        expect(declined).toMatchObject({ result: { action: 'decline' } });
        expect(declined.result?.content ?? null).toBeNull();
        if (heldReply) expect(declineAccepted).toBe(true);
        expect(stopped).toBe(false);
        expect(await session.pendingInteractions()).toEqual([]);
        gate.release();
        await stopping;
        if (repeatInterrupt) await a.cancel({ mode: 'force' });
        await expect(completionA).rejects.toThrow();
        expect(await session.pendingInteractions()).toEqual([]);
        expect(f.replies.filter((reply) => reply.id === 873)).toHaveLength(1);

        const b = await session.submit('Read B');
        const next = await nextQuestion;
        if (
          next.done ||
          next.value.type !== 'elicitation_request' ||
          next.value.mode !== 'form'
        )
          throw new Error('Expected newly prepared B form');
        // A never issued a wrapper; only B's fresh registration becomes visible.
        expect(next.value).toMatchObject({
          turnId: b.turnId,
          submissionId: b.submissionId,
          call: null,
        });
        expect(await session.pendingInteractions()).toEqual([next.value]);
        expect(f.replies.filter((reply) => reply.id === 874)).toEqual([]);
        await session.respond(next.value.reply({ profile: { names: ['B'] } }));
        expect((await b.wait()).finalOutput).toBe('done');
        expect(await f.waitForReply(874)).toMatchObject({
          result: { action: 'accept', content: { profile: { names: ['B'] } } },
        });
        expect(f.replies.filter((reply) => reply.id === 873)).toMatchObject([
          { result: { action: 'decline' } },
        ]);
      } finally {
        await interactions.return?.();
      }
    } finally {
      releaseReply.resolve();
      for (const restore of restores.reverse()) restore.mockRestore();
      gate.release();
      f.releaseTools();
      try {
        await session?.close();
      } finally {
        await f.close();
      }
    }
  }, 30_000);
}

it('declines an unpublished real form on close while joining its held compilation', async () => {
  const gate = holdNextSchemaPreparation();
  const f = await formPeer('openai/form', extensionSchema);
  let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
  try {
    session = await f.agent.session();
    const turn = await session.submit('Read the fixture');
    const completion = turn.wait();
    completion.catch(() => {});
    await gate.entered;
    expect(await session.pendingInteractions()).toEqual([]);
    let closed = false;
    const closing = session.close();
    void closing.then(
      () => {
        closed = true;
      },
      () => {
        closed = true;
      },
    );
    const declined = await f.waitForReply(873);
    expect(declined).toMatchObject({ result: { action: 'decline' } });
    expect(declined.result?.content ?? null).toBeNull();
    expect(closed).toBe(false);
    gate.release();
    await closing;
    await expect(completion).rejects.toThrow();
    expect(f.replies).toMatchObject([
      { id: 873, result: { action: 'decline' } },
    ]);
    expect(f.replies.some((reply) => reply.result?.action === 'accept')).toBe(
      false,
    );
  } finally {
    gate.release();
    f.releaseTools();
    try {
      await session?.close();
    } finally {
      await f.close();
    }
  }
}, 30_000);

it('delivers a target-only MCP form after handoff using the issuing step selection', async () => {
  const f = await formPeer('form', standardSchema, 873, false, true);
  let count = 0;
  try {
    const result = await f.agent.run('Read the fixture', {
      onInteraction(request) {
        if (request.type !== 'elicitation_request' || request.mode !== 'form')
          throw new Error('Expected target form');
        count++;
        expect(request.schema).toEqual(standardSchema);
        return request.reply({ value: 'Ada' });
      },
    });
    expect(result.finalOutput).toBe('done');
    expect(count).toBe(1);
    expect(f.replies).toMatchObject([
      { id: 873, result: { action: 'accept', content: { value: 'Ada' } } },
    ]);
  } finally {
    await f.close();
  }
}, 20_000);
