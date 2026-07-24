import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  stripStrictNullsForJsonSchema,
  stripStrictNullsForZodSchema,
  toOpenAIStrictToolSchema,
} from '../../src/utils/strictToolSchema';

describe('utils/strictToolSchema', () => {
  it('converts nested JSON schemas into OpenAI strict-compatible schemas', () => {
    const input = {
      type: 'object',
      properties: {
        requiredName: {
          type: 'string',
          default: null,
        },
        optionalCount: {
          type: 'number',
          description: 'Optional count',
        },
        alreadyNullable: {
          type: ['string', 'null'],
        },
        tuple: {
          type: 'array',
          items: [
            {
              type: 'object',
              properties: {
                nestedOptional: { type: 'string' },
              },
              required: [],
            },
          ],
        },
        union: {
          anyOf: [
            {
              type: 'object',
              properties: {
                value: { type: 'string' },
              },
              required: ['value'],
            },
          ],
        },
        referenced: {
          $ref: '#/$defs/reference',
        },
      },
      additionalProperties: true,
      required: ['requiredName'],
      $defs: {
        reference: {
          type: 'object',
          properties: {
            optionalRef: { type: 'boolean' },
          },
          required: [],
        },
      },
      definitions: {
        legacy: {
          type: 'object',
          properties: {
            optionalLegacy: { type: 'integer' },
          },
          required: [],
        },
      },
    };

    const result = toOpenAIStrictToolSchema(input as any);

    expect(result).toEqual({
      type: 'object',
      properties: {
        requiredName: {
          type: 'string',
        },
        optionalCount: {
          description: 'Optional count',
          anyOf: [
            { type: 'number', description: 'Optional count' },
            { type: 'null' },
          ],
        },
        alreadyNullable: {
          type: ['string', 'null'],
        },
        tuple: {
          anyOf: [
            {
              type: 'array',
              items: [
                {
                  type: 'object',
                  properties: {
                    nestedOptional: {
                      anyOf: [{ type: 'string' }, { type: 'null' }],
                    },
                  },
                  required: ['nestedOptional'],
                  additionalProperties: false,
                },
              ],
            },
            { type: 'null' },
          ],
        },
        union: {
          anyOf: [
            {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    value: { type: 'string' },
                  },
                  required: ['value'],
                  additionalProperties: false,
                },
              ],
            },
            { type: 'null' },
          ],
        },
        referenced: {
          anyOf: [{ $ref: '#/$defs/reference' }, { type: 'null' }],
        },
      },
      required: [
        'requiredName',
        'optionalCount',
        'alreadyNullable',
        'tuple',
        'union',
        'referenced',
      ],
      additionalProperties: false,
      $defs: {
        reference: {
          type: 'object',
          properties: {
            optionalRef: {
              anyOf: [{ type: 'boolean' }, { type: 'null' }],
            },
          },
          required: ['optionalRef'],
          additionalProperties: false,
        },
      },
      definitions: {
        legacy: {
          type: 'object',
          properties: {
            optionalLegacy: {
              anyOf: [{ type: 'integer' }, { type: 'null' }],
            },
          },
          required: ['optionalLegacy'],
          additionalProperties: false,
        },
      },
    });
  });

  it('strips strict nulls from optional JSON Schema object and array fields', () => {
    const schema = {
      type: 'object',
      properties: {
        required: { type: 'string' },
        optional: { type: 'number' },
        nullableOptional: {
          oneOf: [{ type: 'string' }, { type: 'null' }],
        },
        tuple: {
          type: 'array',
          items: [{ type: 'string' }, { type: 'number' }],
        },
        list: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              optionalChild: { type: 'boolean' },
            },
            required: [],
          },
        },
      },
      required: ['required', 'tuple', 'list'],
    };

    expect(
      stripStrictNullsForJsonSchema(schema, {
        required: 'ok',
        optional: null,
        nullableOptional: null,
        tuple: ['x', null],
        list: [{ optionalChild: null }],
      }),
    ).toEqual({
      required: 'ok',
      nullableOptional: null,
      tuple: ['x', null],
      list: [{}],
    });
  });

  it('strips strict nulls through $defs references', () => {
    const schema = {
      type: 'object',
      properties: {
        payload: { $ref: '#/$defs/payload' },
      },
      required: ['payload'],
      $defs: {
        payload: {
          type: 'object',
          properties: {
            note: { type: 'string' },
          },
          required: [],
        },
      },
    };

    expect(
      stripStrictNullsForJsonSchema(schema, {
        payload: { note: null },
      }),
    ).toEqual({ payload: {} });
  });

  it('strips strict nulls through legacy definitions references', () => {
    const schema = {
      type: 'object',
      properties: {
        payload: { $ref: '#/definitions/payload' },
      },
      required: ['payload'],
      definitions: {
        payload: {
          type: 'object',
          properties: {
            note: { type: 'string' },
          },
          required: [],
        },
      },
    };

    expect(
      stripStrictNullsForJsonSchema(schema, {
        payload: { note: null },
      }),
    ).toEqual({ payload: {} });
  });

  it('decodes RFC 6901 escaped reference tokens', () => {
    const schema = {
      type: 'object',
      properties: {
        payload: { $ref: '#/$defs/path~1with~0tilde' },
      },
      required: ['payload'],
      $defs: {
        'path/with~tilde': {
          type: 'object',
          properties: {
            note: { type: 'string' },
          },
          required: [],
        },
      },
    };

    expect(
      stripStrictNullsForJsonSchema(schema, {
        payload: { note: null },
      }),
    ).toEqual({ payload: {} });
  });

  it('stops resolving cyclic references', () => {
    const schema = {
      type: 'object',
      properties: {
        payload: { $ref: '#/$defs/first' },
      },
      required: ['payload'],
      $defs: {
        first: { $ref: '#/$defs/second' },
        second: { $ref: '#/$defs/first' },
      },
    };
    const value = { payload: { note: null } };

    expect(stripStrictNullsForJsonSchema(schema, value)).toEqual(value);
  });

  it('strips strict nulls through recursive root references', () => {
    const schema = {
      type: 'object',
      properties: {
        note: { type: 'string' },
        child: { $ref: '#' },
      },
      required: [],
    };

    expect(
      stripStrictNullsForJsonSchema(schema, {
        note: null,
        child: { note: null },
      }),
    ).toEqual({ child: {} });
  });

  it('strips nulls unless every referenced allOf branch allows null', () => {
    const schema = {
      type: 'object',
      properties: {
        value: { $ref: '#/$defs/value' },
      },
      required: [],
      $defs: {
        value: {
          allOf: [{ type: ['string', 'null'] }, { type: 'string' }],
        },
      },
    };

    expect(stripStrictNullsForJsonSchema(schema, { value: null })).toEqual({});
  });

  it.each([
    ['unresolved', '#/$defs/missing'],
    ['external', 'https://example.com/schema.json#/$defs/payload'],
  ])('leaves values behind %s references unchanged', (_name, $ref) => {
    const schema = {
      type: 'object',
      properties: {
        payload: { $ref },
      },
      required: ['payload'],
    };
    const value = { payload: { note: null } };

    expect(stripStrictNullsForJsonSchema(schema, value)).toEqual(value);
  });

  it('strips strict nulls from optional Zod object, union, array, tuple, and record fields', () => {
    const schema = z.object({
      direct: z.string().optional(),
      nullable: z.string().nullable().optional(),
      union: z.union([
        z.object({
          kind: z.literal('text'),
          optional: z.string().optional(),
        }),
        z.object({
          kind: z.literal('count'),
          optional: z.number().optional(),
        }),
      ]),
      list: z.array(
        z.object({
          optional: z.string().optional(),
        }),
      ),
      tuple: z.tuple([z.string().optional(), z.number().optional()]),
      record: z.record(z.string(), z.string().optional()),
    });

    expect(
      stripStrictNullsForZodSchema(schema, {
        direct: null,
        nullable: null,
        union: {
          kind: 'text',
          optional: null,
        },
        list: [{ optional: null }],
        tuple: [null, null],
        record: {
          keep: 'value',
          drop: null,
        },
      }),
    ).toEqual({
      nullable: null,
      union: {
        kind: 'text',
      },
      list: [{}],
      tuple: [undefined, undefined],
      record: {
        keep: 'value',
      },
    });
  });
});
