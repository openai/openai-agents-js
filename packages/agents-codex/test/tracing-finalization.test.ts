import { afterAll, beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => {
  const pending: Array<{ callback: (value: unknown) => void; value: unknown }> =
    [];
  let rejectRegistration = false;
  vi.stubGlobal(
    'FinalizationRegistry',
    class {
      constructor(readonly callback: (value: unknown) => void) {}
      register(_target: object, value: unknown) {
        if (rejectRegistration) throw new Error('registration failed');
        pending.push({ callback: this.callback, value });
      }
    },
  );
  const native = {
    retain_trace_context: vi.fn((source: string) => `retained:${source}`),
    release_trace_context: vi.fn(),
    release_trace_span: vi.fn(),
    end_trace_span: vi.fn((_handle: string, _outcome: string) => {}),
  };
  return {
    pending,
    native,
    setReject(value: boolean) {
      rejectRegistration = value;
    },
  };
});
vi.mock('../src/runtime/binding', async (original) => ({
  ...(await original<typeof import('../src/runtime/binding')>()),
  binding: async () => fixture.native,
}));
import { TraceSpan } from '../src/runtime/tracing-context';
const context = {
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  parentSpanId: null,
  disabled: false,
  includeSensitiveData: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  fixture.pending.length = 0;
  fixture.setReject(false);
});
afterAll(() => vi.unstubAllGlobals());
it('keeps the object alias after close and releases it only at finalization', () => {
  const span = new TraceSpan(
    fixture.native as never,
    'span',
    'custom',
    context,
  );
  span.close();
  span.close();
  expect(fixture.native.end_trace_span).toHaveBeenCalledTimes(1);
  expect(fixture.native.release_trace_span).toHaveBeenCalledTimes(1);
  expect(fixture.native.release_trace_context).not.toHaveBeenCalled();
  const lease = span.retain();
  expect(lease).toBe('retained:retained:span');
  span.releaseContext(lease);
  const entry = fixture.pending.shift()!;
  expect(Object.values(entry.value as object)).not.toContain(span);
  entry.callback(entry.value);
  expect(
    fixture.native.release_trace_context.mock.calls.filter(
      ([token]) => token === 'retained:span',
    ),
  ).toHaveLength(1);
  expect(fixture.pending).toHaveLength(0);
});
it.each(['retain', 'register'])(
  'releases the original handle if alias %s fails',
  (phase) => {
    if (phase === 'retain')
      fixture.native.retain_trace_context.mockImplementationOnce(() => {
        throw new Error('retain failed');
      });
    else fixture.setReject(true);
    expect(
      () => new TraceSpan(fixture.native as never, 'span', 'custom', context),
    ).toThrow();
    expect(fixture.native.release_trace_span).toHaveBeenCalledWith('span');
    expect(fixture.native.release_trace_context).toHaveBeenCalledTimes(
      phase === 'register' ? 1 : 0,
    );
  },
);

it('forwards explicitly supplied end data through the existing native privacy boundary', () => {
  const span = new TraceSpan(
    fixture.native as never,
    'payload-span',
    'custom',
    context,
  );
  span.end({ status: 'ok', data: { speech: 'bounded prefix' } });
  span.close();
  expect(fixture.native.end_trace_span).toHaveBeenCalledOnce();
  expect(
    JSON.parse(fixture.native.end_trace_span.mock.calls[0][1]),
  ).toMatchObject({ data: { speech: 'bounded prefix' } });
});
