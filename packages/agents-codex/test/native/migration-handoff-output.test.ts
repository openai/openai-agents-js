// Mixed output types must fail before Model and callback effects.
import { describe, expect, it, vi } from 'vitest';
import { SDKRunner } from '@openai/agents/migration';
import {
  structuredRootTextTarget,
  textRootStructuredTarget,
} from './migration-handoff-output-fixtures';

const native = process.env.OPENAI_AGENTS_NATIVE_TESTS === '1';

function withExpectedMismatchWarning<Fixture>(create: () => Fixture): Fixture {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const fixture = create();
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('Handoff agents have different output types'),
    );
    return fixture;
  } finally {
    warning.mockRestore();
  }
}

describe.runIf(native)('structured output with a native handoff', () => {
  it('refuses structured Root to text Target before Model or callback effects', async () => {
    const { agent, model, effects } = withExpectedMismatchWarning(
      structuredRootTextTarget,
    );
    await expect(
      SDKRunner.run(agent, 'Transfer the report.', {
        context: { tenant: 'synthetic' },
      }),
    ).rejects.toThrow(/handoff.*text/i);
    expect(model.calls).toHaveLength(0);
    expect(effects.execute).toBe(0);
    expect(effects.onHandoff).toBe(0);
  });

  it('refuses text Root to structured Target before Model or callback effects', async () => {
    const { agent, model, effects } = withExpectedMismatchWarning(
      textRootStructuredTarget,
    );
    await expect(
      SDKRunner.run(agent, 'Transfer the report.', {
        context: { tenant: 'synthetic' },
      }),
    ).rejects.toThrow(/handoff.*text/i);
    expect(model.calls).toHaveLength(0);
    expect(effects.execute).toBe(0);
    expect(effects.onHandoff).toBe(0);
  });
});

// All-text handoffs and standalone structured output have separate native suites.
