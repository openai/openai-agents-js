import { describe, it, expect } from 'vitest';
import { z } from 'zod';
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

  it('supports intersections and enums', () => {
    const schema = z.object({
      combined: z.intersection(
        z.object({ a: z.string() }),
        z.object({ b: z.number() }),
      ),
      choice: z.enum(['one', 'two']),
    });

    const jsonSchema = zodJsonSchemaCompat(schema);
    expect(jsonSchema).toBeDefined();
    expect(jsonSchema?.properties.combined).toMatchObject({
      allOf: [
        {
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { b: { type: 'number' } },
          required: ['b'],
          additionalProperties: false,
        },
      ],
    });
    expect(jsonSchema?.properties.choice).toEqual({ enum: ['one', 'two'] });
  });

  it('converts nested record and array structures', () => {
    const schema = z.object({
      record: z.record(z.string(), z.number()),
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

  it('supports Zod objects with sets', () => {
    const schema = z.object({
      title: z.string(),
      score: z.number().optional(),
      tags: z.set(z.string()),
    });

    const jsonSchema = zodJsonSchemaCompat(schema);
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

  it('handles map, set, nullable, and enum fallbacks', () => {
    enum Status {
      Ready = 'ready',
      Done = 'done',
    }

    const schema = z.object({
      map: z.map(z.string(), z.number()),
      set: z.set(z.string()),
      nullable: z.string().nullable(),
      nativeEnum: z.nativeEnum(Status),
    });

    const jsonSchema = zodJsonSchemaCompat(schema);
    expect(jsonSchema?.properties.map).toEqual({
      type: 'array',
      items: { type: 'number' },
    });
    expect(jsonSchema?.properties.set).toEqual({
      type: 'array',
      items: { type: 'string' },
      uniqueItems: true,
    });
    expect(jsonSchema?.properties.nullable).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
    expect(jsonSchema?.properties.nativeEnum).toEqual({
      enum: ['ready', 'done'],
    });
  });

  it('returns undefined when schema shape cannot be introspected', () => {
    const tricky = {
      shape: () => {
        throw new Error('boom');
      },
    } as unknown as z.ZodObject<any>;

    expect(zodJsonSchemaCompat(tricky)).toBeUndefined();
  });

  it('supports literal definitions from zod internals', () => {
    const schema = {
      _def: {
        shape: {
          status: { _def: { type: 'literal', value: 'ready' } },
          empty: { _def: { type: 'literal', literal: null } },
        },
      },
    } as unknown as z.ZodObject<any>;

    const jsonSchema = zodJsonSchemaCompat(schema);
    expect(jsonSchema?.properties.status).toEqual({
      const: 'ready',
      type: 'string',
    });
    expect(jsonSchema?.properties.empty).toEqual({ const: null, type: 'null' });
  });

  it('reads shapes from zod definitions when shape is not directly available', () => {
    const schema = {
      _def: {
        shape: {
          title: z.string(),
        },
      },
    } as unknown as z.ZodObject<any>;

    const jsonSchema = zodJsonSchemaCompat(schema);
    expect(jsonSchema?.properties.title).toEqual({ type: 'string' });
  });
});
