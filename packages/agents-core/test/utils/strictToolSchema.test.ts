import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  prepareOpenAIStrictToolSchema,
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

  it('infers closed typeless nested objects without mutating the input', () => {
    const input = {
      type: 'object',
      properties: {
        nested: {
          properties: {
            value: { type: 'string', description: 'Nested value' },
          },
          required: [],
          additionalProperties: false,
        },
        union: {
          anyOf: [
            {
              properties: {
                count: { type: 'number' },
              },
              required: ['count'],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ['nested', 'union'],
      additionalProperties: false,
    } as const;

    const result = toOpenAIStrictToolSchema(input as any);

    expect(result).toEqual({
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: {
            value: {
              description: 'Nested value',
              anyOf: [
                { type: 'string', description: 'Nested value' },
                { type: 'null' },
              ],
            },
          },
          required: ['value'],
          additionalProperties: false,
        },
        union: {
          anyOf: [
            {
              type: 'object',
              properties: {
                count: { type: 'number' },
              },
              required: ['count'],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ['nested', 'union'],
      additionalProperties: false,
    });
    expect(input.properties.nested).not.toHaveProperty('type');
    expect(input.properties.nested.required).toEqual([]);
  });

  it('preserves optionality for inferred closed objects', () => {
    const input = {
      type: 'object',
      properties: {
        nested: {
          properties: {
            value: { type: 'string' },
          },
          required: [],
          additionalProperties: false,
        },
      },
      required: [],
      additionalProperties: false,
    };

    const prepared = prepareOpenAIStrictToolSchema(input as any);

    expect(prepared.schema.properties.nested).toEqual({
      anyOf: [
        {
          type: 'object',
          properties: {
            value: {
              anyOf: [{ type: 'string' }, { type: 'null' }],
            },
          },
          required: ['value'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    });
    expect(prepared.normalizeInput({ nested: null })).toEqual({});
  });

  it('rejects typeless open object schemas instead of narrowing them', () => {
    const input = {
      type: 'object',
      properties: {
        open: {
          properties: {
            value: { type: 'string' },
          },
        },
      },
      required: ['open'],
      additionalProperties: false,
    };

    expect(() => toOpenAIStrictToolSchema(input as any)).toThrow(
      'Cannot convert a typeless open JSON schema to strict mode.',
    );
  });

  it('strips strict nulls from optional JSON Schema object and array fields', () => {
    const schema = {
      type: 'object',
      properties: {
        required: { type: 'string' },
        optional: { type: 'number' },
        nullableOptional: {
          anyOf: [{ type: 'string' }, { type: 'null' }],
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
        nullableObject: {
          type: ['object', 'null'],
          properties: {
            optionalChild: { type: 'boolean' },
          },
          required: [],
        },
      },
      required: ['required', 'tuple', 'list', 'nullableObject'],
    };

    expect(
      stripStrictNullsForJsonSchema(schema, {
        required: 'ok',
        optional: null,
        nullableOptional: null,
        tuple: ['x', null],
        list: [{ optionalChild: null }],
        nullableObject: { optionalChild: null },
      }),
    ).toEqual({
      required: 'ok',
      nullableOptional: null,
      tuple: ['x', null],
      list: [{}],
      nullableObject: {},
    });
  });

  it.each([
    ['$defs', '$defs', '#/$defs/payload'],
    ['legacy definitions', 'definitions', '#/definitions/payload'],
  ])('strips strict nulls through %s references', (_name, key, $ref) => {
    const schema = {
      type: 'object',
      properties: {
        payload: { $ref },
      },
      required: ['payload'],
      [key]: {
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

  it('decodes URI and JSON Pointer reference tokens', () => {
    const schema = {
      type: 'object',
      properties: {
        payload: { $ref: '#/$defs/path%20with~1slash~0tilde' },
      },
      required: ['payload'],
      $defs: {
        'path with/slash~tilde': {
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

  it('decodes URI fragments before splitting JSON Pointer tokens', () => {
    const schema = {
      type: 'object',
      properties: {
        payload: { $ref: '#%2F$defs%2Fgroup%2F$defs%2Fpayload' },
      },
      required: ['payload'],
      $defs: {
        group: {
          $defs: {
            payload: {
              type: 'object',
              properties: {
                note: { type: 'string' },
              },
              required: [],
            },
          },
        },
        'group/$defs/payload': {
          type: 'object',
          properties: {
            note: { type: ['string', 'null'] },
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

  it('resolves references against original schema pointer paths', () => {
    const schema = {
      type: 'object',
      properties: {
        alias: {
          $ref: '#/$defs/payload/properties/optionalContainer/properties/target',
        },
      },
      required: ['alias'],
      $defs: {
        payload: {
          type: 'object',
          properties: {
            optionalContainer: {
              type: 'object',
              properties: {
                target: {
                  type: 'object',
                  properties: { child: { type: 'string' } },
                  required: [],
                },
              },
              required: [],
            },
          },
          required: [],
        },
      },
    };

    expect(
      stripStrictNullsForJsonSchema(schema, {
        alias: { child: null },
      }),
    ).toEqual({ alias: {} });
  });

  it('stabilizes references to schemas outside the ordinary conversion walk', () => {
    const schema = {
      type: 'object',
      properties: {
        payload: { $ref: '#/$defs/scalar/properties/target' },
      },
      required: ['payload'],
      $defs: {
        scalar: {
          type: 'string',
          properties: {
            target: {
              type: 'object',
              properties: { note: { type: 'string' } },
              required: [],
            },
          },
        },
      },
    };

    const prepared = prepareOpenAIStrictToolSchema(schema as any);
    const reference = (prepared.schema.properties.payload as any).$ref;

    expect(reference).toMatch(/^#\/\$defs\/__openai_strict_ref_/);
    expect(prepared.normalizeInput({ payload: { note: null } })).toEqual({
      payload: {},
    });
  });

  it('stabilizes references to schemas replaced during strict conversion', () => {
    const schema = {
      type: 'object',
      properties: {
        payload: { $ref: '#/$defs/container/additionalProperties' },
      },
      required: ['payload'],
      $defs: {
        container: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: {
            type: 'object',
            properties: { note: { type: 'string' } },
            required: [],
          },
        },
      },
    };

    const prepared = prepareOpenAIStrictToolSchema(schema as any);

    expect((prepared.schema.properties.payload as any).$ref).toMatch(
      /^#\/\$defs\/__openai_strict_ref_/,
    );
    expect(prepared.normalizeInput({ payload: { note: null } })).toEqual({
      payload: {},
    });
  });

  it('rejects references created only by strict conversion', () => {
    const schema = {
      type: 'object',
      properties: {
        alias: {
          $ref: '#/$defs/payload/properties/note/anyOf/0',
        },
      },
      required: ['alias'],
      $defs: {
        payload: {
          type: 'object',
          properties: {
            note: {
              type: 'object',
              properties: { child: { type: 'string' } },
              required: [],
            },
          },
          required: [],
        },
      },
    };

    expect(() => toOpenAIStrictToolSchema(schema as any)).toThrow(
      'Cannot convert unresolved or external JSON schema reference',
    );
  });

  it('preserves canonical prepared nodes for reused schema objects', () => {
    const shared = {
      type: 'object',
      properties: { note: { type: 'string' } },
      required: [],
    };
    const schema = {
      type: 'object',
      properties: {
        requiredAlias: { $ref: '#/$defs/a/properties/note' },
        optionalAlias: { $ref: '#/$defs/a/properties/note' },
        a: { $ref: '#/$defs/a' },
        b: { $ref: '#/$defs/b' },
      },
      required: ['requiredAlias', 'a', 'b'],
      $defs: { a: shared, b: shared },
    };

    expect(
      stripStrictNullsForJsonSchema(schema, {
        requiredAlias: null,
        optionalAlias: null,
        a: { note: null },
        b: { note: null },
      }),
    ).toEqual({ requiredAlias: null, a: {}, b: {} });
  });

  it.each([
    ['required first', ['requiredOwner', 'optionalOwner']],
    ['optional first', ['optionalOwner', 'requiredOwner']],
  ])(
    'keeps shared property containers contextual with %s',
    (_name, propertyOrder) => {
      const sharedProperties = { value: { type: 'string' } };
      const owners = {
        requiredOwner: {
          type: 'object',
          properties: sharedProperties,
          required: ['value'],
        },
        optionalOwner: {
          type: 'object',
          properties: sharedProperties,
          required: [],
        },
      };
      const properties = Object.fromEntries(
        propertyOrder.map((key) => [key, owners[key as keyof typeof owners]]),
      );
      const schema = {
        type: 'object',
        properties,
        required: propertyOrder,
      };

      const prepared = prepareOpenAIStrictToolSchema(schema as any);

      expect(
        prepared.normalizeInput({
          requiredOwner: { value: null },
          optionalOwner: { value: null },
        }),
      ).toEqual({
        requiredOwner: { value: null },
        optionalOwner: {},
      });
    },
  );

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

  it('preserves null allowed by a referenced schema', () => {
    const schema = {
      type: 'object',
      properties: {
        value: { $ref: '#/$defs/value' },
      },
      required: [],
      $defs: {
        value: { type: ['string', 'null'] },
      },
    };

    expect(stripStrictNullsForJsonSchema(schema, { value: null })).toEqual({
      value: null,
    });
  });

  it('preserves null allowed through a referenced union branch', () => {
    const schema = {
      type: 'object',
      properties: {
        value: { $ref: '#/$defs/maybeValue' },
      },
      required: [],
      $defs: {
        maybeValue: {
          anyOf: [{ type: 'string' }, { $ref: '#/$defs/nullValue' }],
        },
        nullValue: { type: 'null' },
      },
    };

    expect(stripStrictNullsForJsonSchema(schema, { value: null })).toEqual({
      value: null,
    });
  });

  it('preserves null allowed by enum-only and const-only schemas', () => {
    const schema = {
      type: 'object',
      properties: {
        enumValue: { enum: ['value', null] },
        constValue: { $ref: '#/$defs/nullValue' },
      },
      required: [],
      $defs: {
        nullValue: { const: null },
      },
    };

    expect(
      stripStrictNullsForJsonSchema(schema, {
        enumValue: null,
        constValue: null,
      }),
    ).toEqual({ enumValue: null, constValue: null });
  });

  it('normalizes optional boolean JSON Schema nodes', () => {
    const schema = {
      type: 'object',
      properties: {
        directTrue: true,
        directFalse: false,
        referencedTrue: { $ref: '#/$defs/trueSchema' },
        referencedFalse: { $ref: '#/$defs/falseSchema' },
        unionTrue: { anyOf: [false, true] },
        unionFalse: { anyOf: [false, { const: 'value' }] },
      },
      required: [],
      $defs: {
        trueSchema: true,
        falseSchema: false,
      },
      additionalProperties: false,
    };

    const prepared = prepareOpenAIStrictToolSchema(schema as any);
    expect(
      prepared.normalizeInput({
        directTrue: null,
        directFalse: null,
        referencedTrue: null,
        referencedFalse: null,
        unionTrue: null,
        unionFalse: null,
      }),
    ).toEqual({
      directTrue: null,
      referencedTrue: null,
      unionTrue: null,
    });
  });

  it.each([
    ['not', { not: { type: 'null' } }],
    ['oneOf', { oneOf: [{ type: 'string' }, { type: 'null' }] }],
    ['allOf', { allOf: [{ type: 'string' }] }],
    ['if', { if: { type: 'string' }, then: { const: 'value' } }],
    [
      'patternProperties',
      { patternProperties: { '^value$': { type: 'string' } } },
    ],
    ['contains', { type: 'array', contains: { type: 'string' } }],
    ['prefixItems', { prefixItems: [{ type: 'string' }] }],
  ])('rejects unsupported strict `%s` schemas', (keyword, propertySchema) => {
    const schema = {
      type: 'object',
      properties: { value: propertySchema },
      required: [],
    };

    expect(() => toOpenAIStrictToolSchema(schema as any)).toThrow(
      `unsupported keyword \`${keyword}\``,
    );
  });

  it('rejects unsupported keywords in retained schema locations', () => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          type: 'string',
          properties: {
            ignored: { allOf: [{ type: 'string' }] },
          },
        },
      },
      required: ['value'],
      additionalProperties: false,
    };

    expect(() => toOpenAIStrictToolSchema(schema as any)).toThrow(
      'unsupported keyword `allOf`',
    );
  });

  it.each([
    [
      '$ref',
      {
        type: 'object',
        $ref: '#/$defs/value',
        properties: { local: { type: 'string' } },
        required: [],
      },
    ],
    [
      'anyOf',
      {
        anyOf: [{ type: 'object' }],
        properties: { local: { type: 'string' } },
        required: [],
      },
    ],
  ])(
    'rejects ambiguous `%s` sibling constraints',
    (keyword, propertySchema) => {
      const schema = {
        type: 'object',
        properties: { value: propertySchema },
        required: [],
        $defs: { value: { type: 'object' } },
      };

      expect(() => toOpenAIStrictToolSchema(schema as any)).toThrow(
        `combining \`${keyword}\` with sibling keyword`,
      );
    },
  );

  it('rejects branch-aware normalization for plain anyOf schemas', () => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          anyOf: [
            {
              type: 'object',
              properties: {
                kind: { const: 'text' },
                note: { type: 'string' },
              },
              required: ['kind'],
            },
            {
              type: 'object',
              properties: {
                kind: { const: 'count' },
                count: { type: 'number' },
              },
              required: ['kind'],
            },
          ],
        },
      },
      required: ['value'],
    };

    expect(() => prepareOpenAIStrictToolSchema(schema as any)).toThrow(
      '`anyOf` branch containing optional object properties',
    );
  });

  it('ignores inapplicable properties when checking plain anyOf branches', () => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          anyOf: [
            {
              type: 'string',
              properties: { ignored: { type: 'string' } },
            },
            { type: 'number' },
          ],
        },
      },
      required: ['value'],
    };

    expect(() => prepareOpenAIStrictToolSchema(schema as any)).not.toThrow();
  });

  it('leaves schemas outside the local normalization traversal unchanged', () => {
    const schema = {
      type: 'object',
      properties: {
        booleanSchema: true,
        stringWithInapplicableProperties: {
          type: 'string',
          properties: {
            ignored: { type: 'null' },
          },
        },
      },
      required: ['booleanSchema', 'stringWithInapplicableProperties'],
    };

    expect(toOpenAIStrictToolSchema(schema as any)).toEqual({
      ...schema,
      additionalProperties: false,
    });
  });

  it('does not normalize values through inapplicable properties', () => {
    const sharedTarget = {
      type: 'object',
      properties: { note: { type: 'string' } },
      required: [],
    };
    const schema = {
      type: 'object',
      properties: {
        scalar: {
          type: 'string',
          properties: { ignored: sharedTarget },
        },
      },
      required: ['scalar'],
      $defs: { sharedTarget },
    };

    const prepared = prepareOpenAIStrictToolSchema(schema as any);

    expect(
      prepared.normalizeInput({ scalar: { ignored: { note: null } } }),
    ).toEqual({ scalar: { ignored: { note: null } } });
  });

  it('rejects nested JSON Schema resource scopes', () => {
    const schema = {
      type: 'object',
      properties: {
        payload: { $ref: '#/$defs/container' },
      },
      required: ['payload'],
      $defs: {
        target: { type: ['string', 'null'] },
        container: {
          $id: 'https://example.com/container',
          type: 'object',
          properties: {
            value: { $ref: '#/$defs/target' },
          },
          required: ['value'],
          $defs: {
            target: { type: 'string' },
          },
        },
      },
    };

    expect(() => toOpenAIStrictToolSchema(schema as any)).toThrow(
      'nested `$id` resource',
    );
  });

  it.each([
    [
      'cyclic',
      '#/$defs/first',
      {
        first: { $ref: '#/$defs/second' },
        second: { $ref: '#/$defs/first' },
      },
    ],
    ['unresolved', '#/$defs/missing', {}],
    ['external', 'https://example.com/schema.json#/$defs/payload', {}],
  ])('rejects indeterminate %s references', (_name, $ref, $defs) => {
    const schema = {
      type: 'object',
      properties: { payload: { $ref } },
      required: [],
      $defs,
    };

    expect(() => toOpenAIStrictToolSchema(schema as any)).toThrow();
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
