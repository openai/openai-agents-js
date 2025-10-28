import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { z as z4 } from 'zod/v4';
import { zodJsonSchemaCompat } from '../../src/utils/zodJsonSchemaCompat';

describe('utils/zodJsonSchemaCompat', () => {
  it('builds schema for basic object with optional property', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().optional(),
    });

    const jsonSchema = zodJsonSchemaCompat(schema);
    expect(jsonSchema).toBeDefined();
    expect(jsonSchema).toMatchObject({
      type: 'object',
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
    });
    expect(jsonSchema?.required).toEqual(['name']);
  });

  it('unwraps decorators and nullable types', () => {
    const schema = z.object({
      branded: z.string().brand('Tagged'),
      readonly: z.string().readonly(),
      nullable: z.string().nullable(),
    });

    const jsonSchema = zodJsonSchemaCompat(schema);
    expect(jsonSchema).toBeDefined();
    expect(jsonSchema?.properties.branded).toEqual({ type: 'string' });
    expect(jsonSchema?.properties.readonly).toEqual({ type: 'string' });
    expect(jsonSchema?.properties.nullable).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
  });

  it('handles compound schemas such as tuples and unions', () => {
    const schema = z.object({
      tuple: z.tuple([z.string(), z.number()]),
      union: z.union([z.string(), z.number()]),
    });

    const jsonSchema = zodJsonSchemaCompat(schema);
    expect(jsonSchema).toBeDefined();
    expect(jsonSchema?.properties.tuple).toMatchObject({
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: [{ type: 'string' }, { type: 'number' }],
    });
    expect(jsonSchema?.properties.union).toMatchObject({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('converts nested record and array structures', () => {
    const schema = z.object({
      record: z.record(z.number()),
      list: z.array(z.object({ id: z.string() })),
    });

    const jsonSchema = zodJsonSchemaCompat(schema);
    expect(jsonSchema).toBeDefined();
    expect(jsonSchema?.properties.record).toMatchObject({
      type: 'object',
      additionalProperties: { type: 'number' },
    });
    expect(jsonSchema?.properties.list).toMatchObject({
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
    });
  });

  it('supports Zod v4 objects', () => {
    const schema = z4.object({
      title: z4.string(),
      score: z4.number().optional(),
      tags: z4.set(z4.string()),
    });

    const jsonSchema = zodJsonSchemaCompat(schema as any);
    expect(jsonSchema).toBeDefined();
    expect(jsonSchema?.properties.title).toEqual({ type: 'string' });
    expect(jsonSchema?.properties.score).toEqual({ type: 'number' });
    expect(jsonSchema?.properties.tags).toEqual({
      type: 'array',
      uniqueItems: true,
      items: { type: 'string' },
    });
    expect(jsonSchema?.required).toEqual(['title', 'tags']);
  });
});
