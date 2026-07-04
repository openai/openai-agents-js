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
