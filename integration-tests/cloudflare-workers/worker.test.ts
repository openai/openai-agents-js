import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '@openai/agents';
import worker from './worker/src/index';

const { forceFlush } = vi.hoisted(() => ({ forceFlush: vi.fn() }));

// Stub the SDK boundary to exercise HTTP handling without external services.
vi.mock('@openai/agents', () => ({
  Agent: vi.fn(),
  Runner: vi.fn(),
  run: vi.fn(),
  setDefaultOpenAIKey: vi.fn(),
  withTrace: vi.fn((_name, callback) => callback()),
  getCurrentTrace: vi.fn(),
  getGlobalTraceProvider: () => ({ forceFlush }),
}));
vi.mock('@openai/agents-extensions/ai-sdk', () => ({ aisdk: vi.fn() }));

describe('Cloudflare worker HTTP responses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forceFlush.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps exception details in server diagnostics and returns a generic 500', async () => {
    const error = new Error('Synthetic internal diagnostic');
    vi.mocked(run).mockRejectedValueOnce(error);
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const waitUntil = vi.fn();

    const response = await worker.fetch(
      new Request('https://worker.example/'),
      { OPENAI_API_KEY: 'synthetic-test-key' },
      { waitUntil } as Parameters<typeof worker.fetch>[2],
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal Server Error');
    expect(logError).toHaveBeenCalledWith(error);
    expect(forceFlush).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledWith(forceFlush.mock.results[0].value);
  });

  it('preserves successful responses and schedules trace flushing', async () => {
    vi.mocked(run).mockResolvedValueOnce({
      finalOutput: 'Hello there!',
    } as Awaited<ReturnType<typeof run>>);
    const waitUntil = vi.fn();

    const response = await worker.fetch(
      new Request('https://worker.example/'),
      { OPENAI_API_KEY: 'synthetic-test-key' },
      { waitUntil } as Parameters<typeof worker.fetch>[2],
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('[RESPONSE]Hello there![/RESPONSE]');
    expect(forceFlush).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledWith(forceFlush.mock.results[0].value);
  });
});
