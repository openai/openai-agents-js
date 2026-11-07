import { nativeEventBatch } from './fixtures/native-event-batches';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine, NativeThread } from '../src/runtime/binding';
import { HttpMCP, StdioMCP, mcpConfig } from '../src/runtime/mcp';
import { Environment } from '../src/runtime/environment';
import { NativeAgents } from '../src/runtime/native-agents';
import {
  InteractionRequired,
  NativeError,
  Session,
} from '../src/runtime/session';
import { createUrlCompletion } from '../src/runtime/url-elicitation';
import { captureTools } from '../src/runtime/tools';
import { prepareNativeForm } from '../src/runtime/native-forms';
import {
  formQuestionReply,
  isNativeQuestionReply,
  issueNativeQuestion,
  parseNativeQuestion,
  nativeReplyRequest,
  negativeQuestionReply,
  urlQuestionPresentation,
  urlQuestionReply,
} from '../src/runtime/native-questions';

// Pure grant tests. These fixtures do not claim native liveness or attribution.
function approval() {
  let live = true;
  const grant = issueNativeQuestion(
    {
      type: 'approval_request',
      sessionId: 'session',
      subagentId: null,
      submissionId: 'submission',
      turnId: 'turn',
      call: null,
      description: 'private command and credential',
    },
    (value) => {
      if (value !== 'allow_once' && value !== 'deny')
        throw new TypeError('decision');
      return JSON.stringify({ decision: value });
    },
    () => live,
  );
  const request = grant.request;
  if (request.type !== 'approval_request') throw new Error('fixture');
  return {
    grant,
    request,
    expire: () => {
      live = false;
    },
  };
}

describe('native question grants', () => {
  it('keeps authority private and ordinary inspection free of the prompt', () => {
    const { grant } = approval();
    expect(Object.isFrozen(grant.request)).toBe(true);
    expect(grant.request.description).toContain('private command');
    expect(JSON.stringify(grant.request)).not.toContain('credential');
    expect(inspect(grant.request)).not.toContain('credential');
    expect(grant.request.call).toBeNull();
    expect(
      isNativeQuestionReply(JSON.parse(JSON.stringify(grant.request))),
    ).toBe(false);
  });

  it('validates before issuing a reply and consumes the grant once at delivery', () => {
    const { grant, request } = approval();
    expect(() => request.reply({} as never)).toThrow('decision');
    const first = request.reply('allow_once');
    const sibling = request.reply('deny');
    expect(Object.isFrozen(first)).toBe(true);
    expect(nativeReplyRequest(first)).toBe(grant.request);
    expect(JSON.stringify(first)).toBe('{}');
    expect(grant.take(first)).toBe('{"decision":"allow_once"}');
    expect(() => grant.take(first)).toThrow();
    expect(() => grant.take(sibling)).toThrow();
    expect(() => request.reply('deny')).toThrow();
  });

  it('rejects a foreign reply without consuming either live grant', () => {
    const first = approval();
    const a = first.grant;
    const b = approval().grant;
    const reply = first.request.reply('deny');
    expect(() => b.take(reply)).toThrow('foreign');
    expect(a.current()).toBe(true);
    expect(b.current()).toBe(true);
    expect(a.take(reply)).toContain('deny');
  });

  it('checks liveness again at reply construction and delivery', () => {
    const a = approval();
    const reply = a.request.reply('deny');
    a.expire();
    expect(() => a.grant.take(reply)).toThrow('expired');
    expect(() => a.request.reply('deny')).toThrow('expired');
    const b = approval();
    b.grant.deactivate();
    expect(b.grant.current()).toBe(false);
    expect(() => b.request.reply('deny')).toThrow('expired');
  });

  it('returns detached URL schema snapshots and permits only a negative reply', () => {
    const grant = issueNativeQuestion(
      {
        type: 'elicitation_request',
        sessionId: 'session',
        subagentId: null,
        submissionId: null,
        turnId: null,
        call: null,
        description: 'private URL',
      },
      (value) => {
        if (value !== null)
          throw new TypeError('URL acceptance is unsupported');
        return 'decline';
      },
      () => true,
    );
    const request = grant.request;
    if (request.type !== 'elicitation_request') throw new Error('fixture');
    const schema = request.schema;
    (schema as Record<string, unknown>).changed = true;
    expect(request.schema).toEqual({});
    expect(() => request.reply({} as never)).toThrow('unsupported');
    expect(grant.current()).toBe(true);
    expect(grant.take(request.reply(null))).toBe('decline');
  });
});

async function form(id = '9007199254740993') {
  const schema = {
    type: 'object',
    properties: {
      profile: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1 } },
        required: ['name'],
        additionalProperties: false,
      },
    },
    required: ['profile'],
    additionalProperties: false,
  };
  const prepared = await prepareNativeForm('openai/form', schema);
  const grant = issueNativeQuestion(
    {
      type: 'elicitation_request',
      sessionId: 'form-session',
      subagentId: null,
      submissionId: null,
      turnId: null,
      call: null,
      description: 'synthetic private form',
    },
    formQuestionReply('records', id, prepared),
    () => true,
    prepared,
  );
  const request = grant.request;
  if (request.type !== 'elicitation_request') throw new Error('fixture');
  return { schema, grant, request };
}

describe('native form question grants', () => {
  it('detaches schema snapshots and captures values when issuing a reply', async () => {
    const { schema, grant, request } = await form();
    schema.properties.profile.properties.name.minLength = 99;
    const exposed = request.schema as typeof schema;
    exposed.properties.profile.properties.name.type = 'number';
    expect(request.schema).toMatchObject({
      properties: {
        profile: {
          properties: { name: { type: 'string', minLength: 1 } },
        },
      },
    });
    const values = { profile: { name: 'Ada' } };
    const reply = request.reply(values);
    values.profile.name = 'changed after reply';
    expect(JSON.stringify(request)).not.toContain('profile');
    expect(inspect(request)).not.toContain('private');
    expect(JSON.stringify(reply)).toBe('{}');
    expect(grant.take(reply)).toBe(
      '{"kind":"accept_elicitation","server_name":"records","request_id":9007199254740993,"content":{"profile":{"name":"Ada"}}}',
    );
  });

  it('keeps a grant live after invalid values and consumes a valid reply once', async () => {
    const { grant, request } = await form();
    expect(() => request.reply({ profile: { name: '' } })).toThrow(
      'MCP form failed validation',
    );
    expect(grant.current()).toBe(true);
    const reply = request.reply({ profile: { name: 'Ada' } });
    const sibling = request.reply(null);
    expect(isNativeQuestionReply(reply)).toBe(true);
    expect(nativeReplyRequest(reply)).toBe(request);
    expect(grant.take(reply)).toContain('accept_elicitation');
    expect(() => grant.take(reply)).toThrow('already delivered');
    expect(() => grant.take(sibling)).toThrow('already delivered');
    expect(() => request.reply(null)).toThrow('already answered');
  });

  it('preserves exact numeric and string IDs for accept and null decline', async () => {
    for (const id of ['9007199254740993', '"9007199254740993"']) {
      const accepted = await form(id);
      expect(
        accepted.grant.take(
          accepted.request.reply({ profile: { name: 'Ada' } }),
        ),
      ).toContain(`"request_id":${id},"content":`);
      const declined = await form(id);
      expect(declined.grant.take(declined.request.reply(null))).toBe(
        `{"kind":"decline_elicitation","server_name":"records","request_id":${id}}`,
      );
    }
  });

  it('rejects foreign and expired form replies without consuming a live owner', async () => {
    const first = await form();
    const second = await form();
    const reply = first.request.reply({ profile: { name: 'Ada' } });
    expect(() => second.grant.take(reply)).toThrow('foreign');
    expect(first.grant.current()).toBe(true);
    expect(second.grant.current()).toBe(true);
    first.grant.deactivate();
    expect(() => first.grant.take(reply)).toThrow('expired');
    expect(() => first.request.reply(null)).toThrow('expired');
    expect(second.grant.take(second.request.reply(null))).toContain(
      'decline_elicitation',
    );
  });

  it('keeps URL acceptance unavailable through the shared reply API', () => {
    const grant = issueNativeQuestion(
      {
        type: 'elicitation_request',
        sessionId: 'url-session',
        subagentId: null,
        submissionId: null,
        turnId: null,
        call: null,
        description: 'synthetic private URL',
      },
      negativeQuestionReply('decline-url'),
      () => true,
    );
    const request = grant.request;
    if (request.type !== 'elicitation_request') throw new Error('fixture');
    expect(() => request.reply({})).toThrow('decline only');
    expect(grant.current()).toBe(true);
    expect(grant.take(request.reply(null))).toBe('decline-url');
  });
});

// Pure question-boundary regressions; these establish no live native ownership.
describe.each(['openai/form', 'openaiForm'] as const)(
  '%s extension constraint replies',
  (mode) => {
    async function question(schema: unknown) {
      const prepared = await prepareNativeForm(mode, schema);
      const grant = issueNativeQuestion(
        {
          type: 'elicitation_request',
          sessionId: 'constraint-session',
          subagentId: null,
          submissionId: null,
          turnId: null,
          call: null,
          description: 'synthetic constraint question',
        },
        formQuestionReply('records', '17', prepared),
        () => true,
        prepared,
      );
      const request = grant.request;
      if (request.type !== 'elicitation_request') throw new Error('fixture');
      return { grant, request };
    }

    it.each([
      [1, [1.00000005, -1.00000005], 3],
      [0.01, [0.01000005, -0.01000005], 0.03],
      [0.0000001, [0.00000015, -0.00000015], 0.0000003],
      [0.1, [0.30000005, -0.30000005], 0.3],
    ] as const)(
      'rejects clear nonmultiples of %s and keeps exact replies possible',
      async (step, nonmultiples, valid) => {
        const schema = {
          type: 'object',
          properties: { value: { type: 'number', multipleOf: step } },
          required: ['value'],
          additionalProperties: false,
        };
        const { grant, request } = await question(schema);
        for (const value of nonmultiples) {
          expect(() => request.reply({ value })).toThrowError(
            new TypeError('MCP form failed validation'),
          );
          expect(grant.current()).toBe(true);
        }
        expect(JSON.parse(grant.take(request.reply({ value: valid })))).toEqual(
          {
            kind: 'accept_elicitation',
            server_name: 'records',
            request_id: 17,
            content: { value: valid },
          },
        );
        const negative = await question(schema);
        expect(
          JSON.parse(
            negative.grant.take(negative.request.reply({ value: -valid })),
          ),
        ).toEqual({
          kind: 'accept_elicitation',
          server_name: 'records',
          request_id: 17,
          content: { value: -valid },
        });
      },
    );

    it.each([
      ['issue#', 'issue%23'],
      ['a#b', 'a%23b'],
    ])(
      'accepts a direct encoded-hash definition %s without changing readback',
      async (name, token) => {
        const schema = {
          type: 'object',
          $defs: { [name]: { type: 'string', minLength: 2 } },
          properties: { value: { $ref: `#/$defs/${token}` } },
          required: ['value'],
          additionalProperties: false,
        };
        const { grant, request } = await question(schema);
        expect(request.schema).toEqual(schema);
        for (const value of ['x', 1]) {
          expect(() => request.reply({ value })).toThrowError(
            new TypeError('MCP form failed validation'),
          );
          expect(grant.current()).toBe(true);
        }
        expect(JSON.parse(grant.take(request.reply({ value: 'ok' })))).toEqual({
          kind: 'accept_elicitation',
          server_name: 'records',
          request_id: 17,
          content: { value: 'ok' },
        });
        expect(request.schema).toEqual(schema);
      },
    );
  },
);

describe('native request source', () => {
  it('preserves numeric and string IDs without rounding native i64 values', () => {
    expect(parseNativeQuestion('{"msg":{"id":9007199254740993}}').id).toBe(
      '9007199254740993',
    );
    expect(parseNativeQuestion('{"msg":{"id":"9007199254740993"}}').id).toBe(
      '"9007199254740993"',
    );
    expect(parseNativeQuestion('{"msg":{"id":-9223372036854775808}}').id).toBe(
      '-9223372036854775808',
    );
    expect(parseNativeQuestion('{"msg":{"id":0}}').id).toBe('0');
  });

  it('preserves literal schema keys before generic event normalization', async () => {
    const schema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"const":{"valueOf":"literal","__proto__":"data"}}}}',
    );
    const source = parseNativeQuestion(
      JSON.stringify({
        msg: { id: 17, request: { requested_schema: schema } },
      }),
    );
    expect(source.schema).toEqual(schema);
    const prepared = await prepareNativeForm('openai/form', source.schema);
    const values = JSON.parse(
      '{"__proto__":{"valueOf":"literal","__proto__":"data"}}',
    );
    expect(prepared.validate(values)).toEqual(values);
    expect(Object.hasOwn(prepared.validate(values), '__proto__')).toBe(true);
  });

  it('keeps raw schema data subject to finite JSON validation', async () => {
    const source = parseNativeQuestion(
      '{"msg":{"id":17,"request":{"requested_schema":{"type":"object","const":{"__proto__":1e500}}}}}',
    );
    await expect(
      prepareNativeForm('openai/form', source.schema),
    ).rejects.toThrow('Unsupported MCP extension form schema');
  });

  it('rejects missing, noninteger and overflowing native IDs', () => {
    for (const raw of [
      '{}',
      '{"msg":{}}',
      '{"msg":{"id":null}}',
      '{"msg":{"id":1.5}}',
      '{"msg":{"id":9223372036854775808}}',
    ])
      expect(() => parseNativeQuestion(raw)).toThrow();
  });
});

// Controlled receipts exercise the real Session reader/startup/close owners.
// They establish SDK scheduling only, not a real Core or remote callback order.
function startupFixture() {
  const publication = Promise.withResolvers<string>();
  const events = Array.from({ length: 4 }, () =>
    Promise.withResolvers<string>(),
  );
  const entered = Array.from({ length: 4 }, () =>
    Promise.withResolvers<void>(),
  );
  const mcpResult = Promise.withResolvers<string>();
  const closingEntered = Promise.withResolvers<void>();
  const engineClosed = Promise.withResolvers<null>();
  const cleanup = vi.fn(async () => {});
  const position = { value: 0 };
  const boundary = { id: undefined as string | undefined };
  const delivery = {
    held: false,
    ready: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  };
  const nextEvent = vi.fn(() => {
    const index = position.value++;
    if (!events[index]) throw new Error('Unexpected extra event read');
    entered[index].resolve();
    const receipt = events[index].promise;
    if (index !== 1 || !delivery.held) return receipt;
    return receipt.then(async (raw) => {
      delivery.ready.resolve();
      await delivery.release.promise;
      return raw;
    });
  });
  const publish = vi.fn(
    (
      _servers: string,
      _policies?: string,
      _rules?: string,
      _generation?: string,
      _specs?: string,
      id?: string,
    ) => {
      boundary.id = id;
      return publication.promise;
    },
  );
  const closeEngine = vi.fn(() => {
    closingEntered.resolve();
    return engineClosed.promise;
  });
  const native = {
    id: 'startup-fixture',
    _enable_native_mcp_results: vi.fn(),
    _enable_native_interception: vi.fn(),
    _configure_native_interception: vi.fn(),
    _next_native_interception: vi.fn(() => mcpResult.promise),
    _revoke_native_interception: vi.fn(),
    _replace_mcp_servers: publish,
    _next_session_events: () =>
      nextEvent().then((raw) => nativeEventBatch([raw])),
    _finish_child_event_reader: vi.fn(),
    _next_native_mcp_result: vi.fn(() => mcpResult.promise),
    _revoke_native_mcp_results: vi.fn(),
    _stop_sampling_for_close: vi.fn(),
    _close_report: vi.fn(async () => null),
  };
  const session = new Session(
    { _close_report: closeEngine } as unknown as Engine,
    native as unknown as NativeThread,
    captureTools([]),
    {
      mcpTools: [
        new HttpMCP({
          name: 'fixture',
          url: 'http://127.0.0.1:1/mcp',
          tools: ['read'],
        }),
      ],
      onClose: cleanup,
    },
    {},
  );
  const receipt = JSON.stringify({
    result: {
      publication: 'published',
      ready: true,
      policy_generation: '0',
      servers: {
        fixture: {
          accepted: true,
          ready: true,
          status: 'connected',
          listing_error: false,
          tools: ['read'],
        },
      },
    },
  });
  const shutdown = JSON.stringify({
    id: 'opening',
    msg: { type: 'shutdown_complete' },
  });
  const configured = JSON.stringify({
    id: 'opening',
    msg: { type: 'session_configured' },
  });
  const question = JSON.stringify({
    id: 'opening-question',
    msg: { type: 'exec_approval_request' },
  });
  return {
    session,
    native,
    publication,
    events,
    entered,
    publish,
    nextEvent,
    boundary,
    delivery,
    closingEntered,
    engineClosed,
    closeEngine,
    cleanup,
    receipt,
    shutdown,
    configured,
    question,
    marker: () => {
      expect(boundary.id).toEqual(expect.any(String));
      return JSON.stringify({
        id: boundary.id,
        msg: { type: 'sdk_mcp_publication_boundary' },
      });
    },
    close: async () => {
      const closing = session.close();
      publication.resolve(receipt);
      for (const event of events) event.resolve(shutdown);
      delivery.release.resolve();
      mcpResult.resolve('null');
      engineClosed.resolve(null);
      await closing;
    },
  };
}

describe('native question startup settlement', () => {
  for (const failure of ['question', 'shutdown', 'reader failure'] as const) {
    it(`rejects late ${failure} and joins opening cleanup`, async () => {
      const f = startupFixture();
      const readerFailure = new Error('original startup reader failure');
      const opening = f.session._start().then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      try {
        expect(f.nextEvent).toHaveBeenCalledTimes(1);
        expect(f.publish).toHaveBeenCalledTimes(1);
        expect(f.nextEvent.mock.invocationCallOrder[0]).toBeLessThan(
          f.publish.mock.invocationCallOrder[0],
        );
        if (failure === 'reader failure') {
          f.events[0].reject(readerFailure);
          // Preserve the original reader error even when a later publication
          // receipt also fails validation. This yield observes existing catches.
          await Promise.resolve();
          f.publication.resolve('{}');
        } else {
          // Resolve publication before the event in the same turn. Its race
          // continuation runs after the reader has recorded the first cause.
          f.publication.resolve(f.receipt);
          f.events[0].resolve(failure === 'shutdown' ? f.shutdown : f.question);
        }
        const outcome = await opening;
        expect(f.native._finish_child_event_reader).toHaveBeenCalledTimes(1);
        if (failure === 'question')
          expect(outcome.error).toBeInstanceOf(InteractionRequired);
        else if (failure === 'shutdown') {
          expect(outcome.error).toBeInstanceOf(NativeError);
          expect(outcome.error).toMatchObject({
            message: 'Native session shut down while opening',
          });
        } else expect(outcome.error).toBe(readerFailure);
        // Failed startup now precedes the marker, so it must not start the
        // auxiliary MCP reader. The same Engine owner still joins cleanup.
        expect(f.native._next_native_mcp_result).not.toHaveBeenCalled();
        const closed = { value: false };
        const closing = f.session.close().then(() => {
          closed.value = true;
        });
        await f.closingEntered.promise;
        expect(f.closeEngine).toHaveBeenCalledTimes(1);
        expect(f.native._close_report).not.toHaveBeenCalled();
        expect(closed.value).toBe(false);
        expect(f.cleanup).not.toHaveBeenCalled();
        f.engineClosed.resolve(null);
        await closing;
        expect(closed.value).toBe(true);
        expect(f.cleanup).toHaveBeenCalledTimes(1);
      } finally {
        await f.close();
        await opening;
      }
    });
  }

  it('rejects an opening question behind a preceding event after publication wins', async () => {
    const f = startupFixture();
    const opening = f.session._start().then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    try {
      f.publication.resolve(f.receipt);
      f.events[0].resolve(f.configured);
      // The sole reader processes the first event and asks for another. The
      // publication continuation can run before this second receipt arrives.
      await f.entered[1].promise;
      f.events[1].resolve(f.question);
      expect((await opening).error).toBeInstanceOf(InteractionRequired);
      expect(f.native._next_native_mcp_result).not.toHaveBeenCalled();
      await f.close();
      expect(f.cleanup).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
      await opening;
    }
  });

  it('waits for the sole reader to receive a delayed publication boundary', async () => {
    const f = startupFixture();
    f.delivery.held = true;
    const settled = { value: false };
    const opening = f.session._start().then(() => {
      settled.value = true;
    });
    try {
      f.publication.resolve(f.receipt);
      f.events[0].resolve(f.configured);
      await f.entered[1].promise;
      f.events[1].resolve(f.marker());
      await f.delivery.ready.promise;
      // Observe all runnable work while delivery is held; this is not a fence.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled.value).toBe(false);
      expect(f.native._next_native_mcp_result).not.toHaveBeenCalled();
      f.delivery.release.resolve();
      await opening;
      expect(settled.value).toBe(true);
      expect(f.native._next_native_mcp_result).toHaveBeenCalledTimes(1);
      await f.close();
      expect(f.cleanup).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
      await opening.catch(() => {});
    }
  });

  it('preserves the reader failure while awaiting the publication boundary', async () => {
    const f = startupFixture();
    const original = new Error('reader failed before publication boundary');
    const opening = f.session._start().then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    try {
      f.publication.resolve(f.receipt);
      f.events[0].resolve(f.configured);
      await f.entered[1].promise;
      f.events[1].reject(original);
      expect((await opening).error).toBe(original);
      await f.close();
      expect(f.cleanup).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
      await opening;
    }
  });

  it('rejects close while awaiting the boundary and joins the in-flight reader', async () => {
    const f = startupFixture();
    const opening = f.session._start().then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    try {
      f.publication.resolve(f.receipt);
      f.events[0].resolve(f.configured);
      await f.entered[1].promise;
      const closed = { value: false };
      const closing = f.session.close().then(() => {
        closed.value = true;
      });
      expect((await opening).error).toMatchObject({
        message: 'Session closed while opening',
      });
      await f.closingEntered.promise;
      f.engineClosed.resolve(null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed.value).toBe(false);
      expect(f.cleanup).not.toHaveBeenCalled();
      f.events[1].resolve(f.shutdown);
      await closing;
      expect(f.native._finish_child_event_reader).toHaveBeenCalledTimes(1);
      expect(f.cleanup).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
      await opening;
    }
  });
});

// Configuration checks do not establish native admission or process lifetime.
it('keeps child questions opt-in and captures the supplied setting', () => {
  expect(new NativeAgents().interactions).toBe(false);
  const options = { interactions: true };
  const children = new NativeAgents(options);
  options.interactions = false;
  expect(children.interactions).toBe(true);
  expect(() => new NativeAgents({ interactions: 'yes' as never })).toThrow(
    /must be a boolean/,
  );
});

it('selects turn ownership per stdio server without changing persistent peers', () => {
  const options = {
    name: 'interactive',
    tools: ['ask'],
    command: 'node',
    lifetime: 'turn' as 'turn' | 'session',
  };
  const interactive = new StdioMCP(options);
  options.lifetime = 'session';
  const persistent = new StdioMCP({
    name: 'persistent',
    tools: ['read'],
    command: 'node',
  });
  const explicit = new StdioMCP({
    name: 'explicit',
    tools: ['read'],
    command: 'node',
    lifetime: 'session',
  });
  const http = new HttpMCP({
    name: 'http',
    tools: ['read'],
    url: 'http://127.0.0.1:1/mcp',
  });
  const config = mcpConfig([interactive, persistent, explicit, http]);
  expect(config.interactive).toHaveProperty('sdk_turn_scoped_stdio', true);
  for (const name of ['persistent', 'explicit', 'http']) {
    expect(config[name]).not.toHaveProperty('sdk_turn_scoped_stdio');
  }
  expect(interactive.lifetime).toBe('turn');
  expect(persistent.lifetime).toBe('session');
});

it('recomputes lifetime for a replacement roster and supports environment stdio', () => {
  const environment = new Environment({
    url: 'wss://127.0.0.1:1',
    cwd: '/workspace',
  });
  const options = {
    name: 'records',
    tools: ['read'],
    command: 'node',
    location: 'environment' as const,
  };
  const first = mcpConfig(
    [new StdioMCP({ ...options, lifetime: 'turn' })],
    environment,
  );
  expect(first.records).toMatchObject({
    sdk_turn_scoped_stdio: true,
    environment_id: 'remote',
  });
  const replacement = mcpConfig([new StdioMCP(options)], environment);
  expect(replacement.records).not.toHaveProperty('sdk_turn_scoped_stdio');
  expect(replacement.records).toHaveProperty('environment_id', 'remote');
});

it('rejects unsupported stdio lifetime before starting a server', () => {
  expect(
    () =>
      new StdioMCP({
        name: 'records',
        tools: ['read'],
        command: '/does-not-exist',
        lifetime: 'forever' as never,
      }),
  ).toThrow(/lifetime/);
});

describe('URL completion observers', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });
  afterEach(() => vi.useRealTimers());

  it('serializes concurrent reads of the original native completion receipt', async () => {
    let release!: (value: boolean) => void;
    const receipt = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const read = vi.fn(() => receipt);
    const completion = createUrlCompletion(async () => {}, read);
    const first = completion.wait({ timeoutMs: 100 });
    const second = completion.wait({ timeoutMs: 100 });
    await Promise.resolve();
    expect(read).toHaveBeenCalledOnce();
    release(true);
    await Promise.all([first, second]);
    await completion.wait({ timeoutMs: 100 });
    expect(read).toHaveBeenCalledOnce();
  });

  it('retires at the deadline while a probe is in flight and ignores its late success', async () => {
    let finishProbe!: (value: boolean) => void;
    const probe = new Promise<boolean>((resolve) => {
      finishProbe = resolve;
    });
    const cancel = vi.fn(async () => {});
    const completion = createUrlCompletion(cancel, () => probe);
    const waiting = completion.wait({ timeoutMs: 10 });
    const assertion = expect(waiting).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(completion.expired()).toBe(true);
    finishProbe(true);
    await completion.refresh();
    await Promise.resolve();
    await expect(completion.wait({ timeoutMs: 100 })).rejects.toThrow(
      'expired',
    );
    await completion.retire();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('retains early peer completion while consent is prepared and delivered once', async () => {
    const cancel = vi.fn(async () => {});
    const completion = createUrlCompletion(cancel);
    const grant = issueNativeQuestion(
      {
        type: 'elicitation_request',
        sessionId: 'session',
        subagentId: null,
        submissionId: null,
        turnId: null,
        description: 'private URL message',
        call: null,
      },
      urlQuestionReply({ server_name: 'peer' }, '9223372036854775807'),
      () => true,
      undefined,
      urlQuestionPresentation(
        {
          serverName: 'peer',
          elicitationId: 'completion',
          url: 'https://example.invalid/private',
        },
        completion.wait,
      ),
    );
    const request = grant.request;
    if (request.type !== 'elicitation_request') throw new Error('fixture');
    completion.settle(true);
    const consent = request.replyUrlAccept();
    expect(grant.take(consent)).toBe(
      '{"server_name":"peer","kind":"accept_url_elicitation","request_id":9223372036854775807}',
    );
    expect(() => grant.take(consent)).toThrow();
    await expect(
      request.waitForCompletion({ timeoutMs: 100 }),
    ).resolves.toBeUndefined();
    expect(request.turnId).toBeNull();
    expect(request.mode).toBe('url');
    expect(Object.isFrozen(request)).toBe(true);
    expect(request.url).toContain('/private');
    expect(JSON.stringify(request)).not.toContain('private');
    expect(Object.keys(request)).not.toContain('serverName');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('keeps the legacy null decline and rejects form content for URLs', () => {
    const encode = urlQuestionReply({ server_name: 'peer' }, '"original"');
    expect(JSON.parse(encode(null))).toEqual({
      kind: 'decline_elicitation',
      server_name: 'peer',
      request_id: 'original',
    });
    expect(() => encode({ accepted: true })).toThrow('replyUrlAccept');
  });

  it('does not let a variant replace the common reply or identity', () => {
    expect(() =>
      issueNativeQuestion(
        {
          type: 'approval_request',
          sessionId: 'session',
          subagentId: null,
          submissionId: 'submission',
          turnId: 'turn',
          description: '',
          call: null,
        },
        () => '{}',
        () => true,
        undefined,
        (target) =>
          Object.defineProperty(target, 'reply', { value: () => '{}' }),
      ),
    ).toThrow(TypeError);
  });

  it('isolates a canceled observer from other observers and the native owner', async () => {
    const cancel = vi.fn(async () => {});
    const completion = createUrlCompletion(cancel);
    const controller = new AbortController();
    const reason = new Error('observer stopped');
    const canceled = completion.wait({
      timeoutMs: 100,
      signal: controller.signal,
    });
    const other = completion.wait({ timeoutMs: 100 });
    controller.abort(reason);
    await expect(canceled).rejects.toBe(reason);
    expect(cancel).not.toHaveBeenCalled();
    completion.settle(true);
    await expect(other).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('joins timeout retirement and refuses completion that arrives afterward', async () => {
    let release!: () => void;
    const joined = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancel = vi.fn(() => joined);
    const completion = createUrlCompletion(cancel);
    const result = completion.wait({ timeoutMs: 10 });
    const assertion = expect(result).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(cancel).toHaveBeenCalledOnce();
    completion.settle(true);
    release();
    await assertion;
    await expect(completion.wait({ timeoutMs: 10 })).rejects.toThrow('expired');
    await completion.retire();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('keeps a distinct retirement failure in the timeout error', async () => {
    const cause = new Error('native cancellation failed');
    const completion = createUrlCompletion(async () => {
      throw cause;
    });
    const result = completion.wait({ timeoutMs: 1 });
    const assertion = expect(result).rejects.toMatchObject({
      errors: [expect.objectContaining({ name: 'TimeoutError' }), cause],
    });
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it('does not clamp a long finite deadline to an immediate timeout', async () => {
    const completion = createUrlCompletion(async () => {});
    const result = completion.wait({ timeoutMs: 2_147_483_648 });
    await vi.advanceTimersByTimeAsync(1);
    expect(completion.pending()).toBe(true);
    completion.settle(true);
    await result;
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid deadline %s',
    async (timeoutMs) => {
      const completion = createUrlCompletion(async () => {});
      await expect(completion.wait({ timeoutMs })).rejects.toThrow(
        'positive finite',
      );
    },
  );
});
