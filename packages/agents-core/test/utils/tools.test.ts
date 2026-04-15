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

  it('getSchemaAndParserFromInputType keeps discriminated unions OpenAI-compatible', () => {
    const zodSchema = z.object({
      name: z.string(),
      recurrence: z.discriminatedUnion('type', [
        z.object({ type: z.literal('once'), date: z.string() }),
        z.object({ type: z.literal('weekly'), dayOfWeek: z.number() }),
      ]),
    });

    const res = getSchemaAndParserFromInputType(zodSchema, 'create_event');
    expect(res.schema.properties.recurrence).toMatchObject({
      anyOf: [
        {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'once' },
            date: { type: 'string' },
          },
          required: ['type', 'date'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'weekly' },
            dayOfWeek: { type: 'number' },
          },
          required: ['type', 'dayOfWeek'],
          additionalProperties: false,
        },
      ],
    });
    expect(
      'oneOf' in (res.schema.properties.recurrence as Record<string, unknown>),
    ).toBe(false);
    expect(
      res.parser(
        JSON.stringify({
          name: 'Weekly sync',
          recurrence: { type: 'weekly', dayOfWeek: 1 },
        }),
      ),
    ).toEqual({
      name: 'Weekly sync',
      recurrence: { type: 'weekly', dayOfWeek: 1 },
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
