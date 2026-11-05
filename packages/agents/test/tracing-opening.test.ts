import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  native: {
    start_trace_span: vi.fn(() =>
      JSON.stringify({
        handle: 'opening',
        trace_id: '1'.repeat(32),
        span_id: '2'.repeat(16),
        parent_span_id: null,
        workflow_span_id: null,
        disabled: false,
        include_sensitive_data: false,
      }),
    ),
    end_trace_span: vi.fn(),
    retain_trace_context: vi.fn(() => 'opening-alias'),
    release_trace_context: vi.fn(),
    release_trace_span: vi.fn(),
  },
  open: vi.fn(),
}));
vi.mock('../src/runtime/binding', async (original) => ({
  ...(await original<typeof import('../src/runtime/binding')>()),
  binding: async () => fixture.native,
}));
vi.mock('../src/runtime/agent', () => ({
  openSession: (...args: unknown[]) => fixture.open(...args),
  runOwnedSession: vi.fn(),
}));
import { Agent } from '../src/runtime/public-agent';

beforeEach(() => vi.clearAllMocks());
it.each([
  'prepare failure',
  'before construction',
  'partial construction',
  'cleanup failure',
  'success',
] as const)('settles opening tracing once after %s', async (phase) => {
  const openingError = new Error('synthetic opening failure');
  const cleanupError = new Error('synthetic cleanup failure');
  const sessionOptions = {
    onClose: vi.fn(async () => {
      if (phase === 'cleanup failure') throw cleanupError;
    }),
  };
  const session = { close: () => sessionOptions.onClose() };
  const agent = new Agent({ instructions: 'synthetic', model: 'gpt-5.5' });
  const prepare = vi.spyOn(
    agent as unknown as { prepare: (...args: unknown[]) => Promise<unknown> },
    'prepare',
  );
  const lease = {
    async failOpening(error: unknown): Promise<never> {
      if (phase === 'partial construction' || phase === 'cleanup failure') {
        try {
          await sessionOptions.onClose();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'Opening cleanup failed', {
            cause: error,
          });
        }
      }
      throw error;
    },
    openingSucceeded() {},
  };
  if (phase === 'prepare failure') prepare.mockRejectedValue(openingError);
  else
    prepare.mockResolvedValue({
      setup: {},
      session: sessionOptions,
      lease,
      environmentOwner: { signal: new AbortController().signal, opened() {} },
    });
  fixture.open.mockImplementation(async () => {
    if (phase !== 'success') throw openingError;
    return session;
  });
  const result = agent.session({ tracing: { name: 'opening' } });
  if (phase === 'success') {
    expect(await result).toBe(session);
    expect(fixture.native.end_trace_span).not.toHaveBeenCalled();
    await session.close();
    await session.close();
  } else if (phase === 'cleanup failure') {
    await expect(result).rejects.toMatchObject({
      cause: openingError,
      errors: [openingError, cleanupError],
    });
  } else await expect(result).rejects.toBe(openingError);
  await vi.waitFor(() =>
    expect(fixture.native.release_trace_span).toHaveBeenCalledTimes(1),
  );
  expect(fixture.native.end_trace_span).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(fixture.native.end_trace_span.mock.calls[0]![1] as string)
      .status,
  ).toBe(phase === 'success' ? 'ok' : 'error');
});

it('rejects invalid trace startup before native Session construction', async () => {
  const error = new Error('invalid native tracing options');
  fixture.native.start_trace_span.mockImplementationOnce(() => {
    throw error;
  });
  const agent = new Agent({ instructions: 'synthetic', model: 'gpt-5.5' });
  const failed = vi.fn(async (cause: unknown): Promise<never> => {
    throw cause;
  });
  vi.spyOn(
    agent as unknown as { prepare: (...args: unknown[]) => Promise<unknown> },
    'prepare',
  ).mockResolvedValue({
    setup: {},
    session: {},
    lease: { failOpening: failed },
    environmentOwner: { signal: new AbortController().signal },
  });
  fixture.open.mockResolvedValue({});
  await expect(agent.session({ tracing: { name: '' } })).rejects.toBe(error);
  expect(fixture.open).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledWith(error);
});

it('records an undefined opening rejection as error without replacing it', async () => {
  const agent = new Agent({ instructions: 'synthetic', model: 'gpt-5.5' });
  vi.spyOn(
    agent as unknown as { prepare: (...args: unknown[]) => Promise<unknown> },
    'prepare',
  ).mockRejectedValue(undefined);
  await expect(
    agent.session({ tracing: { name: 'undefined rejection' } }),
  ).rejects.toBeUndefined();
  await vi.waitFor(() =>
    expect(fixture.native.end_trace_span).toHaveBeenCalledTimes(1),
  );
  expect(
    JSON.parse(fixture.native.end_trace_span.mock.calls[0]![1] as string)
      .status,
  ).toBe('error');
});
