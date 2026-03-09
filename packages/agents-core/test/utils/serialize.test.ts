import { describe, it, expect } from 'vitest';
import { serializeTool, serializeHandoff } from '../../src/utils/serialize';
import { tool, toolNamespace } from '../../src/tool';
import { z } from 'zod';

describe('serialize utilities', () => {
  it('serializes function tools', () => {
    const t: any = {
      type: 'function',
      name: 'fn',
      description: 'desc',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
    };
    expect(serializeTool(t)).toEqual({
      type: 'function',
      name: 'fn',
      description: 'desc',
      parameters: t.parameters,
      strict: true,
    });
  });

  it('serializes computer tools', () => {
    const t: any = {
      type: 'computer',
      name: 'comp',
      computer: {
        environment: 'browser',
        dimensions: [1, 2],
        screenshot: async () => 'img',
        click: async () => {},
        doubleClick: async () => {},
        drag: async () => {},
        keypress: async () => {},
        move: async () => {},
        scroll: async () => {},
        type: async () => {},
        wait: async () => {},
      },
    };
    expect(serializeTool(t)).toEqual({
      type: 'computer',
      name: 'comp',
      environment: 'browser',
      dimensions: [1, 2],
    });
  });

  it('serializes GA computer tools without display metadata', () => {
    const t: any = {
      type: 'computer',
      name: 'comp',
      computer: {
        screenshot: async () => 'img',
        click: async () => {},
        doubleClick: async () => {},
        drag: async () => {},
        keypress: async () => {},
        move: async () => {},
        scroll: async () => {},
        type: async () => {},
        wait: async () => {},
      },
    };
    expect(serializeTool(t)).toEqual({
      type: 'computer',
      name: 'comp',
    });
  });

  it('throws when computer tool has not been initialized yet', () => {
    const t: any = {
      type: 'computer',
      name: 'comp',
      computer: async () => ({
        environment: 'browser',
        dimensions: [1, 2],
      }),
    };
    expect(() => serializeTool(t)).toThrow(
      /resolveComputer\(\{ tool, runContext \}\)/,
    );
  });

  it('serializes shell tools', () => {
    const t: any = {
      type: 'shell',
      name: 'custom-shell',
      environment: { type: 'container_reference', containerId: 'cont_123' },
    };
    expect(serializeTool(t)).toEqual({
      type: 'shell',
      name: 'custom-shell',
      environment: { type: 'container_reference', containerId: 'cont_123' },
    });
  });

  it('serializes apply_patch tools', () => {
    const t: any = {
      type: 'apply_patch',
      name: 'custom-editor',
    };
    expect(serializeTool(t)).toEqual({
      type: 'apply_patch',
      name: 'custom-editor',
    });
  });

  it('serializes hosted tools', () => {
    const t: any = { type: 'hosted_tool', name: 'bt', providerData: { a: 1 } };
    expect(serializeTool(t)).toEqual({
      type: 'hosted_tool',
      name: 'bt',
      providerData: { a: 1 },
    });
  });

  it('serializes deferred and namespaced function tools', () => {
    const deferredLookup = tool({
      name: 'lookup_account',
      description: 'Look up an account.',
      parameters: z.object({
        accountId: z.string(),
      }),
      deferLoading: true,
      execute: async () => 'ok',
    });
    const namespacedLookup = tool({
      name: 'lookup_account',
      description: 'Look up an account.',
      parameters: z.object({
        accountId: z.string(),
      }),
      deferLoading: true,
      execute: async () => 'ok',
    });
    const [crmLookup] = toolNamespace({
      name: 'crm',
      description: 'CRM tools',
      tools: [namespacedLookup],
    });

    expect(serializeTool(deferredLookup)).toMatchObject({
      type: 'function',
      name: 'lookup_account',
      description: 'Look up an account.',
      deferLoading: true,
    });
    expect(serializeTool(deferredLookup)).not.toHaveProperty('namespace');

    expect(serializeTool(crmLookup)).toMatchObject({
      type: 'function',
      name: 'lookup_account',
      description: 'Look up an account.',
      deferLoading: true,
      namespace: 'crm',
      namespaceDescription: 'CRM tools',
    });
  });

  it('serializeHandoff', () => {
    const h: any = {
      toolName: 'hn',
      toolDescription: 'desc',
      inputJsonSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strictJsonSchema: false,
    };
    expect(serializeHandoff(h)).toEqual({
      toolName: 'hn',
      toolDescription: 'desc',
      inputJsonSchema: h.inputJsonSchema,
      strictJsonSchema: false,
    });
  });
});
