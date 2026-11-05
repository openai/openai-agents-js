import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { Agent, NativeProvider, TraceContext } from '../src';
import {
  captureTraceContext,
  nativeTraceContext,
} from '../src/runtime/trace-context';

const parent = '00-11111111111111111111111111111111-2222222222222222-01';

describe('explicit W3C trace carriers', () => {
  it('captures immutable normalized headers and hides values in inspection', () => {
    const headers = {
      traceparent: parent,
      tracestate: ' tenant=value, ,other=x ',
    };
    const context = captureTraceContext(headers)!;
    headers.traceparent = 'changed';
    expect(context.traceparent).toBe(parent);
    expect(context.tracestate).toBe('tenant=value,other=x');
    expect(context.toHeaders()).toEqual({
      traceparent: parent,
      tracestate: 'tenant=value,other=x',
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(new Headers(context.toHeaders()).get('traceparent')).toBe(parent);
    expect(inspect(context)).not.toContain(parent);
    expect(JSON.stringify(context)).toBe('{}');
    expect(captureTraceContext(null)).toBeUndefined();
    expect(captureTraceContext(context)).toBe(context);
  });

  it('captures each accessor once and retains the validated header snapshot', () => {
    let parentReads = 0;
    let stateReads = 0;
    const context = new TraceContext({
      get traceparent() {
        return ++parentReads === 1 ? parent : 'invalid-after-first-read';
      },
      get tracestate() {
        return ++stateReads === 1 ? ' tenant=value ' : 'invalid';
      },
    });
    expect(context.toHeaders()).toEqual({
      traceparent: parent,
      tracestate: 'tenant=value',
    });
    expect(parentReads).toBe(1);
    expect(stateReads).toBe(1);
  });

  it.each([
    parent.replace('11111111111111111111111111111111', '0'.repeat(32)),
    parent.replace('2222222222222222', '0'.repeat(16)),
    parent.replace('1111', 'ABCD'),
    parent + '-suffix',
    'ff' + parent.slice(2),
    parent + '\nprivate',
  ])('rejects malformed parents without echoing values', (traceparent) => {
    expect(() => new TraceContext({ traceparent })).toThrow(
      'Invalid or unsupported native traceparent',
    );
  });

  it('omits absent tracestate and keeps the carrier compatible with Headers', () => {
    const headers = new TraceContext({ traceparent: parent }).toHeaders();
    expect(headers.tracestate).toBeUndefined();
    expect(Object.hasOwn(headers, 'tracestate')).toBe(false);
    expect(new Headers(headers).get('tracestate')).toBeNull();
  });

  it.each(['00', '01', '02', '03'])(
    'round-trips defined trace flags %s',
    (flags) => {
      const value = parent.slice(0, -2) + flags;
      expect(new TraceContext({ traceparent: value }).toHeaders()).toEqual({
        traceparent: value,
      });
    },
  );

  it.each(['04', '09'])(
    'rejects trace flags %s outside the documented native profile',
    (flags) => {
      expect(
        () => new TraceContext({ traceparent: parent.slice(0, -2) + flags }),
      ).toThrow('Invalid or unsupported native traceparent');
    },
  );

  it('retains the known W3C prefix of future versions', () => {
    const future = '01' + parent.slice(2) + '-opaque';
    expect(new TraceContext({ traceparent: future }).traceparent).toBe(future);
  });

  it.each([
    'a=x,a=y',
    'a=x=y',
    'Upper=x',
    'a\n=x',
    'a=private\n',
    'a=' + 'x'.repeat(257),
    'a=x,'.repeat(33),
  ])('rejects malformed tracestate', (tracestate) => {
    expect(() => new TraceContext({ traceparent: parent, tracestate })).toThrow(
      'Invalid or unsupported native tracestate',
    );
  });

  it('accepts bounded tracestate beyond 512 characters and native tenant limits', () => {
    const state =
      'tenant@abcdefghijklm=' + 'x'.repeat(256) + ',other=' + 'y'.repeat(256);
    expect(
      new TraceContext({ traceparent: parent, tracestate: state }).tracestate,
    ).toBe(state);
    expect(
      () =>
        new TraceContext({
          traceparent: parent,
          tracestate: 'tenant@abcdefghijklmn=x',
        }),
    ).toThrow('Invalid or unsupported native tracestate');
  });

  it('keeps invalid optional native metadata from failing callback admission', () => {
    expect(nativeTraceContext({ traceparent: 'invalid' })).toBeUndefined();
    expect(nativeTraceContext(undefined)).toBeUndefined();
    expect(nativeTraceContext({ traceparent: parent })?.traceparent).toBe(
      parent,
    );
  });

  it('rejects unsupported carrier headers', () => {
    expect(() =>
      captureTraceContext({ traceparent: parent, baggage: 'private' } as never),
    ).toThrow('optional tracestate only');
  });

  it('validates public opening and convenience run before provider acquisition', async () => {
    class UnusedProvider extends NativeProvider {
      override _acquire(): never {
        throw new Error('provider must not be acquired');
      }
    }
    const agent = new Agent({
      instructions: 'fixture',
      provider: new UnusedProvider({ apiKey: 'fixture' }),
    });
    const options = { parentTrace: { traceparent: 'private-invalid' } };
    await expect(agent.session(options)).rejects.toThrow(
      'Invalid or unsupported native traceparent',
    );
    await expect(agent.run('hello', options)).rejects.toThrow(
      'Invalid or unsupported native traceparent',
    );
  });
});
