import { expect, it, vi } from 'vitest';
import { telemetry, type ConsoleDiagnostics } from '../src';

const configureNative = vi.hoisted(() =>
  vi.fn(async (_encoded: string) => undefined),
);
vi.mock('../src/runtime/binding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runtime/binding')>()),
  binding: async () => ({ configure_telemetry: configureNative }),
}));

it('captures public diagnostic settings before native initialization', async () => {
  const targets = ['codex_core', 'codex_otel::events'];
  const diagnostics: ConsoleDiagnostics = {
    level: 'debug',
    targets,
    includeFields: true,
  };
  const ready = telemetry.configure({ diagnostics });
  targets.push('later_change');
  await ready;

  const encoded = configureNative.mock.calls[0]?.[0];
  expect(encoded).toBeDefined();
  const configuration = JSON.parse(encoded!);
  expect(configuration['sdk.console_diagnostics']).toEqual({
    level: 'debug',
    targets: ['codex_core', 'codex_otel::events'],
    include_fields: true,
  });
  expect(configuration['otel.exporter']).toBe('none');
  expect(configuration['otel.trace_exporter']).toBe('none');
});
