import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  prepareOutput,
  outputModelSettings,
  type OutputSpec,
} from '../src/runtime/output';
it('keeps provider non-strict schema properties while retaining local validation', () => {
  const prepared = prepareOutput({
    mode: 'native',
    strict: false,
    schema: z.looseObject({ label: z.string().optional() }),
  });
  expect(prepared.schema?.required ?? []).not.toContain('label');
  expect(prepared.schema?.additionalProperties).not.toBe(false);
  expect(prepared.parse!('{"extension":4}')).toEqual({ extension: 4 });
  expect(() => prepared.parse!('{"label":4}')).toThrow(
    'Final output did not match',
  );
});
it('preserves omitted/true output fingerprints and distinguishes explicit false', () => {
  const schema = z.object({ label: z.string().optional() });
  const defaults = prepareOutput({ mode: 'native', schema });
  expect(prepareOutput({ mode: 'native', schema, strict: true })).toMatchObject(
    { identity: defaults.identity, schema: defaults.schema },
  );
  expect(
    prepareOutput({ mode: 'native', schema, strict: undefined }).identity,
  ).toEqual(defaults.identity);
  expect(
    prepareOutput({ mode: 'native', schema, strict: false }).identity
      .fingerprint,
  ).not.toBe(defaults.identity.fingerprint);
});
it('retains scoped retry controls and explicitly clears a prior non-strict setting for strict output', () => {
  const settings = {
    request_controls: {
      retry: { max_retries: 2 },
      output_schema_strict: false,
    },
    reasoning_effort: 'low',
  };
  const output = prepareOutput({
    mode: 'native',
    schema: z.object({ label: z.string() }),
  });
  expect(outputModelSettings(output, settings)).toEqual({
    request_controls: { retry: { max_retries: 2 }, output_schema_strict: true },
    reasoning_effort: 'low',
  });
  expect(settings.request_controls.output_schema_strict).toBe(false);
});
it('keeps application decision schemas strict', () => {
  expect(() =>
    prepareOutput(
      {
        mode: 'native',
        strict: false,
        schema: z.object({ choice: z.string() }),
      },
      { applicationValue: true },
    ),
  ).toThrow('Application decision output requires strict schemas');
});
it.each([null, 'false', 0])(
  'rejects malformed native strictness %s before resources open',
  (strict) => {
    expect(() =>
      prepareOutput({
        mode: 'native',
        strict,
        schema: z.object({ value: z.string() }),
      } as unknown as OutputSpec<unknown>),
    ).toThrow('Output strict must be a boolean');
  },
);
