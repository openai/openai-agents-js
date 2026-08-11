import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { UserError } from '../../src/errors';
import {
  prepareOpenAIStrictToolSchema,
  stripStrictNullsForJsonSchema,
  stripStrictNullsForZodSchema,
  toOpenAIStrictToolSchema,
} from '../../src/utils/strictToolSchema';

const SCHEMA_DEPTH_ERROR =
  'JSON schema is too deeply nested to process safely. Simplify or flatten the schema, or disable strict mode.';

function createNestedObjectSchema(depth: number): Record<string, any> {
  const root = {
    type: 'object',
    properties: {},
    required: [],
  } as Record<string, any>;
  let current = root;

  for (let index = 0; index < depth; index += 1) {
    const child = {
      type: 'object',
      properties: {},
      required: [],
    };
    current.properties.child = child;
    current = child;
  }

  return root;
}

function createChainedReferenceSchema(depth: number): Record<string, any> {
  const definitions: Record<string, Record<string, unknown>> = {};
  for (let index = 0; index < depth; index += 1) {
    definitions[`level${index}`] = {
      $ref: `#/$defs/level${index + 1}`,
    };
  }
  definitions[`level${depth}`] = { type: 'string' };

  return {
    type: 'object',
    properties: {
      value: { $ref: '#/$defs/level0' },
    },
    required: ['value'],
    $defs: definitions,
  };
}

function createSegmentedReferenceSchema(
  segmentCount: number,
  segmentLength: number,
  includeOptionalProperty = true,
): Record<string, any> {
  const definitions: Record<string, Record<string, unknown>> = {
    terminal: { type: 'string' },
  };
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  let previousReference = '#/$defs/terminal';

  for (let segment = 0; segment < segmentCount; segment += 1) {
    for (let index = 0; index < segmentLength; index += 1) {
      const name = `segment${segment}_${index}`;
      const nextReference =
        index + 1 < segmentLength
          ? `#/$defs/segment${segment}_${index + 1}`
          : previousReference;
      definitions[name] = { $ref: nextReference };
    }

    previousReference = `#/$defs/segment${segment}_0`;
    const checkpoint = `checkpoint${segment}`;
    properties[checkpoint] = { $ref: previousReference };
    required.push(checkpoint);
  }

  if (includeOptionalProperty) {
    properties.optional = { $ref: previousReference };
  }
  return {
    type: 'object',
    properties,
    required,
    $defs: definitions,
  };
}

function createRecursiveDefinitionSchema(): Record<string, any> {
  return {
    type: 'object',
    properties: {
      root: { $ref: '#/$defs/node' },
    },
    required: ['root'],
    additionalProperties: false,
    $defs: {
      node: {
        type: 'object',
        properties: {
          value: { type: 'string' },
          children: {
            type: 'array',
            items: { $ref: '#/$defs/node' },
          },
        },
        required: ['value', 'children'],
        additionalProperties: false,
      },
    },
  };
}

function createWideRecursiveDefinitionSchema(
  definitionCount: number,
): Record<string, any> {
  const definitions: Record<string, Record<string, unknown>> = {};
  for (let index = 0; index < definitionCount; index += 1) {
    definitions[`node${index}`] = { $ref: '#' };
  }

  return {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
    $defs: definitions,
  };
}

function createCyclicReferenceSchema(length: number): Record<string, any> {
  const definitions: Record<string, Record<string, unknown>> = {};
  for (let index = 0; index < length; index += 1) {
    definitions[`node${index}`] = {
      $ref: `#/$defs/node${(index + 1) % length}`,
    };
  }

  return {
    type: 'object',
    properties: {
      value: { $ref: '#/$defs/node0' },
    },
    required: ['value'],
    $defs: definitions,
  };
}

function createHybridRecursiveReferenceSchema(): Record<string, any> {
  const definitions: Record<string, Record<string, unknown>> = {
    terminal: { type: 'string' },
  };

  for (let index = 0; index < 20; index += 1) {
    definitions[`tail${index}`] = {
      $ref: index < 19 ? `#/$defs/tail${index + 1}` : '#/$defs/terminal',
    };
  }

  for (const prefix of ['a', 'b']) {
    for (let index = 0; index < 80; index += 1) {
      definitions[`${prefix}${index}`] = {
        $ref: index < 79 ? `#/$defs/${prefix}${index + 1}` : '#/$defs/shared',
      };
    }
  }

  definitions.shared = { $ref: '#/$defs/recursive' };
  definitions.recursive = {
    anyOf: [{ $ref: '#/$defs/a0' }, { $ref: '#/$defs/tail0' }],
  };

  return {
    type: 'object',
    properties: {
      alternate: { $ref: '#/$defs/b0' },
      checkpoint: { $ref: '#/$defs/recursive' },
    },
    required: ['checkpoint', 'alternate'],
    additionalProperties: false,
    $defs: definitions,
  };
}

function captureError(callback: () => unknown): unknown {
  try {
    callback();
    return undefined;
  } catch (error) {
    return error;
  }
}

function expectSchemaDepthError(error: unknown): void {
  expect(error).toBeInstanceOf(UserError);
  expect(error).not.toBeInstanceOf(RangeError);
  expect((error as Error).message).toBe(SCHEMA_DEPTH_ERROR);
}

describe('utils/strictToolSchema', () => {
  it('rejects schemas that exceed the safe container depth', () => {
    const input = createNestedObjectSchema(1_000);

    const error = captureError(() => toOpenAIStrictToolSchema(input as any));

    expectSchemaDepthError(error);
    expect(input).not.toHaveProperty('additionalProperties');
    expect(input.properties.child).not.toHaveProperty('additionalProperties');
  });

  it('rejects schemas that exceed the safe local reference depth', () => {
    const input = createChainedReferenceSchema(1_000);

    const error = captureError(() => toOpenAIStrictToolSchema(input as any));

    expectSchemaDepthError(error);
    expect(input.properties.value).toEqual({ $ref: '#/$defs/level0' });
  });

  it('rejects shared reference suffixes reached beyond the safe depth', () => {
    const input = createSegmentedReferenceSchema(100, 60);

    const error = captureError(() => toOpenAIStrictToolSchema(input as any));

    expectSchemaDepthError(error);
    expect(input.properties.optional).toEqual({
      $ref: '#/$defs/segment99_0',
    });
  });

  it('rejects required-only shared reference suffixes reached beyond the safe depth', () => {
    const input = createSegmentedReferenceSchema(2, 60, false);
    const original = structuredClone(input);

    const error = captureError(() => toOpenAIStrictToolSchema(input as any));

    expectSchemaDepthError(error);
    expect(input).toEqual(original);
  });

  it('enforces the safe local reference depth boundary', () => {
    expect(() =>
      toOpenAIStrictToolSchema(createChainedReferenceSchema(97) as any),
    ).not.toThrow();

    const error = captureError(() =>
      toOpenAIStrictToolSchema(createChainedReferenceSchema(98) as any),
    );
    expectSchemaDepthError(error);
  });

  it('preserves direct root recursion at the safe depth boundary', () => {
    const accepted = createChainedReferenceSchema(97);
    accepted.$defs.level97 = { $ref: '#' };
    expect(() => toOpenAIStrictToolSchema(accepted as any)).not.toThrow();

    const rejected = createChainedReferenceSchema(98);
    rejected.$defs.level98 = { $ref: '#' };
    const error = captureError(() => toOpenAIStrictToolSchema(rejected as any));

    expectSchemaDepthError(error);
  });

  it('preserves recursive local definitions without mutating the input', () => {
    const input = createRecursiveDefinitionSchema();
    const original = structuredClone(input);

    const result = toOpenAIStrictToolSchema(input as any);

    expect(result.properties.root).toEqual({ $ref: '#/$defs/node' });
    expect(result.$defs.node.properties.children.items).toEqual({
      $ref: '#/$defs/node',
    });
    expect(input).toEqual(original);
  });

  it('preserves wide shallow recursive definitions without mutating the input', () => {
    const input = createWideRecursiveDefinitionSchema(100);
    const original = structuredClone(input);

    const result = toOpenAIStrictToolSchema(input as any);

    expect(result.$defs.node0).toEqual({ $ref: '#' });
    expect(result.$defs.node99).toEqual({ $ref: '#' });
    expect(input).toEqual(original);
  });

  it('enforces the safe depth boundary for recursive components', () => {
    expect(() =>
      toOpenAIStrictToolSchema(createCyclicReferenceSchema(98) as any),
    ).not.toThrow();

    const error = captureError(() =>
      toOpenAIStrictToolSchema(createCyclicReferenceSchema(99) as any),
    );
    expectSchemaDepthError(error);
  });

  it('rejects over-depth paths leaving recursive components', () => {
    const input = createHybridRecursiveReferenceSchema();

    const error = captureError(() => toOpenAIStrictToolSchema(input as any));

    expectSchemaDepthError(error);
  });

  it('continues to convert reasonably nested schemas without mutation', () => {
    const input = createNestedObjectSchema(10);

    const result = toOpenAIStrictToolSchema(input as any);

    expect(result.additionalProperties).toBe(false);
    expect(input).not.toHaveProperty('additionalProperties');
    expect(input.properties.child).not.toHaveProperty('additionalProperties');
  });

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
