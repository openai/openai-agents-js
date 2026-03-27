import { describe, it, expect } from 'vitest';
import {
  toFunctionToolName,
  getSchemaAndParserFromInputType,
  convertAgentOutputTypeToSerializable,
} from '../../src/utils/tools';
import { normalizeGeneratedJsonSchema } from '../../src/utils/normalizeGeneratedJsonSchema';
import { z } from 'zod';
import { UserError } from '../../src/errors';
import { JsonObjectSchema, JsonSchemaDefinitionEntry } from '../../src/types';
import type { ZodObjectLike } from '../../src/utils/zodCompat';

function buildRecurrenceSchema(zod: {
  object: typeof z.object;
  discriminatedUnion: typeof z.discriminatedUnion;
  literal: typeof z.literal;
  string: typeof z.string;
  union: typeof z.union;
  number: typeof z.number;
}) {
  return zod.object({
    recurrence: zod.discriminatedUnion('type', [
      zod.object({
        type: zod.literal('once'),
        date: zod.string(),
      }),
      zod.object({
        type: zod.literal('weekly'),
        dayOfWeek: zod.number(),
      }),
    ]),
  });
}

function buildPlainUnionRecurrenceSchema(zod: {
  object: typeof z.object;
  literal: typeof z.literal;
  string: typeof z.string;
  union: typeof z.union;
  number: typeof z.number;
}) {
  return zod.object({
    recurrence: zod.union([
      zod.object({
        type: zod.literal('once'),
        date: zod.string(),
      }),
      zod.object({
        type: zod.literal('weekly'),
        dayOfWeek: zod.number(),
      }),
    ]),
  });
}

function buildStrictRecurrenceSchema(zod: {
  object: typeof z.object;
  discriminatedUnion: typeof z.discriminatedUnion;
  literal: typeof z.literal;
  string: typeof z.string;
  number: typeof z.number;
  strictObject: typeof z.strictObject;
}) {
  return zod.object({
    recurrence: zod.discriminatedUnion('type', [
      zod.strictObject({
        type: zod.literal('once'),
        date: zod.string(),
      }),
      zod.strictObject({
        type: zod.literal('weekly'),
        dayOfWeek: zod.number(),
      }),
    ]),
  });
}

function buildNullableRecurrenceSchema(zod: {
  object: typeof z.object;
  discriminatedUnion: typeof z.discriminatedUnion;
  literal: typeof z.literal;
  string: typeof z.string;
  number: typeof z.number;
}) {
  return zod.object({
    recurrence: zod.discriminatedUnion('type', [
      zod.object({
        type: zod.literal('once'),
        date: zod.string().nullable(),
      }),
      zod.object({
        type: zod.literal('weekly'),
        dayOfWeek: zod.number(),
      }),
    ]),
  });
}

function buildCatchallRecurrenceSchema(zod: {
  object: typeof z.object;
  discriminatedUnion: typeof z.discriminatedUnion;
  literal: typeof z.literal;
  string: typeof z.string;
  number: typeof z.number;
}) {
  return zod.object({
    recurrence: zod.discriminatedUnion('type', [
      zod
        .object({
          type: zod.literal('once'),
          date: zod.string(),
        })
        .catchall(zod.string()),
      zod
        .object({
          type: zod.literal('weekly'),
          dayOfWeek: zod.number(),
        })
        .catchall(zod.string()),
    ]),
  });
}

function expectNormalizedRecurrenceSchema(schema: JsonObjectSchema<any>) {
  expect(schema).toMatchObject({
    type: 'object',
    properties: {
      recurrence: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['once', 'weekly'],
          },
          date: {
            type: ['string', 'null'],
            description: 'Set to null unless type is "once".',
          },
          dayOfWeek: {
            type: ['number', 'null'],
            description: 'Set to null unless type is "weekly".',
          },
        },
        required: ['type', 'date', 'dayOfWeek'],
        additionalProperties: false,
      },
    },
    required: ['recurrence'],
    additionalProperties: false,
  });
  expect(schema.properties.recurrence.anyOf).toBeUndefined();
}

describe('utils/tools', () => {
  it('normalizes function tool names', () => {
    expect(toFunctionToolName('My Tool')).toBe('My_Tool');
    expect(toFunctionToolName('a-b$c')).toBe('a_b_c');
  });

  it('throws when name becomes empty', () => {
    expect(() => toFunctionToolName('')).toThrow('Tool name cannot be empty');
  });

  it('getSchemaAndParserFromInputType with JSON schema', () => {
    const schema: JsonObjectSchema<Record<string, JsonSchemaDefinitionEntry>> =
      {
        type: 'object',
        properties: { foo: { type: 'string' } },
        required: ['foo'],
        additionalProperties: false,
      } as const;
    const res = getSchemaAndParserFromInputType(schema, 'tool');
    expect(res.schema).toEqual(schema);
    expect(res.parser('{"foo":"bar"}')).toEqual({ foo: 'bar' });
  });

  it('getSchemaAndParserFromInputType with ZodObject', () => {
    const zodSchema = z.object({ bar: z.number() });
    const res = getSchemaAndParserFromInputType(zodSchema, 'tool');
    expect(res.schema).toHaveProperty('type', 'object');
    expect(res.parser('{"bar":2}')).toEqual({ bar: 2 });
  });

  it('getSchemaAndParserFromInputType includes zod descriptions when available', () => {
    const zodSchema = z
      .object({
        text: z.string().describe('Text to translate'),
      })
      .describe('Translation input');
    const res = getSchemaAndParserFromInputType(zodSchema, 'tool');
    expect(res.schema).toMatchObject({
      description: 'Translation input',
      properties: {
        text: {
          description: 'Text to translate',
        },
      },
    });
  });

  it('getSchemaAndParserFromInputType rejects invalid input', () => {
    expect(() => getSchemaAndParserFromInputType('bad' as any, 't')).toThrow(
      UserError,
    );
  });

  it('falls back to compat schema when the helper rejects optional fields', () => {
    const zodSchema = z.object({
      required: z.string(),
      optional: z.number().optional(),
    });
    const res = getSchemaAndParserFromInputType(
      zodSchema,
      'tool-with-optional',
    );
    expect(res.schema).toEqual({
      type: 'object',
      properties: {
        required: { type: 'string' },
        optional: { type: 'number' },
      },
      required: ['required'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    });
    expect(res.parser('{"required":"ok"}')).toEqual({ required: 'ok' });
    expect(res.parser('{"required":"ok","optional":2}')).toEqual({
      required: 'ok',
      optional: 2,
    });
  });

  it('normalizes discriminated unions for Zod v4 tool schemas', () => {
    const zodSchema = buildRecurrenceSchema(z);
    const res = getSchemaAndParserFromInputType(zodSchema, 'tool');
    const plainUnionRes = getSchemaAndParserFromInputType(
      buildPlainUnionRecurrenceSchema(z),
      'tool',
    );

    expectNormalizedRecurrenceSchema(res.schema);
    expect(plainUnionRes.schema).toEqual(res.schema);
    expect(
      res.parser('{"recurrence":{"type":"weekly","date":null,"dayOfWeek":2}}'),
    ).toEqual({
      recurrence: {
        type: 'weekly',
        dayOfWeek: 2,
      },
    });
    expect(() =>
      res.parser('{"recurrence":{"type":"once","dayOfWeek":2}}'),
    ).toThrow();
  });

  it('preserves shared optional fields when normalizing discriminated unions', () => {
    const normalized = normalizeGeneratedJsonSchema({
      type: 'object',
      properties: {
        recurrence: {
          anyOf: [
            {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  const: 'once',
                },
                date: {
                  type: 'string',
                },
                note: {
                  type: 'string',
                },
              },
              required: ['type', 'date'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  const: 'weekly',
                },
                dayOfWeek: {
                  type: 'number',
                },
                note: {
                  type: 'string',
                },
              },
              required: ['type', 'dayOfWeek'],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ['recurrence'],
      additionalProperties: false,
    });

    expect(normalized).toMatchObject({
      type: 'object',
      properties: {
        recurrence: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['once', 'weekly'],
            },
            date: {
              type: ['string', 'null'],
              description: 'Set to null unless type is "once".',
            },
            dayOfWeek: {
              type: ['number', 'null'],
              description: 'Set to null unless type is "weekly".',
            },
            note: {
              type: 'string',
            },
          },
          required: ['type', 'date', 'dayOfWeek'],
          additionalProperties: false,
        },
      },
      required: ['recurrence'],
      additionalProperties: false,
    });
    const recurrenceSchema = normalized.properties
      .recurrence as unknown as JsonObjectSchema<any>;
    expect(recurrenceSchema.required).not.toContain('note');
    expect(recurrenceSchema.properties.note.type).toBe('string');
  });

  it('normalizes branch-only nullable fields that are already expressed with anyOf', () => {
    const res = getSchemaAndParserFromInputType(
      buildNullableRecurrenceSchema(z),
      'tool',
    );
    const recurrenceSchema = res.schema.properties
      .recurrence as unknown as JsonObjectSchema<any> & {
      anyOf?: unknown;
    };

    expect(recurrenceSchema.anyOf).toBeUndefined();
    expect(recurrenceSchema.properties.date).toMatchObject({
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'Set to null unless type is "once".',
    });
    expect(
      res.parser('{"recurrence":{"type":"weekly","date":null,"dayOfWeek":2}}'),
    ).toEqual({
      recurrence: {
        type: 'weekly',
        dayOfWeek: 2,
      },
    });
  });

  it('strips null filler keys before parsing strict discriminated unions', () => {
    const res = getSchemaAndParserFromInputType(
      buildStrictRecurrenceSchema(z),
      'tool',
    );

    expect(
      res.parser('{"recurrence":{"type":"weekly","date":null,"dayOfWeek":2}}'),
    ).toEqual({
      recurrence: {
        type: 'weekly',
        dayOfWeek: 2,
      },
    });
  });

  it('preserves merged additionalProperties for discriminated unions', () => {
    const res = getSchemaAndParserFromInputType(
      buildCatchallRecurrenceSchema(z),
      'tool',
    );
    const recurrenceSchema = res.schema.properties
      .recurrence as unknown as JsonObjectSchema<any>;

    expect(recurrenceSchema.additionalProperties).toEqual({
      type: 'string',
    });
    expect(
      res.parser(
        '{"recurrence":{"type":"weekly","date":null,"dayOfWeek":2,"meta":"x"}}',
      ),
    ).toEqual({
      recurrence: {
        type: 'weekly',
        dayOfWeek: 2,
        meta: 'x',
      },
    });
  });

  it('ignores nested property key order when merging shared fields', () => {
    const normalized = normalizeGeneratedJsonSchema({
      type: 'object',
      properties: {
        recurrence: {
          anyOf: [
            {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  const: 'once',
                },
                config: {
                  type: 'object',
                  properties: {
                    alpha: { type: 'string' },
                    beta: { type: 'number' },
                  },
                  required: ['alpha', 'beta'],
                  additionalProperties: false,
                },
                date: {
                  type: 'string',
                },
              },
              required: ['type', 'config', 'date'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  const: 'weekly',
                },
                config: {
                  type: 'object',
                  properties: {
                    beta: { type: 'number' },
                    alpha: { type: 'string' },
                  },
                  required: ['beta', 'alpha'],
                  additionalProperties: false,
                },
                dayOfWeek: {
                  type: 'number',
                },
              },
              required: ['type', 'config', 'dayOfWeek'],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ['recurrence'],
      additionalProperties: false,
    });
    const recurrenceSchema = normalized.properties
      .recurrence as unknown as JsonObjectSchema<any> & {
      anyOf?: unknown;
    };

    expect(recurrenceSchema.anyOf).toBeUndefined();
    expect(recurrenceSchema.properties.config).toMatchObject({
      type: 'object',
      properties: {
        alpha: { type: 'string' },
        beta: { type: 'number' },
      },
      required: ['alpha', 'beta'],
      additionalProperties: false,
    });
  });

  it('normalizes discriminated unions for Zod v3 tool schemas', async () => {
    const z3 = (await import('zod/v3')) as unknown as {
      z: typeof z;
    };
    const discriminatedSchema = buildRecurrenceSchema(z3.z);
    const res = getSchemaAndParserFromInputType(
      discriminatedSchema as ZodObjectLike,
      'tool',
    );
    const plainUnionRes = getSchemaAndParserFromInputType(
      buildPlainUnionRecurrenceSchema(z3.z) as ZodObjectLike,
      'tool',
    );

    expectNormalizedRecurrenceSchema(res.schema);
    expect(plainUnionRes.schema).toEqual(res.schema);
    expect(
      res.parser('{"recurrence":{"type":"weekly","date":null,"dayOfWeek":2}}'),
    ).toEqual({
      recurrence: {
        type: 'weekly',
        dayOfWeek: 2,
      },
    });
    expect(() =>
      res.parser('{"recurrence":{"type":"once","dayOfWeek":2}}'),
    ).toThrow();
  });

  it('convertAgentOutputTypeToSerializable falls back when helper rejects optional fields', () => {
    const zodSchema = z.object({
      required: z.string(),
      optional: z.number().optional(),
    });
    const res = convertAgentOutputTypeToSerializable(zodSchema);
    expect(res).toEqual({
      type: 'json_schema',
      name: 'output',
      strict: false,
      schema: {
        type: 'object',
        properties: {
          required: { type: 'string' },
          optional: { type: 'number' },
        },
        required: ['required'],
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
    });
  });
});
