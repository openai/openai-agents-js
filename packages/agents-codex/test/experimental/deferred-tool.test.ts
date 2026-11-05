import { describe, expect, it, vi } from 'vitest';
import { z as ordinaryZod } from 'zod';
import { deferredTool } from '../../src/experimental/deferred-tool';
import { deferredDefault } from '../../src/experimental/deferred-codec';
import { Agent } from '../../src/runtime/public-agent';
import type { JsonValue } from '../../src/runtime/binding';
import {
  createManualRequest,
  manualResultSchema,
  manualTool,
} from '../../src/runtime/manual';

const identity = {
  sessionId: 'root',
  submissionId: 'submission',
  subagentId: null,
  turnId: 'turn',
  callId: 'call',
};

function render() {
  return deferredTool({
    name: 'render',
    description: 'Render an artifact',
    schemas: (z) => ({
      parameters: z.strictObject({
        attempts: deferredDefault(z.int().min(1), 1),
        tag: z.string().max(1),
      }),
      result: z.strictObject({ bytes: z.int().min(0) }),
    }),
  });
}

describe('private deferred manual construction', () => {
  it('returns the existing frozen manual declaration and exact request/reply owner', () => {
    const declaration = render();
    const sameName = render();
    const ordinary = manualTool({
      name: 'ordinary',
      description: 'Keep ordinary schema ownership',
      parameters: ordinaryZod.strictObject({ id: ordinaryZod.string() }),
      result: ordinaryZod.boolean(),
    });
    const agent = new Agent({
      instructions: 'Use the declared tools',
      tools: [ordinary, declaration],
    });
    expect(agent.tools).toEqual([ordinary, declaration]);
    expect(agent.tools[1]).toBe(declaration);
    expect(Object.isFrozen(declaration)).toBe(true);
    expect(declaration.kind).toBe('manual');
    expect(declaration.deferLoading).toBe(false);
    expect(manualResultSchema(declaration)).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['bytes'],
    });
    const owner = createManualRequest(
      declaration,
      identity,
      { tag: '😀' },
      () => true,
    );
    const request = owner.request()!;
    expect(request.arguments).toEqual({ attempts: 1, tag: '😀' });
    expect(declaration.match(request)).toBe(request);
    expect(sameName.match(request)).toBeUndefined();
    expect(ordinary.match(request)).toBeUndefined();
    const other = createManualRequest(
      sameName,
      identity,
      { tag: 'a' },
      () => true,
    );
    const reply = request.reply({ bytes: 2 });
    expect(other.matchesReply(reply)).toBe(false);
    expect(other.takeReply(reply)).toBeUndefined();
    expect(owner.takeReply(reply)).toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: '{"bytes":2}' }],
    });
    expect(owner.matchesReply(reply)).toBe(false);
    expect(owner.takeReply(reply)).toBeUndefined();
    expect(owner.request()).toBeUndefined();
    other.deactivate();
  });

  it('rejects invalid or lossy input and result values through the existing manual owner', () => {
    const declaration = render();
    const invalidInputs: JsonValue[] = [
      { attempts: 0, tag: 'a' },
      { tag: 'ab' },
      { tag: 'a', extra: true },
    ];
    for (const args of invalidInputs) {
      expect(() =>
        createManualRequest(declaration, identity, args, () => true),
      ).toThrow('Manual tool arguments failed validation');
    }
    const owner = createManualRequest(
      declaration,
      identity,
      { tag: 'a' },
      () => true,
    );
    const request = owner.request()!;
    for (const result of [{ bytes: -1 }, { bytes: 1, extra: true }]) {
      expect(() => owner.takeReply(request.reply(result))).toThrow(
        'Manual tool result failed validation',
      );
    }
    expect(owner.takeReply(request.reply({ bytes: 0 }))?.success).toBe(true);
  });

  it('uses its pinned builder once across request validation, replies and revocation', () => {
    const builder = vi.fn();
    const declaration = deferredTool({
      name: 'job',
      description: 'A captured declaration',
      schemas: (z) => {
        builder();
        expect(z.string()._zod.version).toEqual({
          major: 4,
          minor: 6,
          patch: 7,
        });
        return {
          parameters: z.strictObject({ id: z.string() }),
          result: z.strictObject({ done: z.boolean() }),
        };
      },
    });
    const owner = createManualRequest(
      declaration,
      identity,
      { id: 'one' },
      () => true,
    );
    const request = owner.request()!;
    expect(request.arguments).toEqual({ id: 'one' });
    expect(owner.request()).toBe(request);
    expect(owner.takeReply(request.reply({ done: true }))?.success).toBe(true);
    expect(builder).toHaveBeenCalledTimes(1);
  });

  it('refuses unsupported refinement and when callbacks without calling them', () => {
    const refinement = vi.fn(() => true);
    const when = vi.fn(() => true);
    expect(() =>
      deferredTool({
        name: 'unsupported',
        description: 'An unsupported parser',
        schemas: (z) => ({
          parameters: z.strictObject({
            count: z.number().refine(refinement, { when }),
          }),
          result: z.strictObject({ done: z.boolean() }),
        }),
      }),
    ).toThrow('Unsupported deferred schema');
    expect(refinement).not.toHaveBeenCalled();
    expect(when).not.toHaveBeenCalled();
  });

  it('can evaluate an unrecorded default during trusted construction before refusing it', () => {
    const value = vi.fn(() => 1);
    const builder = vi.fn();
    expect(() =>
      deferredTool({
        name: 'unsupported',
        description: 'Trusted construction can have effects',
        schemas: (z) => {
          builder();
          return {
            parameters: z.strictObject({ attempts: z.int().default(value) }),
            result: z.strictObject({ done: z.boolean() }),
          };
        },
      }),
    ).toThrow('Unsupported deferred schema');
    expect(builder).toHaveBeenCalledTimes(1);
    expect(value).toHaveBeenCalledTimes(1);
  });
});
