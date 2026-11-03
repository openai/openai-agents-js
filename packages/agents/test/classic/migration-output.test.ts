import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { Agent } from '@openai/agents/classic';
import { SDKRunner } from '@openai/agents/migration';
import { convertAgentOutputTypeToSerializable } from '@openai/agents-core/utils/internal';
import { captureOutput } from '../../src/migration/output';
import { OutputValidationError } from '../../src/runtime/output';

describe('migration captured output contract', () => {
  it('retains text defaults without installing a second parser', () => {
    const agent = new Agent({ name: 'Text', modelSettings: {} });
    const output = captureOutput(agent);
    expect(output.model).toBe('text');
    expect(output.native.schema).toBeUndefined();
    expect(output.native.parse).toBeUndefined();
    const _inferred = () =>
      SDKRunner.run(agent, 'Hello', { context: undefined });
    expectTypeOf<
      Awaited<ReturnType<typeof _inferred>>['finalOutput']
    >().toEqualTypeOf<string>();
  });

  it('preserves Core serialization and executes the captured Agent validator once', () => {
    let validations = 0;
    const schema = z
      .object({ answer: z.string() })
      .strict()
      .superRefine(() => {
        validations++;
      });
    const agent = new Agent<{ tenant: string }, typeof schema>({
      name: 'Object',
      outputType: schema,
      modelSettings: {},
    });
    const output = captureOutput(agent);
    expect(validations).toBe(0);
    expect(output.model).toEqual(convertAgentOutputTypeToSerializable(schema));
    expect(output.native.schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    const value = output.native.parse!('{"answer":"checked"}');
    expect(value).toEqual({ answer: 'checked' });
    expect(validations).toBe(1);
    const _inferred = () =>
      SDKRunner.run(agent, 'Hello', { context: { tenant: 'synthetic' } });
    expectTypeOf<
      Awaited<ReturnType<typeof _inferred>>['finalOutput']
    >().toEqualTypeOf<{ answer: string }>();
    expectTypeOf<
      Awaited<ReturnType<typeof _inferred>>['runContext']['context']
    >().toEqualTypeOf<{ tenant: string }>();
  });

  it('captures the declaration instead of rereading a replaced Agent output type', () => {
    const schema = z.object({ original: z.string() }).strict();
    const agent = new Agent({
      name: 'Captured',
      outputType: schema,
      modelSettings: {},
    });
    const output = captureOutput(agent);
    Object.assign(agent, {
      outputType: z.object({ replacement: z.number() }).strict(),
    });
    expect(output.native.parse!('{"original":"retained"}')).toEqual({
      original: 'retained',
    });
  });

  it.each(['not-json-SENSITIVE', '{"answer":17}'])(
    'retains native validation error redaction for rejected output %s',
    (raw) => {
      const agent = new Agent({
        name: 'Reject',
        outputType: z.object({ answer: z.string() }).strict(),
        modelSettings: {},
      });
      const output = captureOutput(agent);
      try {
        output.native.parse!(raw);
        expect.unreachable('Invalid output must fail');
      } catch (error) {
        expect(error).toBeInstanceOf(OutputValidationError);
        expect((error as OutputValidationError).rawOutput).toBe(raw);
        expect((error as Error).message).not.toContain(raw);
        expect((error as Error).cause).toBeUndefined();
      }
    },
  );

  it('refuses a known open-map schema during capture', () => {
    const agent = new Agent({
      name: 'Open map',
      outputType: z.object({ values: z.record(z.string(), z.string()) }),
      modelSettings: {},
    });
    expect(() => captureOutput(agent)).toThrow();
  });

  it('refuses raw JSON schema declarations outside this first slice', () => {
    const agent = new Agent({
      name: 'Raw schema',
      outputType: {
        type: 'json_schema',
        name: 'raw',
        strict: true,
        schema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      modelSettings: {},
    });
    expect(() => captureOutput(agent)).toThrow('supported Zod object');
  });
});
