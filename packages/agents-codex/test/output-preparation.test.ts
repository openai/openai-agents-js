import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { inspect } from 'node:util';
import { OutputValidationError, prepareOutput } from '../src/runtime/output';

describe('output schema preparation', () => {
  it('captures plain output without serializing schema implementation metadata', () => {
    const implicit = prepareOutput(undefined);
    const explicit = prepareOutput(z.string());
    expect(implicit.identity.mode).toBe('plain');
    expect(implicit.schema).toBeUndefined();
    expect(explicit.identity).toEqual(implicit.identity);
    expect(explicit.parse?.('ordinary text')).toBe('ordinary text');
  });

  it('prepares native objects and wrapped primitives as JSON-only schemas', () => {
    const object = prepareOutput({
      mode: 'native',
      schema: z.object({ count: z.number() }),
    });
    const primitive = prepareOutput({ mode: 'native', schema: z.number() });
    expect(object.identity.mode).toBe('native');
    expect(object.schema).toMatchObject({
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
      additionalProperties: false,
    });
    expect(object.parse?.('{"count":2}')).toEqual({ count: 2 });
    expect(primitive.schema).toMatchObject({
      type: 'object',
      properties: { response: { type: 'number' } },
      required: ['response'],
      additionalProperties: false,
    });
    expect(primitive.parse?.('{"response":3}')).toBe(3);
    expect(Reflect.ownKeys(object.schema!)).not.toContain('~standard');
    expect(Reflect.ownKeys(primitive.schema!)).not.toContain('~standard');
  });

  it('captures prompted input guidance and retains the local parser', () => {
    const output = prepareOutput({
      mode: 'prompted',
      schema: z.string().transform((value) => value.length),
      maxRetries: 1,
    });
    expect(output.identity.mode).toBe('prompted');
    expect(output.prompt).toContain('"type":"string"');
    expect(output.repair?.schema).toMatchObject({ type: 'string' });
    expect(Reflect.ownKeys(output.repair!.schema)).not.toContain('~standard');
    expect(output.parse?.('"hello"')).toBe(5);
  });
});

describe('output validation diagnostics', () => {
  function failure(parse: () => unknown): OutputValidationError {
    try {
      parse();
    } catch (error) {
      expect(error).toBeInstanceOf(OutputValidationError);
      return error as OutputValidationError;
    }
    throw new Error('Expected output validation to fail');
  }

  it.each(['native', 'prompted'] as const)(
    'captures nested %s paths without rejected inputs',
    (mode) => {
      const output = prepareOutput({
        mode,
        schema: z.object({ items: z.array(z.object({ count: z.number() })) }),
      });
      const raw = '{"items":[{"count":"synthetic-private-value"}]}';
      const error = failure(() => output.parse!(raw));
      expect(error.issues).toEqual([
        { code: 'invalid_type', path: ['items', 0, 'count'] },
      ]);
      expect(error.rawOutput).toBe(raw);
      expect(error.cause).toBeUndefined();
      expect(String(error)).not.toContain('synthetic-private');
      expect(inspect(error)).not.toContain('synthetic-private');
      expect(JSON.stringify(error)).not.toContain('synthetic-private');
    },
  );

  it.each([
    ['{"response":["wrong"]}', [0]],
    ['{}', []],
    ['{"response":[1],"extra":2}', []],
  ])('maps native wrapper failure %s to application paths', (raw, path) => {
    const output = prepareOutput({
      mode: 'native',
      schema: z.array(z.number()),
    });
    expect(failure(() => output.parse!(raw as string)).issues[0].path).toEqual(
      path,
    );
  });

  it('keeps custom diagnostics private and calls a validator once', () => {
    let calls = 0;
    const schema = z.string().superRefine((_value, context) => {
      calls++;
      context.addIssue({
        code: 'custom',
        path: ['synthetic-private-field'],
        message: 'synthetic-private-message',
      });
    });
    const output = prepareOutput({ mode: 'prompted', schema });
    const error = failure(() => output.parse!('"synthetic-private-input"'));
    expect(calls).toBe(1);
    expect(error.issues).toEqual([
      { code: 'custom', path: ['synthetic-private-field'] },
    ]);
    expect(error.cause).toBeUndefined();
    expect(inspect(error)).not.toContain('synthetic-private');
    expect(error.stack).not.toContain('synthetic-private');
    expect(JSON.stringify(error)).not.toContain('synthetic-private');
  });

  it('preserves an application-owned response field in issue paths', () => {
    const output = prepareOutput({
      mode: 'native',
      schema: z.object({ response: z.array(z.number()) }),
    });
    expect(
      failure(() => output.parse!('{"response":["wrong"]}')).issues[0].path,
    ).toEqual(['response', 0]);
  });

  it('hides explicitly supplied custom codes from ordinary display', () => {
    const error = new OutputValidationError('synthetic-private-input', [
      { code: 'synthetic-private-code', path: ['synthetic-private-field'] },
    ]);
    expect(error.issues[0].code).toBe('synthetic-private-code');
    expect(inspect(error)).not.toContain('synthetic-private');
    expect(JSON.stringify(error)).not.toContain('synthetic-private');
  });

  it('retains no arbitrary user-validator exception and does not rerun it', () => {
    let calls = 0;
    const output = prepareOutput({
      mode: 'prompted',
      schema: z.string().transform(() => {
        calls++;
        throw new Error('synthetic-private-exception');
      }),
    });
    const error = failure(() => output.parse!('"synthetic-private-input"'));
    expect(calls).toBe(1);
    expect(error.issues).toEqual([{ code: 'validation_error', path: [] }]);
    expect(error.cause).toBeUndefined();
    expect(inspect(error)).not.toContain('synthetic-private');
  });

  it('reports invalid JSON without retaining its parser error', () => {
    const output = prepareOutput({ mode: 'native', schema: z.number() });
    const error = failure(() =>
      output.parse!('synthetic-private-invalid-json'),
    );
    expect(error.issues).toEqual([{ code: 'validation_error', path: [] }]);
    expect(error.cause).toBeUndefined();
    expect(inspect(error)).not.toContain('synthetic-private');
  });
});
