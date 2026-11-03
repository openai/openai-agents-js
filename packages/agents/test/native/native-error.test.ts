import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  NativeError,
  InteractionRequired,
  type NativeErrorOptions,
} from '../../src';
import {
  NativeError as SessionNativeError,
  TurnAborted,
  TurnNotSubmitted,
} from '../../src/runtime/session';
import {
  enrichNativeError,
  nativeError,
  markNativeErrorNotStarted,
} from '../../src/runtime/native-error';
import { issueChildTurn } from '../../src/runtime/subagents';
import type { _NativeChildTurn } from '../../native';

function fields(error: NativeError) {
  return {
    statusCode: error.statusCode,
    code: error.code,
    requestId: error.requestId,
    category: error.category,
  };
}
const absent = {
  statusCode: null,
  code: null,
  requestId: null,
  category: null,
};
const terminal = {
  message: 'terminal rejection',
  codex_error_info: 'Unauthorized',
  _sdk_provider_error: {
    status_code: 401,
    code: 'invalid_api_key',
    request_id: 'synthetic-request',
  },
};

describe('NativeError API and native conversion', () => {
  it('preserves Error behavior, cause, subclasses, and nullable defaults', () => {
    const cause = new Error('original cause');
    const error = new NativeError('public message', { cause });
    expect(NativeError).toBe(SessionNativeError);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('public message');
    expect(error.name).toBe('NativeError');
    expect(error.cause).toBe(cause);
    expect(error.stack).toContain('NativeError: public message');
    expect(fields(error)).toEqual(absent);
    expect(error.retryable).toBeNull();
    expect(error.retryAfterMs).toBeNull();
    for (const child of [
      new InteractionRequired(),
      new TurnAborted('stopped', { cause }),
      new TurnNotSubmitted({ type: 'superseded' }),
    ]) {
      expect(child).toBeInstanceOf(NativeError);
      expect(child.name).toBe(child.constructor.name);
      expect(fields(child)).toEqual(absent);
    }
    expect('body' in error).toBe(false);
    expect('response' in error).toBe(false);
    expect('headers' in error).toBe(false);
    expect(error.effects).toBe('unknown');
    for (const child of [
      new TurnAborted('stopped'),
      new TurnNotSubmitted('uncertain'),
    ])
      expect(child.effects).toBe('unknown');
  });

  it('preserves proved operation effects through provider enrichment without replacing the error', () => {
    const cause = new Error('cause');
    const error = new NativeError('native refusal', { cause });
    const stack = error.stack;
    expect(markNativeErrorNotStarted(error)).toBe(error);
    expect(error.effects).toBe('notStarted');
    enrichNativeError(error, terminal);
    expect(error.effects).toBe('notStarted');
    expect(error.statusCode).toBe(401);
    enrichNativeError(error, { effects: 'recorded' });
    expect(error.effects).toBe('notStarted');
    expect(error.cause).toBe(cause);
    expect(error.stack).toBe(stack);
    const refusal = new TurnNotSubmitted('rejected');
    expect(markNativeErrorNotStarted(refusal)).toBe(refusal);
    expect(refusal).toBeInstanceOf(TurnNotSubmitted);
    expect(refusal.effects).toBe('notStarted');
    expect(
      nativeError({
        effects: 'notStarted',
        _sdk_provider_error: { retryable: true },
      }).effects,
    ).toBe('unknown');
    expect(Reflect.set(error, 'effects', 'recorded')).toBe(false);
    expectTypeOf(error.effects).toEqualTypeOf<
      'unknown' | 'notStarted' | 'recorded'
    >();
  });

  it('captures constructor options and exposes readonly nullable fields', () => {
    expectTypeOf<NativeErrorOptions>().toExtend<ErrorOptions>();
    const cause = new Error('cause');
    const options: NativeErrorOptions = {
      statusCode: 401,
      code: 'host_code',
      requestId: 'host-request',
      category: 'host_category',
      cause,
    };
    const error = new NativeError('host message', options);
    options.statusCode = 500;
    expect(fields(error)).toEqual({
      statusCode: 401,
      code: 'host_code',
      requestId: 'host-request',
      category: 'host_category',
    });
    expect(error.cause).toBe(cause);
    expectTypeOf(error.statusCode).toEqualTypeOf<number | null>();
    expectTypeOf(error.code).toEqualTypeOf<string | null>();
    expectTypeOf(error.requestId).toEqualTypeOf<string | null>();
    expectTypeOf(error.category).toEqualTypeOf<string | null>();
    expectTypeOf(error.retryable).toEqualTypeOf<boolean | null>();
    expectTypeOf(error.retryAfterMs).toEqualTypeOf<number | null>();
    expect(() => {
      // @ts-expect-error Metadata is readonly in the public API.
      error.statusCode = 400;
    }).toThrow(TypeError);
    expect(Reflect.set(error, 'code', 'replacement')).toBe(false);
    expect(Reflect.set(error, 'requestId', 'replacement')).toBe(false);
    expect(Reflect.set(error, 'category', 'replacement')).toBe(false);
    expect(Reflect.set(error, 'retryable', true)).toBe(false);
    expect(Reflect.set(error, 'retryAfterMs', 100)).toBe(false);
    expect(() => {
      // @ts-expect-error Effects are readonly in the public API.
      error.effects = 'recorded';
    }).toThrow(TypeError);
  });

  it('retains retry advice independently of HTTP diagnostics and clears stale advice', () => {
    const options = { retryable: false, retryAfterMs: 0 };
    const error = new NativeError('original', options);
    options.retryable = true;
    options.retryAfterMs = 1000;
    expect(error.retryable).toBe(false);
    expect(error.retryAfterMs).toBe(0);
    const stack = error.stack;
    enrichNativeError(error, {
      codex_error_info: 'ServerOverloaded',
      _sdk_provider_error: { retryable: true, retry_after_ms: 1200 },
    });
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(1200);
    expect(error.statusCode).toBeNull();
    enrichNativeError(error, {
      codex_error_info: 'BadRequest',
      _sdk_provider_error: { retryable: false, retry_after_ms: 0 },
    });
    expect(error.retryable).toBe(false);
    expect(error.retryAfterMs).toBe(0);
    enrichNativeError(error, { codex_error_info: 'Other' });
    expect(error.retryable).toBeNull();
    expect(error.retryAfterMs).toBeNull();
    expect(error.message).toBe('original');
    expect(error.stack).toBe(stack);
  });

  it('does not interpret malformed native retry advice', () => {
    const error = nativeError({
      _sdk_provider_error: { retryable: 'true', retry_after_ms: -1 },
    });
    expect(error.retryable).toBeNull();
    expect(error.retryAfterMs).toBeNull();
  });

  it('replaces complete metadata snapshots without changing identity, message, stack, or cause', () => {
    const cause = new Error('retained cause');
    const early = nativeError(
      { codex_error_info: 'Other' },
      'early native message',
      { cause },
    );
    const stack = early.stack;
    enrichNativeError(early, terminal);
    expect(fields(early)).toEqual({
      statusCode: 401,
      code: 'invalid_api_key',
      requestId: 'synthetic-request',
      category: 'authentication_error',
    });
    enrichNativeError(early, { codex_error_info: 'UsageLimitExceeded' });
    expect(fields(early)).toEqual({
      ...absent,
      category: 'usage_limit_exceeded',
    });
    enrichNativeError(early, null);
    expect(fields(early)).toEqual(absent);
    expect(early.message).toBe('early native message');
    expect(early.stack).toBe(stack);
    expect(early.cause).toBe(cause);
  });

  it('keeps the original terminal-only JSON message separate from private metadata', () => {
    const error = nativeError(terminal);
    expect(error.message).toBe(
      JSON.stringify({
        message: terminal.message,
        codex_error_info: terminal.codex_error_info,
      }),
    );
    expect(error.message).not.toContain('_sdk_provider_error');
    expect(error.message).not.toContain('synthetic-request');
    expect(fields(error)).toEqual({
      statusCode: 401,
      code: 'invalid_api_key',
      requestId: 'synthetic-request',
      category: 'authentication_error',
    });
  });

  it.each([
    ['ContextWindowExceeded', 'context_length_exceeded'],
    ['BadRequest', 'invalid_request'],
    ['InternalServerError', 'server_error'],
    ['ThreadRollbackFailed', 'server_error'],
    ['Other', 'internal_error'],
    ['RateLimitExceeded', 'rate_limit_exceeded'],
    [
      { HttpConnectionFailed: { http_status_code: 401 } },
      'authentication_error',
    ],
    [
      { ResponseStreamDisconnected: { http_status_code: 503 } },
      'server_overloaded',
    ],
    [
      { ResponseStreamConnectionFailed: { http_status_code: 418 } },
      'invalid_request',
    ],
    [
      { ResponseTooManyFailedAttempts: { http_status_code: 502 } },
      'server_error',
    ],
    [
      { ResponseStreamDisconnected: { http_status_code: 200 } },
      'connection_failed',
    ],
    [
      { ResponseTooManyFailedAttempts: { http_status_code: true } },
      'server_error',
    ],
    [{ HttpConnectionFailed: { http_status_code: true } }, 'connection_failed'],
    ['UnknownFutureCategory', null],
    [{ Unauthorized: null, Other: null }, null],
    [[], null],
    [null, null],
  ])(
    'normalizes native category %j without inventing an observed status',
    (info, expected) => {
      const error = nativeError({ codex_error_info: info }, 'message');
      expect(error.category).toBe(expected);
      expect(error.statusCode).toBeNull();
    },
  );

  it('ignores malformed native metadata and never parses status-looking display text or bodies', () => {
    const display =
      'unexpected status 401; invalid_api_key; request id fabricated';
    const error = nativeError(
      {
        message: display,
        body: JSON.stringify(terminal),
        _sdk_provider_error: {
          status_code: '401',
          code: 'invalid\ncode',
          request_id: 'bad request id',
        },
      },
      display,
    );
    expect(fields(error)).toEqual(absent);
    expect(fields(new NativeError(display))).toEqual(absent);
    expect(
      fields(
        nativeError(
          {
            _sdk_provider_error: {
              status_code: true,
              code: 'x'.repeat(129),
              request_id: 'r'.repeat(257),
            },
          },
          display,
        ),
      ),
    ).toEqual(absent);
    expect(
      fields(
        nativeError(
          {
            _sdk_provider_error: {
              status_code: 1000,
              code: { code: 'nested' },
              request_id: '\u0080',
            },
          },
          display,
        ),
      ),
    ).toEqual(absent);
  });
});

describe('exact child error details', () => {
  function child(wait: () => Promise<string>, error: () => string | null) {
    // A controlled binding double tests rejected-Promise/cause and drain order.
    // Real provider and native receipt correlation have separate integration tests.
    return {
      session_id: 'session',
      child_id: 'child',
      incarnation: 'instance',
      instance_id: '1',
      turn_id: 'turn',
      wait_with_usage: wait,
      terminal_error: error,
    } as _NativeChildTurn;
  }

  it('preserves the original N-API cause and message while reading cached terminal metadata', async () => {
    const cause = Object.assign(new Error('Native child turn failed'), {
      code: 'GenericFailure',
    });
    let drained = false;
    const turn = issueChildTurn(
      child(
        () => Promise.reject(cause),
        () => JSON.stringify(terminal),
      ),
      {
        beforeWait() {},
        async *observations() {},
        async drain() {
          drained = true;
        },
      },
    );
    const error = await turn.wait().catch((value: unknown) => value);
    expect(drained).toBe(true);
    expect(error).toBeInstanceOf(NativeError);
    expect((error as NativeError).cause).toBe(cause);
    expect((error as NativeError).message).toBe(cause.message);
    expect(fields(error as NativeError)).toEqual({
      statusCode: 401,
      code: 'invalid_api_key',
      requestId: 'synthetic-request',
      category: 'authentication_error',
    });
  });

  it('retains null metadata when the exact child has no terminal details', async () => {
    const cause = new Error('runtime failure');
    const turn = issueChildTurn(
      child(
        () => Promise.reject(cause),
        () => null,
      ),
      { beforeWait() {}, async *observations() {}, async drain() {} },
    );
    const error = await turn.wait().catch((value: unknown) => value);
    expect((error as NativeError).cause).toBe(cause);
    expect(fields(error as NativeError)).toEqual(absent);
  });

  it('preserves callback-drain failure precedence over the native rejection', async () => {
    const cause = new Error('native rejection');
    const cleanup = new NativeError('callback cleanup', {
      category: 'host_cleanup',
    });
    const turn = issueChildTurn(
      child(
        () => Promise.reject(cause),
        () => JSON.stringify(terminal),
      ),
      {
        beforeWait() {},
        async *observations() {},
        async drain() {
          throw cleanup;
        },
      },
    );
    await expect(turn.wait()).rejects.toBe(cleanup);
    expect(fields(cleanup)).toEqual({ ...absent, category: 'host_cleanup' });
  });
});

// Controlled native receipt tests: SDK interpretation, not native execution proof.
async function admissionSession(submit: () => Promise<string>) {
  const { Session } = await import('../../src/runtime/session');
  const { captureTools } = await import('../../src/runtime/tools');
  const ended = Promise.withResolvers<string>();
  const session = new Session(
    {
      _close_report: async () => null,
    } as unknown as import('../../src/runtime/binding').Engine,
    {
      id: 'effects-session',
      _submit: submit,
      _next_session_event: () => ended.promise,
      _finish_child_event_reader: () => {},
      _close_report: async () => {
        ended.reject(new Error('reader closed'));
        return null;
      },
    } as unknown as import('../../src/runtime/binding').NativeThread,
    captureTools([]),
    {},
    {},
  );
  await session._start();
  return session;
}

it('marks only a decoded admission rejection, not an uncertain transport failure', async () => {
  for (const rejected of [true, false]) {
    const transport = new NativeError('transport uncertain');
    const session = await admissionSession(async () => {
      if (!rejected) throw transport;
      return JSON.stringify({ status: 'not_submitted', reason: 'busy' });
    });
    try {
      const error = await session
        .submit('input')
        .catch((error: unknown) => error);
      if (rejected) {
        expect(error).toBeInstanceOf(TurnNotSubmitted);
        expect((error as NativeError).effects).toBe('notStarted');
      } else {
        expect(error).toBe(transport);
        expect(transport.effects).toBe('unknown');
      }
    } finally {
      await session.close();
    }
  }
});

it.each(['rejected', 'mismatched', 'transport'] as const)(
  'keeps steering effects scoped to the failed operation: %s',
  async (kind) => {
    let calls = 0;
    const transport = new NativeError('steering transport uncertain');
    const session = await admissionSession(async () => {
      if (++calls === 1)
        return JSON.stringify({ status: 'started', turn_id: 'root' });
      if (kind === 'transport') throw transport;
      return JSON.stringify(
        kind === 'rejected'
          ? { status: 'not_submitted', reason: 'not steerable' }
          : { status: 'steered', turn_id: 'other' },
      );
    });
    try {
      const turn = await session.submit('input');
      const error = await turn.steer('extra').catch((error: unknown) => error);
      expect(error).toBeInstanceOf(NativeError);
      expect((error as NativeError).effects).toBe(
        kind === 'rejected' ? 'notStarted' : 'unknown',
      );
      if (kind === 'transport') expect(error).toBe(transport);
      else expect(error).toBeInstanceOf(TurnNotSubmitted);
    } finally {
      await session.close();
    }
  },
);
