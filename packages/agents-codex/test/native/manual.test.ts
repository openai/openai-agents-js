import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createManualRequest,
  manualResultSchema,
  manualTool,
  type ManualToolReply,
  type ManualToolRequest,
} from '../../src/runtime/manual';
import { captureTools, type SessionTool } from '../../src/runtime/tools';

const identity = {
  sessionId: 'root',
  submissionId: 'submission-1',
  subagentId: null,
  turnId: 'turn-1',
  callId: 'call-1',
};

describe('manual tool declarations and exact reply ownership', () => {
  it('validates an invocation once and exposes isolated typed requests to later readers', () => {
    const validated = vi.fn(() => true);
    const lookup = manualTool({
      name: 'lookup',
      description: 'Retrieve a record',
      parameters: z.object({ keys: z.array(z.string()) }).refine(validated),
      result: z.array(z.number()),
    });
    const sameName = manualTool({
      name: 'lookup',
      description: 'Retrieve a record',
      parameters: z.object({ keys: z.array(z.string()) }),
      result: z.array(z.number()),
    });
    const tools: readonly SessionTool[] = [lookup];
    const catalog = captureTools(tools);
    const captured = catalog.tools[0];
    if (captured.kind !== 'manual')
      throw new Error('manual declaration was lost');
    expect('invoke' in captured).toBe(false);
    const authority = createManualRequest(
      captured,
      identity,
      { keys: ['a'] },
      () => true,
    );
    const first = lookup.match(authority.request());
    const second = lookup.match(authority.request());
    expectTypeOf(first).toEqualTypeOf<
      ManualToolRequest<{ keys: string[] }, number[]> | undefined
    >();
    expect(validated).toHaveBeenCalledTimes(1);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) throw new Error('Expected current manual request');
    first.arguments.keys.push('changed');
    expect(second.arguments).toEqual({ keys: ['a'] });
    expect(first.arguments).toEqual({ keys: ['a'] });
    expect(validated).toHaveBeenCalledTimes(1);
    expect(sameName.match(first)).toBeUndefined();
    expect(lookup.match({ ...first })).toBeUndefined();
    expect(lookup.match(JSON.parse(JSON.stringify(first)))).toBeUndefined();
    const reply = first.reply([2, 3]);
    expectTypeOf(reply).toEqualTypeOf<ManualToolReply<number[]>>();
    expect(authority.takeReply(reply)).toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: '[2,3]' }],
    });
    expect(authority.takeReply(reply)).toBeUndefined();
    expect(lookup.match(first)).toBe(first);
    expect(authority.takeReply(first.reply([4]))).toBeUndefined();
    expect(JSON.parse(JSON.stringify(first))).toMatchObject({
      arguments: { keys: ['a'] },
    });
    first.arguments.keys.push('changed after completion');
    expect(second.arguments).toEqual({ keys: ['a'] });
    expect(authority.request()).toBeUndefined();
  });

  it('rejects foreign or serialized replies without consuming either valid grant', () => {
    const lookup = manualTool({
      name: 'value',
      description: '',
      parameters: z.object({}),
      result: z.string(),
    });
    const original = createManualRequest(lookup, identity, {}, () => true);
    const restored = createManualRequest(
      lookup,
      { ...identity, sessionId: 'fresh' },
      {},
      () => true,
    );
    const oldRequest = original.request();
    const newRequest = restored.request();
    if (!oldRequest || !newRequest)
      throw new Error('Expected current manual requests');
    const oldReply = oldRequest.reply('original');
    expect(restored.takeReply(oldReply)).toBeUndefined();
    expect(
      original.takeReply(JSON.parse(JSON.stringify(oldReply))),
    ).toBeUndefined();
    const freshReply = newRequest.reply('restored');
    original.deactivate();
    expect(original.takeReply(oldReply)).toBeUndefined();
    expect(original.takeReply(oldRequest.reply('late'))).toBeUndefined();
    expect(lookup.match(oldRequest)).toBe(oldRequest);
    expect(JSON.parse(JSON.stringify(oldRequest))).toMatchObject({
      arguments: {},
    });
    expect(restored.takeReply(freshReply)).toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: 'restored' }],
    });
  });

  it('allows retry after invalid result and validates each proposed reply only once', () => {
    const validation = vi.fn((value: number) => value * 2);
    const lookup = manualTool({
      name: 'number',
      description: '',
      parameters: z.object({}),
      result: z.number().min(1).transform(validation),
    });
    const authority = createManualRequest(lookup, identity, {}, () => true);
    const request = authority.request();
    if (!request) throw new Error('Expected current manual request');
    expect(() => authority.takeReply(request.reply(0))).toThrow(
      'Manual tool result failed validation',
    );
    expect(lookup.match(request)).toBe(request);
    const reply = request.reply(3);
    expect(validation).not.toHaveBeenCalled();
    expect(authority.takeReply(reply)).toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: '6' }],
    });
    expect(validation).toHaveBeenCalledTimes(1);
    expect(manualResultSchema(lookup)).toMatchObject({
      type: 'number',
      minimum: 1,
    });
  });

  it('checks the native grant again after both validators and hides validator failures', () => {
    let current = true;
    const inputRevoker = manualTool({
      name: 'input',
      description: '',
      parameters: z.object({}).refine(() => {
        current = false;
        return true;
      }),
      result: z.string(),
    });
    expect(() =>
      createManualRequest(inputRevoker, identity, {}, () => current),
    ).toThrow('no longer active');
    current = true;
    const resultRevoker = manualTool({
      name: 'result',
      description: '',
      parameters: z.object({}),
      result: z.string().refine(() => {
        current = false;
        return true;
      }),
    });
    const authority = createManualRequest(
      resultRevoker,
      identity,
      {},
      () => current,
    );
    const request = authority.request();
    if (!request) throw new Error('Expected current manual request');
    expect(() => authority.takeReply(request.reply('value'))).toThrow(
      'no longer active',
    );
    expect(authority.request()).toBeUndefined();
    const broken = manualTool({
      name: 'broken',
      description: '',
      parameters: z.object({ value: z.string() }).refine(() => {
        throw new Error('private validator input');
      }),
      result: z.string(),
    });
    expect(() =>
      createManualRequest(broken, identity, { value: 'secret' }, () => true),
    ).toThrow('Manual tool arguments failed validation');
  });

  it('publishes only JSON schemas in catalog specs; private result schema reads are copies', () => {
    const lookup = manualTool({
      name: 'nested',
      description: '',
      parameters: z.object({ key: z.string() }),
      result: z.object({ values: z.array(z.number()) }),
    });
    const first = manualResultSchema(lookup) as Record<string, unknown>;
    first.type = 'changed';
    expect(manualResultSchema(lookup)).toMatchObject({ type: 'object' });
    const catalog = captureTools([lookup]);
    expect(JSON.parse(catalog.specsJson)).toMatchObject([
      {
        type: 'function',
        name: 'nested',
        inputSchema: { type: 'object' },
      },
    ]);
    expect(catalog.specsJson).not.toContain('parseInput');
    expect(catalog.specsJson).not.toContain('parseResult');
  });

  it('uses captured input and result schemas even if the original options are changed', () => {
    const options = {
      name: 'captured',
      description: '',
      parameters: z.object({ key: z.string().min(2) }),
      result: z.string().min(2),
      deferLoading: true,
    };
    const lookup = manualTool(options);
    const catalog = captureTools([lookup]);
    options.parameters = z.object({ key: z.string().max(1) });
    options.result = z.string().max(1);
    options.deferLoading = false;
    expect(lookup.deferLoading).toBe(true);
    expect(JSON.parse(catalog.specsJson)[0].deferLoading).toBe(true);
    const captured = catalog.tools[0];
    if (captured.kind !== 'manual')
      throw new Error('Expected manual declaration');
    const authority = createManualRequest(
      captured,
      identity,
      { key: 'captured' },
      () => true,
    );
    const request = lookup.match(authority.request());
    if (!request) throw new Error('Expected current captured request');
    expect(() => authority.takeReply(request.reply('x'))).toThrow(
      'Manual tool result failed validation',
    );
    expect(authority.takeReply(request.reply('captured'))).toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: 'captured' }],
    });
    expect(manualResultSchema(lookup)).toMatchObject({
      type: 'string',
      minLength: 2,
    });
  });
});
