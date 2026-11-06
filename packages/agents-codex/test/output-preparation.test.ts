import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { prepareOutput } from '../src/runtime/output';

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
