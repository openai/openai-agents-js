import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { z as zod3 } from 'zod/v3';
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

  it('handles discriminated unions from legacy zod internals', () => {
    const schema = zod3.object({
      recurrence: zod3.discriminatedUnion('type', [
        zod3.object({
          type: zod3.literal('once'),
          date: zod3.string(),
        }),
        zod3.object({
          type: zod3.literal('weekly'),
          dayOfWeek: zod3.number(),
        }),
      ]),
    });

    const jsonSchema = zodJsonSchemaCompat(
      schema as unknown as z.ZodObject<any>,
    );
    expect(jsonSchema?.properties.recurrence).toMatchObject({
      anyOf: [
        {
          type: 'object',
          properties: {
            type: { const: 'once', type: 'string' },
            date: { type: 'string' },
          },
          required: ['type', 'date'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            type: { const: 'weekly', type: 'string' },
            dayOfWeek: { type: 'number' },
          },
          required: ['type', 'dayOfWeek'],
          additionalProperties: false,
        },
      ],
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
    expect(jsonSchema?.properties.choice).toEqual({
      type: 'string',
      enum: ['one', 'two'],
    });
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

  it('handles nullable and enum fallbacks', () => {
    enum Status {
      Ready = 'ready',
      Done = 'done',
    }

    const schema = z.object({
      nullable: z.string().nullable(),
      nativeEnum: z.nativeEnum(Status),
    });

    const jsonSchema = zodJsonSchemaCompat(schema);
    expect(jsonSchema?.properties.nullable).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
    expect(jsonSchema?.properties.nativeEnum).toEqual({
      type: 'string',
      enum: ['ready', 'done'],
    });
  });

  it('rejects Zod types that cannot be produced by JSON.parse', () => {
    for (const field of [
      z.date(),
      z.bigint(),
      z.map(z.string(), z.number()),
      z.set(z.string()),
    ]) {
      const schema = z.object({
        value: field,
      });

      expect(zodJsonSchemaCompat(schema)).toBeUndefined();
    }
  });

  it('includes type:"number" for numeric native enums', () => {
    enum Priority {
      Low = 0,
      Medium = 1,
      High = 2,
    }

    const schema = z.object({
      priority: z.nativeEnum(Priority),
    });

    const jsonSchema = zodJsonSchemaCompat(schema);
    expect(jsonSchema?.properties.priority).toEqual({
      type: 'number',
      enum: [0, 1, 2],
    });
  });

  it('includes type:["string","number"] for mixed native enums', () => {
    enum Mixed {
      Label = 'label',
      Count = 1,
      Unit = 'px',
    }

    const schema = z.object({
      mixed: z.nativeEnum(Mixed),
    });

    const jsonSchema = zodJsonSchemaCompat(schema);
    expect(jsonSchema?.properties.mixed).toEqual({
      type: ['string', 'number'],
      enum: ['label', 1, 'px'],
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

  it('includes descriptions from zod schemas when available', () => {
    const schema = z
      .object({
        text: z.string().describe('Text to translate'),
        target: z.string(),
      })
      .describe('Translation input');

    const jsonSchema = zodJsonSchemaCompat(schema);
    expect(jsonSchema?.description).toBe('Translation input');
    expect(jsonSchema?.properties.text).toEqual({
      type: 'string',
      description: 'Text to translate',
    });
    expect(jsonSchema?.properties.target).toEqual({ type: 'string' });
  });
});
