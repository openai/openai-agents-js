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

  it.each([
    parent.replace('11111111111111111111111111111111', '0'.repeat(32)),
    parent.replace('2222222222222222', '0'.repeat(16)),
    parent.replace('1111', 'ABCD'),
    parent + '-suffix',
    parent.slice(0, -2) + '02',
    'ff' + parent.slice(2),
    parent + '\nprivate',
  ])('rejects malformed parents without echoing values', (traceparent) => {
    expect(() => new TraceContext({ traceparent })).toThrow(
      'Invalid W3C traceparent',
    );
  });

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
      'Invalid W3C tracestate',
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
    ).toThrow('Invalid W3C tracestate');
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
      'Invalid W3C traceparent',
    );
    await expect(agent.run('hello', options)).rejects.toThrow(
      'Invalid W3C traceparent',
    );
  });
});
