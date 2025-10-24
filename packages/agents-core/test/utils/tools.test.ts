import { describe, it, expect } from 'vitest';
import {
  toFunctionToolName,
  getSchemaAndParserFromInputType,
} from '../../src/utils/tools';
import { z } from 'zod';
import { z as z4 } from 'zod/v4';
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

  it('getSchemaAndParserFromInputType with ZodObject v4', () => {
    const zodSchema = z4.object({ baz: z4.string() });
    const res = getSchemaAndParserFromInputType(zodSchema, 'toolv4');
    expect(res.schema).toHaveProperty('type', 'object');
    expect(res.parser('{"baz":"ok"}')).toEqual({ baz: 'ok' });
  });

  it('getSchemaAndParserFromInputType rejects invalid input', () => {
    expect(() => getSchemaAndParserFromInputType('bad' as any, 't')).toThrow(
      UserError,
    );
  });
});
