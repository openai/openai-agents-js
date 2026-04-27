import { describe, it, expect } from 'vitest';
import {
  toFunctionToolName,
  getSchemaAndParserFromInputType,
  convertAgentOutputTypeToSerializable,
} from '../../src/utils/tools';
import { z } from 'zod';
import { UserError } from '../../src/errors';
import { JsonObjectSchema, JsonSchemaDefinitionEntry } from '../../src/types';

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

  it('falls back to a strict-compatible schema when optional fields are present', () => {
    const zodSchema = z.object({
      required: z.string(),
      optional: z.number().optional(),
    });
    const res = getSchemaAndParserFromInputType(
      zodSchema,
      'tool-with-optional',
      { strict: true },
    );
    expect(res.schema).toEqual({
      type: 'object',
      properties: {
        required: { type: 'string' },
        optional: {
          anyOf: [{ type: 'number' }, { type: 'null' }],
        },
      },
      required: ['required', 'optional'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    });
    expect(res.parser('{"required":"ok"}')).toEqual({ required: 'ok' });
    expect(res.parser('{"required":"ok","optional":2}')).toEqual({
      required: 'ok',
      optional: 2,
    });
    expect(res.parser('{"required":"ok","optional":null}')).toEqual({
      required: 'ok',
    });
  });

  it('normalizes nullable optional fields inside strict Zod unions', () => {
    const zodSchema = z.object({
      payload: z.union([
        z.object({
          kind: z.literal('text'),
          optional: z.string().optional(),
        }),
        z.object({
          kind: z.literal('count'),
          optional: z.number().optional(),
        }),
      ]),
    });
    const res = getSchemaAndParserFromInputType(zodSchema, 'union-tool', {
      strict: true,
    });

    expect(
      res.parser(
        JSON.stringify({
          payload: {
            kind: 'text',
            optional: null,
          },
        }),
      ),
    ).toEqual({
      payload: {
        kind: 'text',
      },
    });
  });

  it('preserves explicit nulls for optional Zod fields that allow null', () => {
    const zodSchema = z.object({
      value: z.union([z.string(), z.null()]).optional(),
    });
    const res = getSchemaAndParserFromInputType(zodSchema, 'nullable-tool', {
      strict: true,
    });

    expect(res.parser('{"value":null}')).toEqual({
      value: null,
    });
  });

  it('normalizes strict JSON-schema nulls for optional properties', () => {
    const schema: JsonObjectSchema<Record<string, JsonSchemaDefinitionEntry>> =
      {
        type: 'object',
        properties: {
          required: { type: 'string' },
          optional: { type: 'string' },
          nullableOptional: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
          },
          nested: {
            type: 'object',
            properties: {
              optional: { type: 'number' },
            },
            required: [],
            additionalProperties: false,
          },
        },
        required: ['required', 'nested'],
        additionalProperties: false,
      };

    const res = getSchemaAndParserFromInputType(schema, 'json-schema-tool', {
      strict: true,
    });

    expect(
      res.parser(
        JSON.stringify({
          required: 'ok',
          optional: null,
          nullableOptional: null,
          nested: {
            optional: null,
          },
        }),
      ),
    ).toEqual({
      required: 'ok',
      nullableOptional: null,
      nested: {},
    });
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
