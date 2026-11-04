import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createManualRequest, manualTool } from '../src/runtime/manual';
import { parseEvents } from '../src/runtime/events';
import { encodeReceipt } from '../src/runtime/binding';
import {
  issueTurn,
  type Completed,
  type PendingRequests,
  type RequestWaitOptions,
  type Turn,
} from '../src/runtime/session';

// Pure handle/authority tests. No native liveness is claimed by these fixtures.
describe('request wait handle contract', () => {
  it('decodes original snapshot event strings without rounding native authority or changing application fields', () => {
    // Decoder-only wire fixture; it does not issue a live native grant.
    const original =
      '{"id":"call","msg":{"type":"dynamic_tool_call_request","turnId":"turn","callId":"call","tool":"decision","arguments":{"generation":-2,"nonce":"application-nonce","delivery":1.5,"nested":{"generation":"application-generation"}},"_sdk_python_tool":{"thread":"root","generation":18446744073709551614,"slot":0,"manual_grant":"fixture-marker"}}}';
    const [event] = parseEvents(JSON.stringify([original]));
    expect(event.msg._sdk_python_tool?.generation).toBe('18446744073709551614');
    expect(event.msg.arguments).toEqual({
      generation: -2,
      nonce: 'application-nonce',
      delivery: 1.5,
      nested: { generation: 'application-generation' },
    });
    const receipt = encodeReceipt({
      request: event.msg,
      response: {
        success: true,
        contentItems: [{ type: 'inputText', text: 'accepted' }],
      },
    });
    expect(receipt).toContain('"generation":18446744073709551614');
    expect(receipt).toContain('"generation":-2');
    expect(receipt).toContain('"delivery":1.5');
    expect(() => parseEvents(JSON.stringify([JSON.parse(original)]))).toThrow();
  });
  it('passes the exact queued handle and caller options to its request observer', async () => {
    const pending = Promise.withResolvers<Completed<number>>();
    const completion = vi.fn(() => pending.promise);
    const notify = vi.fn();
    const cancel = vi.fn(async () => {});
    const declaration = manualTool({
      name: 'decision',
      description: '',
      parameters: z.object({}),
      result: z.string(),
    });
    const authority = createManualRequest(
      declaration,
      {
        sessionId: 'session',
        submissionId: 'submission',
        subagentId: null,
        turnId: 'admitted-turn',
        callId: 'call',
      },
      {},
      () => true,
    );
    const request = authority.request();
    if (!request) throw new Error('Expected an issued manual request');
    let id: string | null = null;
    const observe = vi.fn(
      async (
        turn: Turn<number, string | null>,
        _options: RequestWaitOptions,
        _completion: { promise: Promise<Completed<number>> },
      ): Promise<PendingRequests<number, string | null>> => {
        id = 'admitted-turn';
        return Object.freeze({ turn, requests: Object.freeze([request]) });
      },
    );
    const turn = issueTurn<number, string | null>(
      'session',
      () => id,
      'submission',
      completion,
      async function* () {},
      async () => {},
      cancel,
      undefined,
      { notify, rateLimits: () => ({}), wait: observe },
    );
    const controller = new AbortController();
    const options = { until: 'request', signal: controller.signal } as const;
    expect(turn.turnId).toBeNull();
    const outcome = await turn.wait(options);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0][0]).toBe(turn);
    expect(observe.mock.calls[0][1]).toBe(options);
    expect(outcome.turn).toBe(turn);
    expect(outcome.turn.turnId).toBe('admitted-turn');
    expect(cancel).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('tracks one completion across repeated request waits and preserves the result identity', async () => {
    const pending = Promise.withResolvers<Completed>();
    const completion = vi.fn(() => pending.promise);
    const notify = vi.fn();
    const states: Array<{ promise: Promise<Completed>; outcome?: unknown }> =
      [];
    const observe = vi.fn(
      async (
        _turn: Turn,
        _options: RequestWaitOptions,
        state: { promise: Promise<Completed>; outcome?: unknown },
      ) => {
        states.push(state);
        return state.promise;
      },
    );
    const turn = issueTurn(
      'session',
      'turn',
      'submission',
      completion,
      async function* () {},
      async () => {},
      async () => {},
      undefined,
      { notify, rateLimits: () => ({}), wait: observe },
    );
    const first = turn.wait({ until: 'request' });
    const second = turn.wait({ until: 'request' });
    const ordinary = turn.wait();
    const result: Completed = Object.freeze({
      turn,
      finalOutput: 'done',
      usage: null,
      repairAttempts: [],
    });
    pending.resolve(result);
    expect(await first).toBe(result);
    expect(await second).toBe(result);
    expect(await ordinary).toBe(result);
    expect(await turn.wait()).toBe(result);
    // Re-enter the completion owner on every call to preserve callback guards;
    // the shared settlement tracker and notification still attach only once.
    expect(completion).toHaveBeenCalledTimes(4);
    expect(states[0]).toBe(states[1]);
    expect(states[0].outcome).toEqual({ status: 'fulfilled', value: result });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('retains the same rejection for every observer and records it before settlement', async () => {
    const pending = Promise.withResolvers<Completed>();
    const failure = new Error('captured failure');
    const notify = vi.fn();
    let state: { promise: Promise<Completed>; outcome?: unknown } | undefined;
    const turn = issueTurn(
      'session',
      'turn',
      'submission',
      () => pending.promise,
      async function* () {},
      async () => {},
      async () => {},
      undefined,
      {
        notify,
        rateLimits: () => ({}),
        async wait(_turn, _options, completion) {
          state = completion;
          return completion.promise;
        },
      },
    );
    const requestFailure = turn
      .wait({ until: 'request' })
      .catch((error: unknown) => error);
    const normalFailure = turn.wait().catch((error: unknown) => error);
    pending.reject(failure);
    expect(await requestFailure).toBe(failure);
    expect(await normalFailure).toBe(failure);
    expect(state?.outcome).toEqual({ status: 'rejected', reason: failure });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('keeps declaration matching and one-shot reply authority when a request has multiple readers', () => {
    const parse = vi.fn((value: string) => value.length);
    const declaration = manualTool({
      name: 'decision',
      description: '',
      parameters: z.object({ value: z.string().transform(parse) }),
      result: z.string(),
    });
    const authority = createManualRequest(
      declaration,
      {
        sessionId: 'session',
        submissionId: 'submission',
        subagentId: null,
        turnId: 'turn',
        callId: 'call',
      },
      { value: 'captured' },
      () => true,
    );
    const first = declaration.match(authority.request());
    const second = declaration.match(authority.request());
    if (!first || !second)
      throw new Error('Expected two issued request readers');
    expect(first.arguments).toEqual({ value: 8 });
    expect(second.arguments).toEqual({ value: 8 });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(declaration.match({ ...first })).toBeUndefined();
    expect(authority.takeReply(first.reply('accepted'))).toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: 'accepted' }],
    });
    expect(authority.takeReply(second.reply('duplicate'))).toBeUndefined();
    expect(authority.request()).toBeUndefined();
  });
});
