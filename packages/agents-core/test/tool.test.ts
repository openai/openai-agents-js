import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import {
  applyPatchTool,
  computerTool,
  hostedMcpTool,
  invokeFunctionTool,
  shellTool,
  tool,
  toolNamespace,
  resolveComputer,
  disposeResolvedComputers,
} from '../src/tool';
import type { ShellTool } from '../src/tool';
import { z } from 'zod';
import { z as zod3 } from 'zod/v3';
import { Computer } from '../src';
import { Agent } from '../src/agent';
import { RunContext } from '../src/runContext';
import { serializeTool } from '../src/utils/serialize';
import { FakeEditor, FakeShell } from './stubs';
import {
  InvalidToolInputError,
  InvalidToolOutputError,
  ToolTimeoutError,
  UserError,
} from '../src/errors';
import type { JsonObjectSchema, JsonObjectSchemaNonStrict } from '../src/types';
import logger from '../src/logger';

interface Bar {
  bar: string;
}

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

function createSegmentedReferenceSchema(): Record<string, any> {
  const definitions: Record<string, Record<string, unknown>> = {
    terminal: { type: 'string' },
  };
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  let previousReference = '#/$defs/terminal';

  for (let segment = 0; segment < 2; segment += 1) {
    for (let index = 0; index < 60; index += 1) {
      const name = `segment${segment}_${index}`;
      definitions[name] = {
        $ref:
          index < 59
            ? `#/$defs/segment${segment}_${index + 1}`
            : previousReference,
      };
    }
    previousReference = `#/$defs/segment${segment}_0`;
    const checkpoint = `checkpoint${segment}`;
    properties[checkpoint] = { $ref: previousReference };
    required.push(checkpoint);
  }

  return { type: 'object', properties, required, $defs: definitions };
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

function createWideRecursiveDefinitionSchema(): Record<string, any> {
  const definitions: Record<string, Record<string, unknown>> = {};
  for (let index = 0; index < 100; index += 1) {
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

function captureToolConstructionError(callback: () => unknown): unknown {
  try {
    callback();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('Tool', () => {
  it('create a tool with zod definition', () => {
    const t = tool({
      name: 'test',
      description: 'test',
      parameters: z.object({
        foo: z.string(),
      }),
      execute: async ({ foo }): Promise<Bar> => {
        expect(typeof foo).toBe('string');
        return { bar: `foo: ${foo}` };
      },
    });
    expect(Object.keys(t.parameters.properties).length).toEqual(1);
    expect(t.parameters.required.length).toEqual(1);
  });

  it('supports strict Zod object intersections', async () => {
    const execute = vi.fn(() => 'ok');
    const t = tool({
      name: 'zod_intersection',
      description: 'Use a strict Zod object intersection.',
      parameters: z.object({
        combined: z.intersection(
          z.object({ optional: z.string().optional() }),
          z.object({ required: z.number() }),
        ),
      }),
      execute,
    });

    expect(serializeTool(t)).toMatchObject({
      strict: true,
      parameters: {
        properties: {
          combined: {
            type: 'object',
            properties: {
              optional: {
                anyOf: [{ type: 'string' }, { type: 'null' }],
              },
              required: { type: 'number' },
            },
            required: ['optional', 'required'],
            additionalProperties: false,
          },
        },
      },
    });

    await t.invoke(
      new RunContext(),
      JSON.stringify({ combined: { optional: null, required: 1 } }),
    );

    expect(execute).toHaveBeenCalledWith(
      { combined: { required: 1 } },
      expect.any(RunContext),
      undefined,
    );
  });

  it('supports strict Zod v3 object intersections', async () => {
    const execute = vi.fn(() => 'ok');
    const parameters = zod3.object({
      combined: zod3.intersection(
        zod3.object({ optional: zod3.string().optional() }),
        zod3.object({ required: zod3.number() }),
      ),
    });
    const t = tool({
      name: 'zod_v3_intersection',
      description: 'Use a strict Zod v3 object intersection.',
      parameters: parameters as any,
      execute,
    });

    await t.invoke(
      new RunContext(),
      JSON.stringify({ combined: { optional: null, required: 1 } }),
    );

    expect(execute).toHaveBeenCalledWith(
      { combined: { required: 1 } },
      expect.any(RunContext),
      undefined,
    );
  });

  it('rejects strict Zod v3 strict-object intersections', () => {
    expect(() =>
      tool({
        name: 'strict_zod_v3_intersection',
        description: 'Reject an incompatible strict Zod v3 intersection.',
        parameters: zod3.object({
          combined: zod3.intersection(
            zod3.object({ left: zod3.string() }).strict(),
            zod3.object({ right: zod3.number() }).strict(),
          ),
        }) as any,
        execute: async () => 'ok',
      }),
    ).toThrow('closed object branches');
  });

  it.each([
    [
      'map-valued patternProperties',
      {
        type: 'object',
        patternProperties: { '^value$': { type: 'string' } },
        additionalProperties: false,
      },
    ],
    [
      'singleton contains',
      {
        type: 'array',
        items: { type: 'string' },
        contains: { type: 'string' },
      },
    ],
    [
      'array-valued prefixItems',
      {
        type: 'array',
        prefixItems: [{ type: 'string' }],
      },
    ],
  ])('rejects unsupported strict JSON Schema %s', (_, valueSchema) => {
    expect(() =>
      tool({
        name: 'unsupported_strict_schema_container',
        description: 'Reject an unsupported strict schema container.',
        parameters: {
          type: 'object',
          properties: { value: valueSchema },
          required: ['value'],
          additionalProperties: false,
        } as any,
        execute: async () => 'ok',
      }),
    ).toThrow('unsupported keyword');
  });

  it.each([
    [
      'property schema',
      {
        type: 'object',
        properties: { value: 1 },
        required: ['value'],
        additionalProperties: false,
      },
    ],
    [
      'anyOf branch',
      {
        type: 'object',
        properties: { value: { anyOf: [{ type: 'string' }, 1] } },
        required: ['value'],
        additionalProperties: false,
      },
    ],
    [
      'additionalProperties schema',
      {
        type: 'object',
        properties: { value: { type: 'string', additionalProperties: 1 } },
        required: ['value'],
        additionalProperties: false,
      },
    ],
    [
      '$ref target',
      {
        type: 'object',
        properties: { value: { $ref: '#/required' } },
        required: ['value'],
        additionalProperties: false,
      },
    ],
  ])('rejects an invalid strict JSON Schema %s', (_, parameters) => {
    expect(() =>
      tool({
        name: 'invalid_strict_schema_node',
        description: 'Reject an invalid strict schema node.',
        parameters: parameters as any,
        execute: async () => 'ok',
      }),
    ).toThrow('non-boolean, non-object schema node');
  });

  it('preserves upstream support for strict typed Zod intersections', () => {
    const t = tool({
      name: 'typed_zod_intersection',
      description: 'Use a strict typed Zod intersection.',
      parameters: z.object({
        value: z.intersection(z.string(), z.string()),
      }),
      execute: async () => 'ok',
    });

    expect((serializeTool(t) as any).parameters.properties.value).toMatchObject(
      { type: 'string' },
    );
  });

  it('supports strict Zod v3 typed intersections without allOf', () => {
    const t = tool({
      name: 'typed_zod_v3_intersection',
      description: 'Use a strict typed Zod v3 intersection.',
      parameters: zod3.object({
        value: zod3.intersection(zod3.string(), zod3.string()),
      }) as any,
      execute: async () => 'ok',
    });

    expect((serializeTool(t) as any).parameters.properties.value).toEqual({
      type: 'string',
    });
  });

  it('preserves upstream Zod v4 constraints beside typed intersections', () => {
    const t = tool({
      name: 'constrained_typed_zod_v4_intersection',
      description: 'Preserve upstream strict Zod v4 constraints.',
      parameters: z.object({
        value: z.intersection(z.string(), z.string()),
        constrained: z.string().min(3),
      }),
      execute: async () => 'ok',
    });

    expect(
      (serializeTool(t) as any).parameters.properties.constrained,
    ).toMatchObject({ type: 'string', minLength: 3 });
  });

  it('does not treat a property named allOf as an applicator', () => {
    const t = tool({
      name: 'all_of_property',
      description: 'Keep a regular property named allOf.',
      parameters: z.object({
        value: z.intersection(z.string(), z.string()),
        allOf: z.string().min(3),
      }),
      execute: async () => 'ok',
    });

    expect((serializeTool(t) as any).parameters.properties).toMatchObject({
      value: { type: 'string' },
      allOf: { type: 'string', minLength: 3 },
    });
  });

  it('does not inspect default values for allOf applicators', () => {
    const t = tool({
      name: 'all_of_default_value',
      description: 'Keep allOf instance data in a default value.',
      parameters: z.object({
        value: z.intersection(z.string(), z.string()),
        config: z
          .object({ allOf: z.array(z.string()).min(1) })
          .default({ allOf: ['x'] }),
      }),
      execute: async () => 'ok',
    });

    expect(
      (serializeTool(t) as any).parameters.properties.config,
    ).toMatchObject({
      default: { allOf: ['x'] },
      properties: {
        allOf: { type: 'array', minItems: 1 },
      },
    });
  });

  it('preserves constrained strict Zod fallbacks without intersections', () => {
    const t = tool({
      name: 'constrained_zod_fallback',
      description: 'Preserve an existing constrained strict Zod fallback.',
      parameters: z.object({
        command: z.string().min(1),
        retries: z.number().int().min(0).default(0),
      }),
      execute: async () => 'ok',
    });

    expect(serializeTool(t)).toMatchObject({
      parameters: {
        properties: {
          command: { type: 'string' },
          retries: { type: 'integer' },
        },
      },
    });
  });

  it('runs Zod callbacks once while stripping a synthetic null', async () => {
    let transforms = 0;
    let refinements = 0;
    let defaults = 0;
    const execute = vi.fn(() => 'ok');
    const t = tool({
      name: 'effectful_zod_fields',
      description: 'Normalize without repeating Zod callbacks.',
      parameters: zod3.object({
        optional: zod3.string().optional(),
        transformed: zod3.string().transform((value) => {
          transforms += 1;
          return value.toUpperCase();
        }),
        refined: zod3.string().superRefine(() => {
          refinements += 1;
        }),
        defaulted: zod3.string().default(() => {
          defaults += 1;
          return 'default';
        }),
      }) as any,
      execute,
    });

    await t.invoke(
      new RunContext(),
      JSON.stringify({ optional: null, transformed: 'x', refined: 'y' }),
    );

    expect(execute).toHaveBeenCalledWith(
      { transformed: 'X', refined: 'y', defaulted: 'default' },
      expect.any(RunContext),
      undefined,
    );
    expect(transforms).toBe(1);
    expect(refinements).toBe(1);
    expect(defaults).toBe(1);
  });

  it.each([
    [
      'Zod v4',
      z.object({
        combined: z.intersection(
          z.object({ left: z.string() }),
          z.object({ right: z.number() }),
        ),
        constrained: z.string().min(3),
      }),
    ],
    [
      'Zod v3',
      zod3.object({
        combined: zod3.intersection(
          zod3.object({ left: zod3.string() }),
          zod3.object({ right: zod3.number() }),
        ),
        constrained: zod3.string().min(3),
      }),
    ],
    [
      'direct Zod v4 format',
      z.object({
        combined: z.intersection(
          z.object({ left: z.string() }),
          z.object({ right: z.number() }),
        ),
        constrained: z.email(),
      }),
    ],
  ])(
    'rejects lossy whole-schema %s intersection fallbacks',
    (_, parameters) => {
      expect(() =>
        tool({
          name: 'constrained_zod_intersection',
          description: 'Reject a lossy strict Zod intersection fallback.',
          parameters: parameters as any,
          execute: async () => 'ok',
        }),
      ).toThrow('without losing constraints');
    },
  );

  it('supports compatible typed and object intersections together', () => {
    const t = tool({
      name: 'mixed_zod_intersections',
      description: 'Use compatible strict Zod intersections.',
      parameters: z.object({
        objectValue: z.intersection(
          z.object({ left: z.string() }),
          z.object({ right: z.number() }),
        ),
        typedValue: z.intersection(z.string(), z.string()),
      }),
      execute: async () => 'ok',
    });

    expect(serializeTool(t)).toMatchObject({
      parameters: {
        properties: {
          objectValue: {
            type: 'object',
            properties: {
              left: { type: 'string' },
              right: { type: 'number' },
            },
          },
          typedValue: { type: 'string' },
        },
      },
    });
  });

  it.each([
    [
      'Zod v4 root passthrough',
      z
        .object({
          combined: z.intersection(
            z.object({ left: z.string() }),
            z.object({ right: z.number() }),
          ),
        })
        .passthrough(),
    ],
    [
      'Zod v4 root refinement',
      z
        .object({
          combined: z.intersection(
            z.object({ left: z.string() }),
            z.object({ right: z.number() }),
          ),
        })
        .refine(() => false),
    ],
    [
      'Zod v3 root catchall',
      zod3
        .object({
          combined: zod3.intersection(
            zod3.object({ left: zod3.string() }),
            zod3.object({ right: zod3.number() }),
          ),
        })
        .catchall(zod3.string()),
    ],
  ])('rejects lossy %s whole-schema fallbacks', (_, parameters) => {
    expect(() =>
      tool({
        name: 'lossy_root_zod_intersection',
        description: 'Reject a lossy root strict Zod intersection fallback.',
        parameters: parameters as any,
        execute: async () => 'ok',
      }),
    ).toThrow('without losing constraints');
  });

  it('supports nested strict Zod v4 object intersections', async () => {
    const execute = vi.fn(() => 'ok');
    const nestedIntersection = z.intersection(
      z.object({ optional: z.string().optional() }),
      z.object({ required: z.number() }),
    );
    const t = tool({
      name: 'nested_zod_intersection',
      description: 'Use nested strict Zod object intersections.',
      parameters: z.object({
        nested: z.object({ combined: nestedIntersection }),
        list: z.array(nestedIntersection),
      }),
      execute,
    });

    expect(serializeTool(t)).toMatchObject({
      parameters: {
        properties: {
          nested: {
            properties: {
              combined: {
                properties: {
                  optional: {
                    anyOf: [{ type: 'string' }, { type: 'null' }],
                  },
                  required: { type: 'number' },
                },
              },
            },
          },
          list: {
            items: {
              properties: {
                optional: {
                  anyOf: [{ type: 'string' }, { type: 'null' }],
                },
                required: { type: 'number' },
              },
            },
          },
        },
      },
    });

    await t.invoke(
      new RunContext(),
      JSON.stringify({
        nested: { combined: { optional: null, required: 1 } },
        list: [{ optional: null, required: 2 }],
      }),
    );

    expect(execute).toHaveBeenCalledWith(
      {
        nested: { combined: { required: 1 } },
        list: [{ required: 2 }],
      },
      expect.any(RunContext),
      undefined,
    );
  });

  it('preserves strict Zod intersection branch descriptions', () => {
    const t = tool({
      name: 'described_zod_intersection',
      description: 'Preserve Zod intersection descriptions.',
      parameters: z.object({
        combined: z.intersection(
          z.object({ left: z.string() }).describe('Left-side semantics.'),
          z.object({ right: z.number() }).describe('Right-side semantics.'),
        ),
      }),
      execute: async () => 'ok',
    });

    expect(
      ((serializeTool(t) as any).parameters.properties.combined as any)
        .description,
    ).toBe('Left-side semantics.\n\nRight-side semantics.');
  });

  it.each([
    [
      'Zod v4',
      z.object({
        list: z.array(
          z
            .intersection(
              z.object({ left: z.string() }).describe('Left.'),
              z.object({ right: z.string() }).describe('Right.'),
            )
            .describe('Wrapper.'),
        ),
      }),
    ],
    [
      'Zod v3',
      zod3.object({
        list: zod3.array(
          zod3
            .intersection(
              zod3.object({ left: zod3.string() }).describe('Left.'),
              zod3.object({ right: zod3.string() }).describe('Right.'),
            )
            .describe('Wrapper.'),
        ),
      }),
    ],
  ])(
    'preserves nested %s intersection wrapper descriptions',
    (_, parameters) => {
      const t = tool({
        name: 'nested_described_zod_intersection',
        description: 'Preserve a nested Zod intersection description.',
        parameters: parameters as any,
        execute: async () => 'ok',
      });

      expect(
        ((serializeTool(t) as any).parameters.properties.list.items as any)
          .description,
      ).toBe('Wrapper.');
    },
  );

  it('rejects incompatible strict Zod intersections', () => {
    expect(() =>
      tool({
        name: 'incompatible_zod_intersection',
        description: 'Reject an incompatible strict Zod intersection.',
        parameters: z.object({
          value: z.intersection(
            z.object({ shared: z.string() }),
            z.object({ shared: z.number() }),
          ),
        }),
        execute: async () => 'ok',
      }),
    ).toThrow('compatible Zod object intersections with distinct properties');
  });

  it.each([
    [
      'Zod v4 passthrough',
      z.object({
        value: z.intersection(
          z.object({ left: z.string() }).passthrough(),
          z.object({ right: z.string() }),
        ),
      }),
    ],
    [
      'Zod v4 catchall',
      z.object({
        value: z.intersection(
          z.object({ left: z.string() }).catchall(z.string()),
          z.object({ right: z.string() }),
        ),
      }),
    ],
    [
      'Zod v3 passthrough',
      zod3.object({
        value: zod3.intersection(
          zod3.object({ left: zod3.string() }).passthrough(),
          zod3.object({ right: zod3.string() }),
        ),
      }),
    ],
    [
      'Zod v3 catchall',
      zod3.object({
        value: zod3.intersection(
          zod3.object({ left: zod3.string() }).catchall(zod3.string()),
          zod3.object({ right: zod3.string() }),
        ),
      }),
    ],
    [
      'decorated Zod v4 passthrough',
      z.object({
        value: z.intersection(
          z.object({ left: z.string() }).passthrough().readonly(),
          z.object({ right: z.string() }),
        ),
      }),
    ],
    [
      'decorated Zod v4 catchall',
      z.object({
        value: z.intersection(
          z
            .object({ left: z.string() })
            .catchall(z.string())
            .default({ left: 'default' }),
          z.object({ right: z.string() }),
        ),
      }),
    ],
    [
      'decorated Zod v3 passthrough',
      zod3.object({
        value: zod3.intersection(
          zod3.object({ left: zod3.string() }).passthrough().readonly(),
          zod3.object({ right: zod3.string() }),
        ),
      }),
    ],
  ])('rejects strict intersections with an open %s branch', (_, parameters) => {
    expect(() =>
      tool({
        name: 'open_zod_intersection',
        description: 'Reject an open strict Zod intersection.',
        parameters: parameters as any,
        execute: async () => 'ok',
      }),
    ).toThrow('closed object branches');
  });

  it('normalizes typeless nested objects in strict JSON schemas', () => {
    const parameters: JsonObjectSchema<any> = {
      type: 'object',
      properties: {
        nested: {
          properties: {
            optional: { type: 'string' },
          },
          required: [],
          additionalProperties: false,
        },
      },
      required: ['nested'],
      additionalProperties: false,
    };
    const t = tool({
      name: 'typeless_nested_object',
      description: 'Normalize a typeless nested object.',
      parameters,
      execute: async () => 'ok',
    });

    expect(serializeTool(t)).toMatchObject({
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          nested: {
            type: 'object',
            properties: {
              optional: {
                anyOf: [{ type: 'string' }, { type: 'null' }],
              },
            },
            required: ['optional'],
            additionalProperties: false,
          },
        },
        required: ['nested'],
        additionalProperties: false,
      },
    });
    expect(parameters.properties.nested).not.toHaveProperty('type');
  });

  it('preserves recursive local definitions in strict tools', () => {
    const parameters = createRecursiveDefinitionSchema();
    const original = structuredClone(parameters);
    const execute = vi.fn(async () => 'ok');

    const recursiveTool = tool({
      name: 'recursive_schema',
      description: 'Accept a recursive strict schema.',
      parameters: parameters as any,
      execute,
    });

    expect(recursiveTool.strict).toBe(true);
    expect(recursiveTool.parameters.properties.root).toEqual({
      $ref: '#/$defs/node',
    });
    expect(
      (recursiveTool.parameters as any).$defs.node.properties.children.items,
    ).toEqual({ $ref: '#/$defs/node' });
    expect(parameters).toEqual(original);
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves wide shallow recursive definitions in strict tools', () => {
    const parameters = createWideRecursiveDefinitionSchema();
    const original = structuredClone(parameters);
    const execute = vi.fn(async () => 'ok');

    const recursiveTool = tool({
      name: 'wide_recursive_schema',
      description: 'Accept a wide recursive strict schema.',
      parameters: parameters as any,
      execute,
    });

    expect(recursiveTool.strict).toBe(true);
    expect((recursiveTool.parameters as any).$defs.node0).toEqual({
      $ref: '#',
    });
    expect((recursiveTool.parameters as any).$defs.node99).toEqual({
      $ref: '#',
    });
    expect(parameters).toEqual(original);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['physical nesting', () => createNestedObjectSchema(1_000)],
    ['required-only shared reference suffixes', createSegmentedReferenceSchema],
  ])(
    'rejects overly deep strict schemas from %s and preserves non-strict schemas',
    (_name, createSchema) => {
      const parameters = createSchema();
      const execute = vi.fn(async () => 'ok');

      const error = captureToolConstructionError(() =>
        tool({
          name: 'overly_deep_strict_schema',
          description: 'Reject an overly deep strict schema.',
          parameters: parameters as any,
          execute,
        }),
      );

      expect(error).toBeInstanceOf(UserError);
      expect(error).not.toBeInstanceOf(RangeError);
      expect((error as Error).message).toBe(SCHEMA_DEPTH_ERROR);
      expect(execute).not.toHaveBeenCalled();
      expect(parameters).not.toHaveProperty('additionalProperties');

      const nonStrictTool = tool({
        name: 'overly_deep_non_strict_schema',
        description: 'Preserve an overly deep non-strict schema.',
        parameters: parameters as any,
        strict: false,
        execute,
      });

      expect(nonStrictTool.strict).toBe(false);
      expect(nonStrictTool.parameters).toBe(parameters);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('rejects typeless open objects when constructing strict tools', () => {
    const parameters: JsonObjectSchema<any> = {
      type: 'object',
      properties: {
        open: {
          properties: {},
          additionalProperties: true,
        },
      },
      required: ['open'],
      additionalProperties: false,
    };

    expect(() =>
      tool({
        name: 'typeless_open_object',
        description: 'Reject a typeless open object.',
        parameters,
        execute: async () => 'ok',
      }),
    ).toThrow(UserError);
    expect(parameters.properties.open).not.toHaveProperty('type');
  });

  it('preserves typeless open objects for non-strict tools', () => {
    const parameters: JsonObjectSchemaNonStrict<any> = {
      type: 'object',
      properties: {
        open: {
          properties: {},
          additionalProperties: true,
        },
      },
      required: ['open'],
      additionalProperties: true,
    };
    const t = tool({
      name: 'non_strict_typeless_open_object',
      description: 'Preserve a typeless open object.',
      parameters,
      strict: false,
      execute: async () => 'ok',
    });

    expect(serializeTool(t)).toMatchObject({
      strict: false,
      parameters,
    });
  });

  it('rejects unsupported schemas only for strict tools', () => {
    const parameters = {
      type: 'object',
      properties: {
        value: { not: { type: 'null' } },
      },
      required: [],
      additionalProperties: false,
    } as any;

    expect(() =>
      tool({
        name: 'strict_unsupported_schema',
        description: 'Reject an unsupported strict schema.',
        parameters,
        execute: async () => 'ok',
      }),
    ).toThrow('unsupported keyword `not`');

    expect(
      tool({
        name: 'non_strict_unsupported_schema',
        description: 'Allow an unsupported non-strict schema.',
        parameters,
        strict: false,
        execute: async () => 'ok',
      }).strict,
    ).toBe(false);
  });

  it('records deferLoading when requested', () => {
    const t = tool({
      name: 'deferred_lookup',
      description: 'Deferred lookup tool.',
      parameters: z.object({
        foo: z.string(),
      }),
      deferLoading: true,
      execute: async () => ({ bar: 'ok' }),
    });

    expect(t.deferLoading).toBe(true);
  });

  it('records provider data when requested', () => {
    const t = tool({
      name: 'provider_lookup',
      description: 'Provider-specific lookup tool.',
      parameters: z.object({
        query: z.string(),
      }),
      providerData: {
        anthropic: { deferLoading: true },
      },
      execute: async () => ({ bar: 'ok' }),
    });

    expect(t.providerData).toEqual({
      anthropic: { deferLoading: true },
    });
  });

  it('records Programmatic Tool Calling metadata', () => {
    const outputSchema = {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    } as any;
    const t = tool({
      name: 'structured_lookup',
      description: 'Return structured data.',
      parameters: z.object({ query: z.string() }),
      allowedCallers: ['programmatic'],
      outputSchema,
      execute: async ({ query }) => ({ value: query }),
    });

    expect(t.allowedCallers).toEqual(['programmatic']);
    expect(t.outputSchema).toBe(outputSchema);
    expect(serializeTool(t)).toMatchObject({
      allowedCallers: ['programmatic'],
      outputSchema,
    });
  });

  it('uses unknown for plain JSON Schema output types', () => {
    const outputSchema: JsonObjectSchema<{
      value: { type: 'string' };
    }> = {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    };
    const t = tool({
      name: 'plain_json_schema_output',
      description: 'Return structured data.',
      parameters: z.object({}),
      outputSchema,
      execute: async () => ({ value: 'ok' }),
    });

    expectTypeOf(t.invoke(new RunContext(), '{}')).toEqualTypeOf<
      Promise<unknown>
    >();
  });

  it('converts a Zod output schema and infers the execute result', () => {
    const outputSchema = z.object({
      value: z.string(),
      count: z.number(),
    });
    const t = tool({
      name: 'structured_zod_lookup',
      description: 'Return structured data.',
      parameters: z.object({ query: z.string() }),
      allowedCallers: ['programmatic'],
      outputSchema,
      execute: async ({ query }) => ({ value: query, count: 1 }),
    });

    expect(t.outputSchema).toEqual({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        value: { type: 'string' },
        count: { type: 'number' },
      },
      required: ['value', 'count'],
      additionalProperties: false,
    });
    expectTypeOf(t.invoke(new RunContext(), '{"query":"test"}')).toEqualTypeOf<
      Promise<string | { value: string; count: number }>
    >();

    tool({
      name: 'invalid_structured_zod_lookup',
      description: 'Type-check an invalid structured result.',
      parameters: z.object({ query: z.string() }),
      outputSchema,
      // @ts-expect-error The execute result must match the Zod output schema.
      execute: async ({ query }) => ({ value: query, count: 'one' }),
    });

    tool({
      name: 'invalid_structured_zod_fallback',
      description: 'Type-check an invalid structured fallback.',
      parameters: z.object({}),
      outputSchema,
      execute: async () => ({ value: 'ok', count: 1 }),
      // @ts-expect-error The error fallback must match the Zod output schema.
      errorFunction: () => ({ value: 'fallback', count: 'one' }),
    });
  });

  it('validates and transforms Zod output schemas at runtime', async () => {
    const t = tool({
      name: 'runtime_structured_zod_lookup',
      description: 'Return structured data.',
      parameters: z.object({}),
      outputSchema: z.object({ value: z.string().trim() }),
      execute: async () => ({ value: '  ok  ' }),
    });

    await expect(t.invoke(new RunContext(), '{}')).resolves.toEqual({
      value: 'ok',
    });
  });

  it('rejects invalid Zod output at runtime', async () => {
    const t = tool({
      name: 'invalid_runtime_structured_zod_lookup',
      description: 'Return structured data.',
      parameters: z.object({}),
      outputSchema: z.object({ value: z.string() }),
      execute: async () => ({ value: 123 }) as any,
    });

    await expect(t.invoke(new RunContext(), '{}')).rejects.toMatchObject({
      name: 'InvalidToolOutputError',
      toolOutput: { output: { value: 123 } },
    });
  });

  it('requires schema-compatible error fallbacks for Zod outputs', async () => {
    const validFallback = tool({
      name: 'valid_structured_error_fallback',
      description: 'Return structured data.',
      parameters: z.object({}),
      outputSchema: z.object({ value: z.string() }),
      execute: async () => {
        throw new Error('boom');
      },
      errorFunction: () => ({ value: 'fallback' }),
    });
    const invalidFallback = tool({
      name: 'invalid_structured_error_fallback',
      description: 'Return structured data.',
      parameters: z.object({}),
      outputSchema: z.object({ value: z.string() }),
      execute: async () => {
        throw new Error('boom');
      },
      errorFunction: () => ({ value: 123 }) as any,
    });
    const noFallback = tool({
      name: 'structured_error_without_fallback',
      description: 'Return structured data.',
      parameters: z.object({}),
      outputSchema: z.object({ value: z.string() }),
      execute: async () => {
        throw new Error('boom');
      },
    });

    await expect(validFallback.invoke(new RunContext(), '{}')).resolves.toEqual(
      { value: 'fallback' },
    );
    await expect(
      invalidFallback.invoke(new RunContext(), '{}'),
    ).rejects.toBeInstanceOf(InvalidToolOutputError);
    await expect(noFallback.invoke(new RunContext(), '{}')).rejects.toThrow(
      'boom',
    );
  });

  it('rejects invalid allowedCallers values at tool construction', () => {
    expect(() =>
      tool({
        name: 'empty_allowed_callers',
        description: 'Invalid configuration.',
        parameters: z.object({}),
        allowedCallers: [] as any,
        execute: async () => 'ok',
      }),
    ).toThrow(/must contain at least one caller/);
    expect(() =>
      shellTool({
        shell: new FakeShell(),
        allowedCallers: ['programmatic', 'programmatic'] as any,
      }),
    ).toThrow(/must not contain duplicate callers/);
    for (const invalidCaller of ['', 0, false, undefined, null]) {
      expect(() =>
        tool({
          name: 'falsy_invalid_allowed_caller',
          description: 'Invalid configuration.',
          parameters: z.object({}),
          allowedCallers: [invalidCaller] as any,
          execute: async () => 'ok',
        }),
      ).toThrow(/contains unsupported caller/);
    }

    const typecheckEmptyAllowedCallers = () =>
      tool({
        name: 'typecheck_empty_allowed_callers',
        description: 'Invalid configuration.',
        parameters: z.object({}),
        // @ts-expect-error allowedCallers must be non-empty.
        allowedCallers: [],
        execute: async () => 'ok',
      });
    expectTypeOf(typecheckEmptyAllowedCallers).toBeFunction();
  });

  it('toolNamespace returns shallow-cloned function tools', () => {
    const t = tool({
      name: 'lookup_account',
      description: 'Look up an account.',
      parameters: z.object({
        foo: z.string(),
      }),
      execute: async () => ({ bar: 'ok' }),
    });

    const [namespacedTool] = toolNamespace({
      name: 'crm',
      description: 'CRM tools',
      tools: [t],
    });

    expect(namespacedTool).not.toBe(t);
    expect(namespacedTool.name).toBe(t.name);
    expect(namespacedTool.description).toBe(t.description);
    expect(namespacedTool.invoke).toBe(t.invoke);
  });

  it('toolNamespace supports immediate-loading function tools', () => {
    const immediate = tool({
      name: 'lookup_account',
      description: 'Look up an account.',
      parameters: z.object({
        foo: z.string(),
      }),
      execute: async () => ({ bar: 'ok' }),
    });

    const namespacedTools = toolNamespace({
      name: 'crm',
      description: 'CRM tools',
      tools: [immediate],
    });

    expect(namespacedTools).toHaveLength(1);
    for (const namespacedTool of namespacedTools) {
      expect(serializeTool(namespacedTool)).toMatchObject({
        namespace: 'crm',
        namespaceDescription: 'CRM tools',
      });
    }
  });

  it('toolNamespace supports deferred-loading function tools', () => {
    const deferred = tool({
      name: 'list_recent_tickets',
      description: 'List recent tickets.',
      parameters: z.object({
        foo: z.string(),
      }),
      deferLoading: true,
      execute: async () => ({ bar: 'ok' }),
    });

    const [namespacedTool] = toolNamespace({
      name: 'crm',
      description: 'CRM tools',
      tools: [deferred],
    });

    expect(serializeTool(namespacedTool)).toMatchObject({
      namespace: 'crm',
      namespaceDescription: 'CRM tools',
      deferLoading: true,
    });
  });

  it('toolNamespace requires a namespace config object', () => {
    expect(() => toolNamespace(undefined as any)).toThrow(
      'toolNamespace() requires a namespace config object.',
    );
  });

  it('toolNamespace requires a non-empty description', () => {
    const t = tool({
      name: 'lookup_account',
      description: 'Look up an account.',
      parameters: z.object({
        foo: z.string(),
      }),
      execute: async () => ({ bar: 'ok' }),
    });

    expect(() =>
      toolNamespace({
        name: 'crm',
        description: '',
        tools: [t],
      }),
    ).toThrow(
      'toolNamespace() requires a non-empty description because the Responses API requires namespace descriptions.',
    );
  });

  it('toolNamespace normalizes namespace names to tool-safe identifiers', () => {
    const t = tool({
      name: 'lookup_account',
      description: 'Look up an account.',
      parameters: z.object({
        foo: z.string(),
      }),
      execute: async () => ({ bar: 'ok' }),
    });

    const [namespacedTool] = toolNamespace({
      name: 'CRM tools',
      description: 'CRM tools',
      tools: [t],
    });

    expect(serializeTool(namespacedTool)).toMatchObject({
      namespace: 'CRM_tools',
      namespaceDescription: 'CRM tools',
    });
  });

  it('toolNamespace rejects members whose name matches the namespace', () => {
    const t = tool({
      name: 'lookup_account',
      description: 'Look up an account.',
      parameters: z.object({
        foo: z.string(),
      }),
      execute: async () => ({ bar: 'ok' }),
    });

    expect(() =>
      toolNamespace({
        name: 'lookup_account',
        description: 'Lookup account tools',
        tools: [t],
      }),
    ).toThrow(
      'toolNamespace() does not allow a tool named "lookup_account" inside namespace "lookup_account" because Responses self-namespaced calls would be ambiguous.',
    );
  });

  it('computerTool', () => {
    const t = computerTool({
      computer: {} as Computer,
    });
    expect(t).toBeDefined();
    expect(t.type).toBe('computer');
    expect(t.name).toBe('computer_use_preview');
  });

  it('computerTool initializes computer per run context when an initializer is provided', async () => {
    const initializer = vi.fn(async (): Promise<Computer> => ({
      environment: 'mac' as const,
      dimensions: [1, 1],
      screenshot: async () => 'img',
      click: async () => {},
      doubleClick: async () => {},
      drag: async () => {},
      keypress: async () => {},
      move: async () => {},
      scroll: async () => {},
      type: async () => {},
      wait: async () => {},
    }));
    const t = computerTool({ name: 'comp', computer: initializer });

    const ctxA = new RunContext();
    const ctxB = new RunContext();

    const compA1 = await resolveComputer({ tool: t, runContext: ctxA });
    const compA2 = await resolveComputer({ tool: t, runContext: ctxA });
    const compB1 = await resolveComputer({ tool: t, runContext: ctxB });

    expect(initializer).toHaveBeenCalledTimes(2);
    expect(compA1).toBe(compA2);
    expect(compA1).not.toBe(compB1);
    expect(t.computer).toBe(compB1);
  });

  it('resolveComputer reuses provided static instance without invoking initializer logic', async () => {
    const staticComp = {
      environment: 'mac' as const,
      dimensions: [1, 1] as [number, number],
      screenshot: async () => 'img',
      click: async () => {},
      doubleClick: async () => {},
      drag: async () => {},
      keypress: async () => {},
      move: async () => {},
      scroll: async () => {},
      type: async () => {},
      wait: async () => {},
    };
    const initSpy = vi.fn();
    const t = computerTool({ computer: staticComp });
    const ctx = new RunContext();

    const first = await resolveComputer({ tool: t, runContext: ctx });
    const second = await resolveComputer({ tool: t, runContext: ctx });

    expect(first).toBe(staticComp);
    expect(second).toBe(staticComp);
    expect(initSpy).not.toHaveBeenCalled();
  });

  it('resolveComputer treats computer instances with create methods as static instances', async () => {
    const create = vi.fn();
    const staticComp = {
      environment: 'mac' as const,
      dimensions: [1, 1] as [number, number],
      screenshot: async () => 'img',
      click: async () => {},
      doubleClick: async () => {},
      drag: async () => {},
      keypress: async () => {},
      move: async () => {},
      scroll: async () => {},
      type: async () => {},
      wait: async () => {},
      create,
    };
    const t = computerTool({ computer: staticComp });
    const ctx = new RunContext();

    const resolved = await resolveComputer({ tool: t, runContext: ctx });

    expect(resolved).toBe(staticComp);
    expect(create).not.toHaveBeenCalled();
  });

  it('supports lifecycle initializers with dispose per run context', async () => {
    let counter = 0;
    const makeComputer = (label: string) =>
      ({
        environment: 'mac' as const,
        dimensions: [1, 1] as [number, number],
        screenshot: async () => 'img',
        click: async () => {},
        doubleClick: async () => {},
        drag: async () => {},
        keypress: async () => {},
        move: async () => {},
        scroll: async () => {},
        type: async () => {},
        wait: async () => {},
        label,
      }) as Computer & { label: string };

    const dispose = vi.fn(async () => {});
    const initializer = vi.fn(async () => {
      counter += 1;
      return makeComputer(`computer-${counter}`);
    });

    const t = computerTool({
      computer: {
        create: initializer,
        dispose,
      },
    });
    const ctx = new RunContext();

    const first = await resolveComputer({ tool: t, runContext: ctx });
    expect(initializer).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();

    await disposeResolvedComputers({ runContext: ctx });

    const second = await resolveComputer({ tool: t, runContext: ctx });
    expect(initializer).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith({ runContext: ctx, computer: first });
    expect(second).not.toBe(first);
  });

  it('redacts computer disposal errors and completes cleanup', async () => {
    const computer = {
      environment: 'mac' as const,
      dimensions: [1, 1] as [number, number],
      screenshot: async () => 'img',
      click: async () => {},
      doubleClick: async () => {},
      drag: async () => {},
      keypress: async () => {},
      move: async () => {},
      scroll: async () => {},
      type: async () => {},
      wait: async () => {},
    };
    const secret = 'SECRET_COMPUTER_DISPOSAL_123';
    const initializer = vi.fn(async () => computer);
    const t = computerTool({
      computer: {
        create: initializer,
        dispose: async () => {
          throw new Error(secret);
        },
      },
    });
    const ctx = new RunContext();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'dontLogToolData', 'get').mockReturnValue(true);

    await resolveComputer({ tool: t, runContext: ctx });
    await expect(disposeResolvedComputers({ runContext: ctx })).resolves.toBe(
      undefined,
    );
    await resolveComputer({ tool: t, runContext: ctx });

    expect(initializer).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to dispose computer for run context:',
      'object',
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(secret);
    vi.restoreAllMocks();
  });

  it('shellTool assigns default name', () => {
    const shell = new FakeShell();
    const t = shellTool({ shell });
    expect(t.type).toBe('shell');
    expect(t.name).toBe('shell');
    expect(t.environment.type).toBe('local');
    expect(t.environment).toEqual({ type: 'local' });
    expect(t.shell).toBe(shell);
  });

  it('tool allows reserved built-in names for compatibility', () => {
    const shellWrapper = tool({
      name: 'shell',
      description: 'compatibility shell wrapper',
      parameters: z.object({}),
      execute: async () => 'ok',
    });
    const computerWrapper = tool({
      name: 'computer_use_preview',
      description: 'compatibility computer wrapper',
      parameters: z.object({}),
      execute: async () => 'ok',
    });

    expect(shellWrapper.type).toBe('function');
    expect(shellWrapper.name).toBe('shell');
    expect(computerWrapper.type).toBe('function');
    expect(computerWrapper.name).toBe('computer_use_preview');
  });

  it('ShellTool keeps local environment optional for compatibility', () => {
    const legacyTool: ShellTool = {
      type: 'shell',
      name: 'shell',
      shell: new FakeShell(),
      needsApproval: async () => false,
    };
    expect(legacyTool.environment).toBeUndefined();
  });

  it('shellTool supports hosted container environments without local shell', () => {
    const t = shellTool({
      environment: { type: 'container_reference', containerId: 'cont_123' },
    });
    expect(t.environment).toEqual({
      type: 'container_reference',
      containerId: 'cont_123',
    });
    expect(t.shell).toBeUndefined();
  });

  it('shellTool normalizes container_auto options with inline skills', () => {
    const t = shellTool({
      environment: {
        type: 'container_auto',
        fileIds: ['file_123'],
        memoryLimit: '4g',
        networkPolicy: {
          type: 'allowlist',
          allowedDomains: ['example.com'],
          domainSecrets: [
            {
              domain: 'example.com',
              name: 'API_TOKEN',
              value: 'secret',
            },
          ],
        },
        skills: [
          {
            type: 'inline',
            name: 'csv-workbench',
            description: 'Analyze CSV files.',
            source: {
              type: 'base64',
              mediaType: 'application/zip',
              data: 'ZmFrZS16aXA=',
            },
          },
        ],
      },
    });

    expect(t.environment).toEqual({
      type: 'container_auto',
      fileIds: ['file_123'],
      memoryLimit: '4g',
      networkPolicy: {
        type: 'allowlist',
        allowedDomains: ['example.com'],
        domainSecrets: [
          {
            domain: 'example.com',
            name: 'API_TOKEN',
            value: 'secret',
          },
        ],
      },
      skills: [
        {
          type: 'inline',
          name: 'csv-workbench',
          description: 'Analyze CSV files.',
          source: {
            type: 'base64',
            mediaType: 'application/zip',
            data: 'ZmFrZS16aXA=',
          },
        },
      ],
    });
  });

  it('shellTool rejects local mode without a shell implementation', () => {
    expect(() => shellTool({ environment: { type: 'local' } } as any)).toThrow(
      /requires a shell implementation/,
    );
  });

  it('shellTool rejects container_reference without containerId', () => {
    expect(() =>
      shellTool({ environment: { type: 'container_reference' } as any }),
    ).toThrow(/requires a containerId/);
  });

  it('shellTool rejects skill_reference without skillId', () => {
    expect(() =>
      shellTool({
        environment: {
          type: 'container_auto',
          skills: [{ type: 'skill_reference' } as any],
        },
      }),
    ).toThrow(/requires a skillId/);
  });

  it('shellTool rejects inline skill source with unsupported media type', () => {
    expect(() =>
      shellTool({
        environment: {
          type: 'container_auto',
          skills: [
            {
              type: 'inline',
              name: 'bad-inline',
              description: 'invalid skill',
              source: {
                type: 'base64',
                mediaType: 'application/json' as any,
                data: 'eyJmb28iOiJiYXIifQ==',
              },
            },
          ],
        },
      }),
    ).toThrow(/must be application\/zip/);
  });

  it('shellTool rejects inline skill without a source object', () => {
    expect(() =>
      shellTool({
        environment: {
          type: 'container_auto',
          skills: [
            {
              type: 'inline',
              name: 'bad-inline',
              description: 'invalid skill',
            } as any,
          ],
        },
      }),
    ).toThrow(/source is required/);
  });

  it('shellTool rejects shell implementations for hosted environments', () => {
    expect(() =>
      shellTool({
        environment: { type: 'container_reference', containerId: 'cont_123' },
        shell: new FakeShell(),
      } as any),
    ).toThrow(/does not accept a shell implementation/);
  });

  it('shellTool rejects approval hooks for hosted environments', () => {
    expect(() =>
      shellTool({
        environment: { type: 'container_reference', containerId: 'cont_123' },
        needsApproval: true,
      } as any),
    ).toThrow(/does not support needsApproval or onApproval/);

    expect(() =>
      shellTool({
        environment: { type: 'container_reference', containerId: 'cont_123' },
        onApproval: async () => ({ approve: true }),
      } as any),
    ).toThrow(/does not support needsApproval or onApproval/);
  });

  it('shellTool needsApproval boolean becomes function', async () => {
    const shell = new FakeShell();
    const t = shellTool({ shell, needsApproval: true });
    const approved = await t.needsApproval(
      new RunContext(),
      { commands: [] },
      'id',
    );
    expect(approved).toBe(true);
  });

  it('shellTool onApproval is passed through', async () => {
    const shell = new FakeShell();
    const onApproval = vi.fn(async () => ({ approve: true }));
    const t = shellTool({ shell, onApproval });
    expect(t.onApproval).toBe(onApproval);
  });

  it('applyPatchTool assigns default name', () => {
    const editor = new FakeEditor();
    const t = applyPatchTool({ editor });
    expect(t.type).toBe('apply_patch');
    expect(t.name).toBe('apply_patch');
    expect(t.editor).toBe(editor);
  });

  it('applyPatchTool needsApproval boolean becomes function', async () => {
    const editor = new FakeEditor();
    const t = applyPatchTool({ editor, needsApproval: true });
    const approved = await t.needsApproval(
      new RunContext(),
      { type: 'delete_file', path: 'tmp' },
      'id',
    );
    expect(approved).toBe(true);
  });

  it('applyPatchTool onApproval is passed through', async () => {
    const editor = new FakeEditor();
    const onApproval = vi.fn(async () => ({ approve: true }));
    const t = applyPatchTool({ editor, onApproval });
    expect(t.onApproval).toBe(onApproval);
  });
});

describe('create a tool using hostedMcpTool utility', () => {
  it('hostedMcpTool', () => {
    const t = hostedMcpTool({
      serverLabel: 'gitmcp',
      serverUrl: 'https://gitmcp.io/openai/codex',
      requireApproval: 'never',
    });
    expect(t).toBeDefined();
    expect(t.type).toBe('hosted_tool');
    expect(t.name).toBe('hosted_mcp');
    expect(t.providerData.type).toBe('mcp');
    expect(t.providerData.server_label).toBe('gitmcp');
  });

  it('defaults MCP approval to never', () => {
    const t = hostedMcpTool({
      serverLabel: 'gitmcp',
      serverUrl: 'https://gitmcp.io/openai/codex',
    });

    expect(t.providerData.require_approval).toBe('never');
  });

  it('propagates authorization when approval is never required', () => {
    const t = hostedMcpTool({
      serverLabel: 'gitmcp',
      serverUrl: 'https://gitmcp.io/openai/codex',
      authorization: 'secret-token',
      requireApproval: 'never',
    });

    expect(t.providerData.authorization).toBe('secret-token');
  });

  it('propagates authorization when approval is required', () => {
    const t = hostedMcpTool({
      serverLabel: 'gitmcp',
      serverUrl: 'https://gitmcp.io/openai/codex',
      authorization: 'secret-token',
      requireApproval: {
        always: { toolNames: ['tool-name'] },
      },
    });

    expect(t.providerData.authorization).toBe('secret-token');
  });

  it('propagates tool_search metadata for hosted MCP servers', () => {
    const t = hostedMcpTool({
      serverLabel: 'gitmcp',
      serverUrl: 'https://gitmcp.io/openai/codex',
      serverDescription: 'Repository operations',
      deferLoading: true,
      requireApproval: 'never',
    });

    expect(t.providerData.server_description).toBe('Repository operations');
    expect(t.providerData.defer_loading).toBe(true);
  });

  it('rejects invalid MCP approval string policies', () => {
    expect(() =>
      hostedMcpTool({
        serverLabel: 'gitmcp',
        serverUrl: 'https://gitmcp.io/openai/codex',
        requireApproval: 'alwyas',
      } as any),
    ).toThrowError(/Invalid hosted MCP requireApproval/);
  });

  it('rejects unsupported MCP approval object keys', () => {
    expect(() =>
      hostedMcpTool({
        serverLabel: 'gitmcp',
        serverUrl: 'https://gitmcp.io/openai/codex',
        requireApproval: { delete: 'alwyas' },
      } as any),
    ).toThrowError(/unsupported key "delete"/);
  });

  it('rejects MCP approval policies with overlapping tool names', () => {
    expect(() =>
      hostedMcpTool({
        serverLabel: 'gitmcp',
        serverUrl: 'https://gitmcp.io/openai/codex',
        requireApproval: {
          always: { toolNames: ['delete'] },
          never: { toolNames: ['delete'] },
        },
      }),
    ).toThrowError(/cannot be listed in both always and never/);
  });

  it.each([
    [null, /value must be "always", "never", or an object/],
    [[], /value must be "always", "never", or an object/],
    [{}, /must include at least one of always or never/],
    [{ always: null }, /always must be an object/],
    [{ always: { unsupported: true } }, /unsupported key "unsupported"/],
    [
      { always: { toolNames: ['search'], tool_names: ['search'] } },
      /must not specify both toolNames and tool_names/,
    ],
    [
      { always: { readOnly: true, read_only: true } },
      /must not specify both readOnly and read_only/,
    ],
    [{ always: { toolNames: 'search' } }, /toolNames must be an array/],
    [
      { always: { toolNames: [''] } },
      /toolNames must contain only non-empty strings/,
    ],
    [{ always: { readOnly: 'yes' } }, /readOnly must be a boolean/],
    [{ always: {} }, /must include toolNames or readOnly/],
  ])('rejects invalid MCP approval policy %#', (requireApproval, message) => {
    expect(() =>
      hostedMcpTool({
        serverLabel: 'gitmcp',
        serverUrl: 'https://gitmcp.io/openai/codex',
        requireApproval,
      } as any),
    ).toThrowError(message);
  });

  it('normalizes MCP approval tool name filters', () => {
    const t = hostedMcpTool({
      serverLabel: 'gitmcp',
      serverUrl: 'https://gitmcp.io/openai/codex',
      requireApproval: {
        always: { toolNames: ['delete'] },
        never: { toolNames: ['search'] },
      },
    });

    expect(t.providerData.require_approval).toEqual({
      always: { tool_names: ['delete'] },
      never: { tool_names: ['search'] },
    });
  });

  it('normalizes MCP approval read-only filters', () => {
    const t = hostedMcpTool({
      serverLabel: 'gitmcp',
      serverUrl: 'https://gitmcp.io/openai/codex',
      requireApproval: {
        always: { readOnly: false },
        never: { toolNames: ['search'], readOnly: true },
      },
    });

    expect(t.providerData.require_approval).toEqual({
      always: { read_only: false },
      never: { tool_names: ['search'], read_only: true },
    });
  });

  it('accepts canonical MCP approval filter keys', () => {
    const t = hostedMcpTool({
      serverLabel: 'gitmcp',
      serverUrl: 'https://gitmcp.io/openai/codex',
      requireApproval: {
        always: { tool_names: ['delete'] },
        never: { read_only: true },
      },
    } as any);

    expect(t.providerData.require_approval).toEqual({
      always: { tool_names: ['delete'] },
      never: { read_only: true },
    });
  });
});

describe('tool.invoke', () => {
  it('parses input and returns result', async () => {
    const t = tool({
      name: 'echo',
      description: 'echo',
      parameters: z.object({ msg: z.string() }),
      execute: async ({ msg }) => `hi ${msg}`,
    });
    const res = await t.invoke(new RunContext(), '{"msg": "there"}');
    expect(res).toBe('hi there');
  });

  it('normalizes strict input through local JSON Schema references', async () => {
    const execute = vi.fn(() => 'ok');
    const t = tool({
      name: 'local_ref',
      description: 'Uses a local JSON Schema reference.',
      parameters: {
        type: 'object',
        properties: {
          payload: { $ref: '#/$defs/payload' },
          requiredAlias: { $ref: '#/$defs/payload/properties/note' },
          optionalAlias: { $ref: '#/$defs/payload/properties/note' },
        },
        required: ['payload', 'requiredAlias'],
        $defs: {
          payload: {
            type: 'object',
            properties: {
              note: { type: 'string' },
              enumValue: { enum: ['value'] },
              typedEnumValue: { type: 'string', enum: ['value'] },
              constValue: { $ref: '#/$defs/constValue' },
              explicitNull: { $ref: '#/$defs/maybeValue' },
            },
            required: [],
          },
          constValue: { const: 'value' },
          maybeValue: {
            anyOf: [{ type: 'string' }, { $ref: '#/$defs/nullValue' }],
          },
          nullValue: { type: 'null' },
        },
      } as any,
      execute,
    });

    await t.invoke(
      new RunContext(),
      JSON.stringify({
        payload: {
          note: null,
          enumValue: null,
          typedEnumValue: null,
          constValue: null,
          explicitNull: null,
        },
        requiredAlias: null,
        optionalAlias: null,
      }),
    );

    expect(execute).toHaveBeenCalledWith(
      { payload: { explicitNull: null }, requiredAlias: null },
      expect.any(RunContext),
      undefined,
    );
  });

  it('uses errorFunction on parse error', async () => {
    const t = tool({
      name: 'fail',
      description: 'fail',
      parameters: z.object({ ok: z.string() }),
      execute: async () => 'ok',
      errorFunction: () => 'bad',
    });
    const res = await t.invoke(new RunContext(), 'oops');
    expect(res).toBe('bad');
  });

  it.each([
    ['malformed JSON', 'SECRET_MALFORMED_TOOL_INPUT_123'],
    [
      'schema validation',
      JSON.stringify({ age: 'SECRET_SCHEMA_TOOL_INPUT_123' }),
    ],
  ])('redacts %s failures from direct invocation', async (_label, input) => {
    const flagSpy = vi
      .spyOn(logger, 'dontLogToolData', 'get')
      .mockReturnValue(true);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const t = tool({
      name: 'test',
      description: 'test',
      parameters: z.object({ age: z.number() }),
      execute: async () => 'ok',
      errorFunction: null,
    });
    const ctx = new RunContext();

    try {
      const error = await t.invoke(ctx, input).catch((caught) => caught);

      expect(error).toBeInstanceOf(InvalidToolInputError);
      expect(error).toMatchObject({
        message: 'Invalid JSON input for tool',
        originalError: undefined,
        toolInvocation: undefined,
      });
      expect(error).not.toHaveProperty('cause');
      expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(input);
    } finally {
      debugSpy.mockRestore();
      flagSpy.mockRestore();
    }
  });

  it.each([
    ['malformed JSON', 'SECRET_MALFORMED_TOOL_DIAGNOSTIC_123'],
    [
      'schema validation',
      JSON.stringify({ age: 'SECRET_SCHEMA_TOOL_DIAGNOSTIC_123' }),
    ],
  ])(
    'preserves %s diagnostics when tool data is enabled',
    async (_label, input) => {
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockReturnValue(false);
      const t = tool({
        name: 'test',
        description: 'test',
        parameters: z.object({ age: z.number() }),
        execute: async () => 'ok',
        errorFunction: null,
      });
      const ctx = new RunContext();
      const details = { resumeState: 'resume_123' };

      try {
        const error = await t
          .invoke(ctx, input, details)
          .catch((caught) => caught);

        expect(error).toBeInstanceOf(InvalidToolInputError);
        expect(error).toMatchObject({
          message: 'Invalid JSON input for tool',
          toolInvocation: { runContext: ctx, input, details },
        });
        expect(error.originalError).toBeDefined();
      } finally {
        flagSpy.mockRestore();
      }
    },
  );

  it.each([
    ['redacted', true],
    ['diagnostic', false],
  ] as const)(
    'applies %s parser context before invoking errorFunction',
    async (_mode, dontLogToolData) => {
      const secret = 'SECRET_CUSTOM_ERROR_FUNCTION_123';
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockReturnValue(dontLogToolData);
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
      let capturedError: unknown;
      let capturedDetails: unknown;
      const t = tool({
        name: 'test',
        description: 'test',
        parameters: z.object({ count: z.number() }),
        execute: async () => 'ok',
        errorFunction: (_ctx, error, details) => {
          capturedError = error;
          capturedDetails = details;
          return details?.toolCall?.arguments ?? 'handled';
        },
      });
      const ctx = new RunContext();
      const invalidInput = JSON.stringify({ count: secret });
      const details = {
        toolCall: {
          type: 'function_call' as const,
          callId: 'call_custom_error_function',
          name: 'test',
          arguments: invalidInput,
        },
      };

      try {
        const res = await t.invoke(ctx, invalidInput, details);

        if (dontLogToolData) {
          expect(res).toBe('handled');
          expect(capturedError).toMatchObject({
            message: 'Invalid JSON input for tool',
            originalError: undefined,
            toolInvocation: undefined,
          });
          expect(capturedDetails).toBeUndefined();
          expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(secret);
        } else {
          expect(res).toBe(invalidInput);
          expect(capturedError).toMatchObject({
            message: 'Invalid JSON input for tool',
            toolInvocation: { runContext: ctx, input: invalidInput, details },
          });
          expect(capturedDetails).toBe(details);
        }
      } finally {
        debugSpy.mockRestore();
        flagSpy.mockRestore();
      }
    },
  );

  it('discards direct fallback output when secure mode is enabled during errorFunction', async () => {
    const secret = 'SECRET_DIRECT_LATE_ERROR_FUNCTION_123';
    let redactToolData = false;
    const flagSpy = vi
      .spyOn(logger, 'dontLogToolData', 'get')
      .mockImplementation(() => redactToolData);
    const t = tool({
      name: 'late_direct_redaction',
      description: 'Promote redaction while handling invalid input.',
      parameters: z.object({ value: z.number() }),
      execute: async () => 'unexpected',
      errorFunction: (_context, _error, details) => {
        redactToolData = true;
        return details?.toolCall?.arguments ?? 'unexpected';
      },
    });
    const input = JSON.stringify({ value: secret });
    const details = {
      toolCall: {
        type: 'function_call' as const,
        callId: 'call_late_direct_redaction',
        name: 'late_direct_redaction',
        arguments: input,
      },
    };

    try {
      const error = await t
        .invoke(new RunContext(), input, details)
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(InvalidToolInputError);
      expect(error).toMatchObject({
        message: 'Invalid JSON input for tool',
        originalError: undefined,
        toolInvocation: undefined,
      });
      expect(JSON.stringify(error)).not.toContain(secret);
    } finally {
      flagSpy.mockRestore();
    }
  });

  it('preserves errorFunction details for execution errors in redacted mode', async () => {
    const flagSpy = vi
      .spyOn(logger, 'dontLogToolData', 'get')
      .mockReturnValue(true);
    const details = { resumeState: 'resume_execution_error' };
    let capturedDetails: unknown;
    const t = tool({
      name: 'execution_error',
      description: 'test',
      parameters: z.object({}),
      execute: async () => {
        throw new Error('execution failed');
      },
      errorFunction: (_ctx, _error, callbackDetails) => {
        capturedDetails = callbackDetails;
        return 'handled';
      },
    });

    try {
      const result = await t.invoke(new RunContext(), '{}', details);

      expect(result).toBe('handled');
      expect(capturedDetails).toBe(details);
    } finally {
      flagSpy.mockRestore();
    }
  });

  it('does not inspect hostile parser errors in redacted mode', async () => {
    const flagSpy = vi
      .spyOn(logger, 'dontLogToolData', 'get')
      .mockReturnValue(true);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const { proxy, revoke } = Proxy.revocable({}, {});
    const t = tool({
      name: 'hostile_parser',
      description: 'test',
      parameters: z.object({
        value: z.string().refine(() => {
          revoke();
          throw proxy;
        }),
      }),
      execute: async () => 'ok',
      errorFunction: null,
    });

    try {
      const error = await t
        .invoke(new RunContext(), '{"value":"trigger"}')
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(InvalidToolInputError);
      expect(error.originalError).toBeUndefined();
      expect(debugSpy).toHaveBeenCalledWith(
        'Invalid JSON input for tool hostile_parser',
      );
    } finally {
      debugSpy.mockRestore();
      flagSpy.mockRestore();
    }
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['number', 0],
    ['boolean', false],
    ['symbol', Symbol('parser failure')],
  ])('redacts a %s parser-thrown value', async (_label, thrownValue) => {
    const flagSpy = vi
      .spyOn(logger, 'dontLogToolData', 'get')
      .mockReturnValue(true);
    const execute = vi.fn(async () => 'unexpected');
    const t = tool({
      name: 'arbitrary_parser_failure',
      description: 'test',
      parameters: z.object({
        value: z.string().refine(() => {
          throw thrownValue;
        }),
      }),
      execute,
      errorFunction: null,
    });
    let caught: unknown = 'not thrown';

    try {
      try {
        await t.invoke(new RunContext(), '{"value":"trigger"}');
      } catch (error) {
        caught = error;
      }

      expect(execute).not.toHaveBeenCalled();
      expect(caught).toBeInstanceOf(InvalidToolInputError);
      expect(caught).toMatchObject({
        message: 'Invalid JSON input for tool',
        originalError: undefined,
        toolInvocation: undefined,
      });
    } finally {
      flagSpy.mockRestore();
    }
  });

  it('needsApproval boolean becomes function', async () => {
    const t = tool({
      name: 'appr',
      description: 'appr',
      parameters: z.object({}),
      execute: async () => 'x',
      needsApproval: true,
    });
    const approved = await t.needsApproval(new RunContext(), {}, 'id');
    expect(approved).toBe(true);
  });

  it('isEnabled boolean becomes function', async () => {
    const t = tool({
      name: 'enabled',
      description: 'enabled',
      parameters: z.object({}),
      execute: async () => 'x',
      isEnabled: false,
    });
    const enabled = await t.isEnabled(
      new RunContext(),
      new Agent({ name: 'Test Agent' }),
    );
    expect(enabled).toBe(false);
  });

  it('supports object argument in isEnabled option', async () => {
    const t = tool({
      name: 'predicate',
      description: 'predicate',
      parameters: z.object({}),
      execute: async () => 'x',
      isEnabled: ({
        runContext,
        agent,
      }: {
        runContext: RunContext<unknown>;
        agent: Agent<any, any>;
      }) => {
        expect(agent.name).toBe('Dynamic Agent');
        return (runContext.context as { feature: boolean }).feature;
      },
    });

    const agent = new Agent<{ feature: boolean }>({ name: 'Dynamic Agent' });
    const enabled = await t.isEnabled(new RunContext({ feature: true }), agent);
    const disabled = await t.isEnabled(
      new RunContext({ feature: false }),
      agent,
    );

    expect(enabled).toBe(true);
    expect(disabled).toBe(false);
  });

  it('returns a default timeout message when timeoutMs is exceeded', async () => {
    const t = tool({
      name: 'slow',
      description: 'slow',
      parameters: z.object({}),
      timeoutMs: 5,
      execute: async (_input, _context, details) => {
        await new Promise<void>((resolve) => {
          details?.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        return 'done';
      },
    });

    const result = await invokeFunctionTool({
      tool: t,
      runContext: new RunContext(),
      input: '{}',
    });

    expect(result).toBe("Tool 'slow' timed out after 5ms.");
  });

  it('raises timeouts by default for structured outputs', async () => {
    const t = tool({
      name: 'structured_slow',
      description: 'slow structured tool',
      parameters: z.object({}),
      outputSchema: z.object({ status: z.string() }),
      timeoutMs: 5,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { status: 'done' };
      },
    });

    await expect(
      invokeFunctionTool({
        tool: t,
        runContext: new RunContext(),
        input: '{}',
      }),
    ).rejects.toBeInstanceOf(ToolTimeoutError);
  });

  it('validates structured timeout fallbacks', async () => {
    const t = tool({
      name: 'structured_timeout_fallback',
      description: 'slow structured tool',
      parameters: z.object({}),
      outputSchema: z.object({ status: z.string() }),
      timeoutMs: 5,
      timeoutBehavior: 'error_as_result',
      timeoutErrorFunction: (_context, _error, details) => ({
        status: details?.toolCall?.callId ?? 'timed-out',
      }),
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { status: 'done' };
      },
    });

    await expect(
      invokeFunctionTool({
        tool: t,
        runContext: new RunContext(),
        input: '{}',
        details: {
          toolCall: {
            type: 'function_call',
            callId: 'call-structured-timeout',
            name: 'structured_timeout_fallback',
            arguments: '{}',
            status: 'completed',
          },
        },
      }),
    ).resolves.toEqual({ status: 'call-structured-timeout' });
  });

  it('requires timeout fallbacks for structured error results', () => {
    expect(() =>
      tool({
        name: 'structured_timeout_without_fallback',
        description: 'Invalid structured timeout configuration.',
        parameters: z.object({}),
        outputSchema: z.object({ status: z.string() }),
        timeoutMs: 5,
        timeoutBehavior: 'error_as_result',
        execute: async () => ({ status: 'done' }),
        // The cast verifies the runtime boundary in addition to the type test.
      } as any),
    ).toThrow(/requires timeoutErrorFunction/);

    const typecheckMissingTimeoutFallback = () =>
      // @ts-expect-error Structured error results require timeoutErrorFunction.
      tool({
        name: 'typecheck_structured_timeout_without_fallback',
        description: 'Invalid structured timeout configuration.',
        parameters: z.object({}),
        outputSchema: z.object({ status: z.string() }),
        timeoutMs: 5,
        timeoutBehavior: 'error_as_result',
        execute: async () => ({ status: 'done' }),
      });
    expectTypeOf(typecheckMissingTimeoutFallback).toBeFunction();
  });

  it('enforces timeout when invoking FunctionTool directly', async () => {
    const t = tool({
      name: 'direct_slow',
      description: 'slow direct invoke',
      parameters: z.object({}),
      timeoutMs: 5,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return 'done';
      },
    });

    const result = await t.invoke(new RunContext(), '{}');

    expect(result).toBe("Tool 'direct_slow' timed out after 5ms.");
  });

  it('uses timeoutErrorFunction when timeoutBehavior is error_as_result', async () => {
    const timeoutErrorFunction = vi.fn((_ctx, error: ToolTimeoutError) => {
      return `timeout:${error.toolName}:${error.timeoutMs}`;
    });
    const t = tool({
      name: 'slow',
      description: 'slow',
      parameters: z.object({}),
      timeoutMs: 5,
      timeoutErrorFunction,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return 'done';
      },
    });

    const result = await invokeFunctionTool({
      tool: t,
      runContext: new RunContext(),
      input: '{}',
    });

    expect(result).toBe('timeout:slow:5');
    expect(timeoutErrorFunction).toHaveBeenCalledTimes(1);
  });

  it('raises ToolTimeoutError when timeoutBehavior is raise_exception', async () => {
    const t = tool({
      name: 'slow',
      description: 'slow',
      parameters: z.object({}),
      timeoutMs: 5,
      timeoutBehavior: 'raise_exception',
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return 'done';
      },
    });

    await expect(
      invokeFunctionTool({
        tool: t,
        runContext: new RunContext(),
        input: '{}',
      }),
    ).rejects.toBeInstanceOf(ToolTimeoutError);
  });

  it('raises ToolTimeoutError when invoking FunctionTool directly with raise_exception', async () => {
    const t = tool({
      name: 'direct_raise',
      description: 'direct invoke with raise_exception',
      parameters: z.object({}),
      timeoutMs: 5,
      timeoutBehavior: 'raise_exception',
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return 'done';
      },
    });

    await expect(t.invoke(new RunContext(), '{}')).rejects.toBeInstanceOf(
      ToolTimeoutError,
    );
  });

  it('preserves receiver context for custom FunctionTool implementations', async () => {
    const invoke = vi.fn(function (
      this: { marker: string },
      _runContext: RunContext<unknown>,
      _input: string,
      _details?: any,
    ) {
      return this.marker;
    });

    const customTool = {
      type: 'function' as const,
      name: 'custom_receiver_tool',
      description: 'custom tool that relies on receiver context',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
      invoke,
      needsApproval: async () => false,
      timeoutMs: 100,
      timeoutBehavior: 'error_as_result' as const,
      isEnabled: async () => true,
      marker: 'receiver-ok',
    };

    const result = await invokeFunctionTool({
      tool: customTool as any,
      runContext: new RunContext(),
      input: '{}',
    });

    expect(result).toBe('receiver-ok');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('aborts the invocation signal when timeoutMs is exceeded', async () => {
    let abortReason: unknown;
    const t = tool({
      name: 'abortable_slow_tool',
      description: 'slow and abortable',
      parameters: z.object({}),
      timeoutMs: 5,
      execute: async (_args, _context, details) => {
        details?.signal?.addEventListener(
          'abort',
          () => {
            abortReason = details.signal?.reason;
          },
          { once: true },
        );

        await new Promise<void>(() => {
          // Intentionally keep pending to assert timeout-driven cancellation.
        });
        return 'done';
      },
    });

    const result = await invokeFunctionTool({
      tool: t,
      runContext: new RunContext(),
      input: '{}',
      details: {
        toolCall: {
          type: 'function_call',
          name: 'abortable_slow_tool',
          callId: 'call-timeout',
          status: 'completed',
          arguments: '{}',
        },
      },
    });

    expect(result).toBe("Tool 'abortable_slow_tool' timed out after 5ms.");
    expect(abortReason).toBeInstanceOf(ToolTimeoutError);
  });

  it('passes timeout abort signals even when details are omitted', async () => {
    let abortReason: unknown;
    let receivedSignal = false;
    let callIdFromDetails: string | undefined;
    const t = tool({
      name: 'abortable_without_details',
      description: 'slow and abortable without invocation details',
      parameters: z.object({}),
      timeoutMs: 5,
      execute: async (_args, _context, details) => {
        callIdFromDetails = details?.toolCall?.callId;

        if (details?.signal) {
          receivedSignal = true;
          details.signal.addEventListener(
            'abort',
            () => {
              abortReason = details.signal?.reason;
            },
            { once: true },
          );
        }

        await new Promise<void>(() => {
          // Intentionally keep pending to assert timeout-driven cancellation.
        });
        return 'done';
      },
    });

    const result = await invokeFunctionTool({
      tool: t,
      runContext: new RunContext(),
      input: '{}',
    });

    expect(result).toBe(
      "Tool 'abortable_without_details' timed out after 5ms.",
    );
    expect(receivedSignal).toBe(true);
    expect(callIdFromDetails).toBeUndefined();
    expect(abortReason).toBeInstanceOf(ToolTimeoutError);
  });

  it('applies timeout signal overrides even when details.signal is readonly', async () => {
    let abortReason: unknown;
    const originalSignal = new AbortController().signal;
    const details = {
      toolCall: {
        type: 'function_call' as const,
        name: 'readonly_signal_timeout_tool',
        callId: 'call-readonly-signal-timeout',
        status: 'completed' as const,
        arguments: '{}',
      },
      signal: originalSignal,
    };
    Object.defineProperty(details, 'signal', {
      value: originalSignal,
      writable: false,
      enumerable: true,
      configurable: false,
    });
    Object.freeze(details);

    const t = tool({
      name: 'readonly_signal_timeout_tool',
      description: 'times out with readonly invocation details.signal',
      parameters: z.object({}),
      timeoutMs: 5,
      execute: async (_args, _context, invokeDetails) => {
        expect(invokeDetails?.signal).toBeDefined();
        expect(invokeDetails?.signal).not.toBe(originalSignal);
        invokeDetails?.signal?.addEventListener(
          'abort',
          () => {
            abortReason = invokeDetails.signal?.reason;
          },
          { once: true },
        );

        await new Promise<void>(() => {
          // Intentionally keep pending to assert timeout handling on readonly details.
        });
        return 'done';
      },
    });

    const result = await invokeFunctionTool({
      tool: t,
      runContext: new RunContext(),
      input: '{}',
      details: details as any,
    });

    expect(result).toBe(
      "Tool 'readonly_signal_timeout_tool' timed out after 5ms.",
    );
    expect(abortReason).toBeInstanceOf(ToolTimeoutError);
  });

  it('keeps timeout behavior when tools resolve synchronously on abort', async () => {
    const t = tool({
      name: 'abort_resolving_tool',
      description: 'tool that resolves immediately when aborted',
      parameters: z.object({}),
      timeoutMs: 5,
      execute: async (_args, _context, details) => {
        await new Promise<string>((resolve) => {
          details?.signal?.addEventListener(
            'abort',
            () => {
              resolve('resolved-on-abort');
            },
            { once: true },
          );
        });
        return 'done';
      },
    });

    const result = await invokeFunctionTool({
      tool: t,
      runContext: new RunContext(),
      input: '{}',
      details: {
        toolCall: {
          type: 'function_call',
          name: 'abort_resolving_tool',
          callId: 'call-timeout-abort-resolve',
          status: 'completed',
          arguments: '{}',
        },
      },
    });

    expect(result).toBe("Tool 'abort_resolving_tool' timed out after 5ms.");
  });

  it('treats timeout-triggered abort rejections as timeout outcomes', async () => {
    const timeoutErrorFunction = vi.fn(() => 'timed-out');
    const t = tool({
      name: 'abort_rejecting_tool',
      description: 'tool that rejects on abort',
      parameters: z.object({}),
      timeoutMs: 5,
      timeoutErrorFunction,
      execute: async (_args, _context, details) => {
        await new Promise<never>((_, reject) => {
          details?.signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('tool aborted'));
            },
            { once: true },
          );
        });
        return 'done';
      },
    });

    const result = await invokeFunctionTool({
      tool: t,
      runContext: new RunContext(),
      input: '{}',
      details: {
        toolCall: {
          type: 'function_call',
          name: 'abort_rejecting_tool',
          callId: 'call-timeout-reject',
          status: 'completed',
          arguments: '{}',
        },
      },
    });

    expect(result).toBe('timed-out');
    expect(timeoutErrorFunction).toHaveBeenCalledTimes(1);
  });

  it('does not run errorFunction after timeout handling has already won', async () => {
    const timeoutErrorFunction = vi.fn(() => 'timed-out');
    const errorFunction = vi.fn(() => 'tool-error-result');
    const t = tool({
      name: 'abort_rejecting_tool_without_error_side_effects',
      description: 'tool that rejects on abort after timeout resolves',
      parameters: z.object({}),
      timeoutMs: 5,
      timeoutErrorFunction,
      errorFunction,
      execute: async (_args, _context, details) => {
        await new Promise<never>((_, reject) => {
          details?.signal?.addEventListener(
            'abort',
            () => {
              setTimeout(() => reject(new Error('tool aborted')), 0);
            },
            { once: true },
          );
        });
      },
    });

    const result = await invokeFunctionTool({
      tool: t,
      runContext: new RunContext(),
      input: '{}',
      details: {
        toolCall: {
          type: 'function_call',
          name: 'abort_rejecting_tool_without_error_side_effects',
          callId: 'call-timeout-reject-side-effects',
          status: 'completed',
          arguments: '{}',
        },
      },
    });

    expect(result).toBe('timed-out');
    expect(timeoutErrorFunction).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errorFunction).not.toHaveBeenCalled();
  });

  it('validates timeoutMs and timeoutErrorFunction options', () => {
    expect(() =>
      tool({
        name: 'bad-timeout',
        description: 'bad-timeout',
        parameters: z.object({}),
        timeoutMs: 0,
        execute: async () => 'ok',
      }),
    ).toThrow(/timeoutMs must be greater than 0/);

    expect(() =>
      tool({
        name: 'bad-timeout-max',
        description: 'bad-timeout-max',
        parameters: z.object({}),
        timeoutMs: 2_147_483_648,
        execute: async () => 'ok',
      }),
    ).toThrow(/timeoutMs must be less than or equal to 2147483647/);

    expect(() =>
      tool({
        name: 'bad-timeout-fn',
        description: 'bad-timeout-fn',
        parameters: z.object({}),
        timeoutErrorFunction: 'not-a-function' as any,
        execute: async () => 'ok',
      }),
    ).toThrow(/timeoutErrorFunction must be a function/);

    expect(() =>
      tool({
        name: 'bad-timeout-behavior',
        description: 'bad-timeout-behavior',
        parameters: z.object({}),
        timeoutBehavior: 'unsupported' as any,
        execute: async () => 'ok',
      }),
    ).toThrow(/timeoutBehavior must be one of/);
  });
});
