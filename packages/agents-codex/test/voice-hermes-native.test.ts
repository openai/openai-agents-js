import { afterEach, describe, expect, it, vi } from 'vitest';

// The package prebuild has been lowering the real reviewed Rust controller.
const enabled = process.env.OPENAI_AGENTS_PORTABLE_TESTS === '1';
afterEach(() => vi.unstubAllGlobals());

describe.runIf(enabled)('packaged Hermes Rust control', () => {
  it('runs Unicode commands and independent sessions without WebAssembly or text codecs', async () => {
    vi.stubGlobal('WebAssembly', undefined);
    vi.stubGlobal('TextEncoder', undefined);
    vi.stubGlobal('TextDecoder', undefined);
    const { createHermesVoiceControl } =
      await import('@openai/agents/voice/control.hermes');
    const first = createHermesVoiceControl();
    const second = createHermesVoiceControl();
    const config = { model: 'test-realtime', instructions: 'Help. 海豚 🐬' };
    const start = first.apply({ type: 'start', config });
    expect(start[0]).toMatchObject({
      type: 'send',
      id: 1,
      event: {
        type: 'session.update',
        session: { instructions: config.instructions },
      },
    });
    if (start[0]?.type !== 'send') throw new Error('Missing startup send.');
    const startupEvent = start[0].event as Record<string, unknown>;
    first.apply({ type: 'sent', id: 1 });
    const ready = first.apply({
      type: 'provider',
      event: {
        type: 'session.updated',
        session: startupEvent.session,
      },
    });
    expect(ready).toContainEqual({ type: 'ready' });
    const text = '🐬'.repeat(300_000);
    expect(first.apply({ type: 'text', text })[0]).toMatchObject({
      type: 'send',
      event: { item: { content: [{ text }] } },
    });
    first.apply({ type: 'close' });
    expect(second.apply({ type: 'start', config })[0]).toMatchObject({
      type: 'send',
      id: 1,
    });
    expect(() => first.apply({ type: 'text', text: 'stale' })).toThrow(
      /closed/,
    );
  });
});
