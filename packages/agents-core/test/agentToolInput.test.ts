import { describe, it, expect } from 'vitest';

import {
  AgentAsToolInputSchema,
  buildStructuredInputSchemaInfo,
  resolveAgentToolInput,
} from '../src/agentToolInput';
import type { AgentInputItem, JsonObjectSchema } from '../src/types';
import type { ToolInputParametersStrict } from '../src/tool';
import { z } from 'zod';

describe('agentToolInput', () => {
  it('AgentAsToolInputSchema accepts only string input', () => {
    expect(AgentAsToolInputSchema.safeParse({ input: 'hi' }).success).toBe(
      true,
    );
    expect(AgentAsToolInputSchema.safeParse({ input: [] }).success).toBe(false);
  });

  it('resolveAgentToolInput returns string input when provided', async () => {
    const result = await resolveAgentToolInput({ params: { input: 'hello' } });
    expect(result).toBe('hello');
  });

  it('resolveAgentToolInput falls back to JSON when no schema info', async () => {
    const result = await resolveAgentToolInput({ params: { foo: 'bar' } });
    expect(result).toBe(JSON.stringify({ foo: 'bar' }));
  });

  it('resolveAgentToolInput stringifies bigint values without schema info', async () => {
    const result = await resolveAgentToolInput({ params: { count: 10n } });
    expect(result).toBe('{"count":"10"}');
  });

  it('resolveAgentToolInput preserves structured fields alongside input', async () => {
    const result = await resolveAgentToolInput({
      params: { input: 'hello', target: 'world' },
    });
    expect(result).toBe(JSON.stringify({ input: 'hello', target: 'world' }));
  });

  it('resolveAgentToolInput uses the default builder when schema info exists', async () => {
    const result = await resolveAgentToolInput({
      params: { foo: 'bar' },
      schemaInfo: { summary: 'Summary' },
    });
    expect(typeof result).toBe('string');
    expect(result).toContain('Input Schema Summary:');
    expect(result).toContain('Summary');
  });

  it('defaultInputBuilder stringifies bigint values when schema info exists', async () => {
    const result = await resolveAgentToolInput({
      params: { count: 10n },
      schemaInfo: { summary: 'Summary' },
    });
    expect(result).toContain('"count": "10"');
  });

  it('resolveAgentToolInput returns builder output for items', async () => {
    const items = [
      { role: 'user', content: 'custom input' },
    ] satisfies AgentInputItem[];
    const result = await resolveAgentToolInput({
      params: { input: 'ignored' },
      inputBuilder: async () => items,
    });
    expect(result).toEqual(items);
  });

  it('buildStructuredInputSchemaInfo returns a summary for described zod fields', () => {
    const schema = z
      .object({
        name: z.string().describe('User name.'),
        status: z.enum(['active', 'inactive']).describe('User status.'),
        kind: z.literal('internal').describe('Account kind.'),
        note: z.string().nullable().optional().describe('Optional note.'),
      })
      .describe('User payload.');
    const info = buildStructuredInputSchemaInfo(schema, 'tool', false);
    expect(info.summary).toContain('Description: User payload.');
    expect(info.summary).toContain('- name (string, required) - User name.');
    expect(info.summary).toContain(
      '- status (enum("active" | "inactive"), required) - User status.',
    );
    expect(info.summary).toContain(
      '- kind (literal, required) - Account kind.',
    );
    expect(info.summary).toContain(
      '- note (string | null, optional) - Optional note.',
    );
    expect(info.jsonSchema).toBeUndefined();
  });

  it('buildStructuredInputSchemaInfo omits summary when no descriptions exist', () => {
    const schema = z.object({
      name: z.string(),
      count: z.number().optional(),
    });
    const info = buildStructuredInputSchemaInfo(schema, 'tool', false);
    expect(info.summary).toBeUndefined();
  });

  it('buildStructuredInputSchemaInfo summarizes JSON schema details', () => {
    const schema: ToolInputParametersStrict = {
      type: 'object',
      description: 'Payload description.',
      properties: {
        name: { type: 'string', description: 'Name.' },
        size: { type: ['number', 'null'], description: 'Size.' },
        mode: { enum: ['auto', 'manual'], description: 'Mode.' },
        flag: { const: true, description: 'Flag.' },
      },
      required: ['name', 'flag'],
      additionalProperties: false,
    };
    const info = buildStructuredInputSchemaInfo(schema, 'tool', false);
    expect(info.summary).toContain('Description: Payload description.');
    expect(info.summary).toContain('- name (string, required) - Name.');
    expect(info.summary).toContain('- size (number | null, optional) - Size.');
    expect(info.summary).toContain(
      '- mode (enum("auto" | "manual"), optional) - Mode.',
    );
    expect(info.summary).toContain('- flag (literal(true), required) - Flag.');
  });

  it('resolveAgentToolInput includes JSON schema when provided', async () => {
    const schema: JsonObjectSchema<any> = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    };
    const result = await resolveAgentToolInput({
      params: { name: 'Ada' },
      schemaInfo: { jsonSchema: schema },
    });
    expect(typeof result).toBe('string');
    expect(result).toContain('Input JSON Schema:');
    expect(result).toContain('"name": "Ada"');
    expect(result).toContain('"type": "object"');
  });
});
