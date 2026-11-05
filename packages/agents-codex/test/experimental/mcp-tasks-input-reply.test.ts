import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  MCPInputReply,
  acceptsForm,
  captureJson,
  containsToken,
} from '../../src/experimental/mcp-tasks/input-reply';

const schema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    active: { type: 'boolean' },
    count: { type: 'integer' },
    score: { type: 'number' },
    colors: {
      type: 'array',
      items: { type: 'string', enum: ['blue', 'green'] },
    },
  },
};

describe('MCPInputReply', () => {
  it('captures approvals and gives callers detached copies including nested lists', () => {
    const content = { colors: ['blue'], enabled: false, count: 0 };
    const responses = { selected: { action: 'accept' as const, content } };
    const approval = new MCPInputReply({
      challenge: 'private-challenge',
      responses,
    });
    content.colors.push('green');
    responses.selected.action = 'accept';
    const first = approval.responses;
    (first.selected.content!.colors as string[]).push('red');
    first.selected.action = 'cancel';
    expect(approval.challenge).toBe('private-challenge');
    expect(approval.responses).toEqual({
      selected: {
        action: 'accept',
        content: { colors: ['blue'], enabled: false, count: 0 },
      },
    });
    expect(Object.isFrozen(approval)).toBe(true);
  });

  it('projects structurally typed responses to action and optional content only', () => {
    const response = {
      action: 'decline' as const,
      debug: 'private-job-key-canary',
      metadata: { internal: 'private-metadata-canary' },
    };
    const accepted = {
      action: 'accept' as const,
      content: { colors: ['blue'] },
      debug: 'private-job-key-canary',
    };
    const approval = new MCPInputReply({
      challenge: 'exact',
      responses: { first: response, second: accepted },
    });
    expect(approval.responses).toEqual({
      first: { action: 'decline' },
      second: { action: 'accept', content: { colors: ['blue'] } },
    });
    expect(JSON.stringify(approval.responses)).not.toContain('private-');
  });

  it('keeps approvals out of JSON, object spread and Node inspection', () => {
    const approval = new MCPInputReply({
      challenge: 'challenge-canary',
      responses: {
        'private-request-key': {
          action: 'accept',
          content: { value: 'answer-canary' },
        },
      },
    });
    expect(JSON.stringify(approval)).toBe('{}');
    expect({ ...approval }).toEqual({});
    expect(Object.keys(approval)).toEqual([]);
    for (const display of [
      inspect(approval),
      inspect(approval, { showHidden: true }),
    ]) {
      for (const privateValue of [
        'challenge-canary',
        'private-request-key',
        'answer-canary',
      ])
        expect(display).not.toContain(privateValue);
    }
  });

  it('preserves own __proto__ response and content keys safely', () => {
    const responses = JSON.parse(
      '{"__proto__":{"action":"accept","content":{"__proto__":"blue"}}}',
    );
    const approval = new MCPInputReply({ challenge: 'exact', responses });
    expect(Object.hasOwn(approval.responses, '__proto__')).toBe(true);
    expect(JSON.stringify(approval.responses)).toBe(
      '{"__proto__":{"action":"accept","content":{"__proto__":"blue"}}}',
    );
    expect(Object.getPrototypeOf(approval.responses)).toBe(Object.prototype);
  });

  it('rejects accessors and invalid responses without retaining raw causes', () => {
    let read = false;
    const options = Object.defineProperty({}, 'challenge', {
      enumerable: true,
      get() {
        read = true;
        throw new Error('private-error');
      },
    });
    expect(() => new MCPInputReply(options as never)).toThrow(
      'Invalid MCP input approval',
    );
    expect(read).toBe(false);
    for (const responses of [
      { key: { action: 'unknown' } },
      { key: { action: 'accept', content: { x: {} } } },
    ]) {
      try {
        new MCPInputReply({
          challenge: 'private-challenge',
          responses,
        } as never);
        expect.fail('must refuse');
      } catch (error) {
        expect(String(error)).toBe('Error: Invalid MCP input approval');
        expect((error as Error).cause).toBeUndefined();
      }
    }
  });
});

describe('plain finite JSON capture', () => {
  it('detaches nested data, preserves repeated noncyclic references and prototype keys', () => {
    const shared = ['blue'];
    const original = { list: shared, other: shared, scalar: 1.5, empty: null };
    const result = captureJson(original);
    shared.push('green');
    expect(result).toEqual({
      list: ['blue'],
      other: ['blue'],
      scalar: 1.5,
      empty: null,
    });
    const proto = captureJson(JSON.parse('{"__proto__":{"value":1}}'));
    expect(JSON.stringify(proto)).toBe('{"__proto__":{"value":1}}');
    expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
  });

  it('never invokes accessors, toJSON, or proxy traps', () => {
    let invoked = false;
    const getter = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        invoked = true;
        return 'private';
      },
    });
    const serializer = {
      toJSON() {
        invoked = true;
        return 'private';
      },
    };
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          invoked = true;
          return Object.prototype;
        },
        ownKeys() {
          invoked = true;
          return [];
        },
      },
    );
    for (const value of [getter, serializer, proxy])
      expect(() => captureJson(value)).toThrow('Expected plain finite JSON');
    expect(invoked).toBe(false);
  });

  it('rejects custom objects, cycles, nonfinite and non-JSON data', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const array = [1];
    Object.defineProperty(array, 'extra', { value: true });
    for (const value of [
      new Date(),
      new String('x'),
      cyclic,
      NaN,
      Infinity,
      undefined,
      BigInt(1),
      [undefined],
      Array(1),
      array,
      { [Symbol('private')]: 1 },
    ]) {
      expect(() => captureJson(value)).toThrow('Expected plain finite JSON');
    }
  });
});

describe('token reflection', () => {
  it.each([
    [{ nested: ['credential'] }, 'credential', true],
    [{ 'credential-key': false }, 'credential', true],
    ['left\nright', 'left\\nright', true],
    ['left"right', 'left\\"right', true],
    [1e-7, '1e-7', true],
    [false, 'false', true],
    [42, '42', true],
    [null, 'null', false],
    ['safe', 'credential', false],
  ])(
    'checks decoded/escaped strings and actual JSON scalar spellings',
    (value, token, expected) => {
      expect(containsToken(value, token)).toBe(expected);
    },
  );
});

describe('flat form acceptance', () => {
  it('accepts primitive fields and string-list choices', () => {
    expect(
      acceptsForm(schema, {
        name: 'Mark',
        active: false,
        count: 2.0,
        score: 0.5,
        colors: ['blue', 'green'],
      }),
    ).toBe(true);
    expect(acceptsForm(schema, { name: 'Mark' })).toBe(true);
    expect(
      acceptsForm(
        {
          ...schema,
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          additionalProperties: true,
        },
        { name: 'Mark' },
      ),
    ).toBe(true);
  });

  it('refuses wrong value types, missing required fields and extra answers', () => {
    for (const content of [
      {},
      { name: 'Mark', unknown: 'value' },
      { name: 1 },
      { name: 'Mark', active: 1 },
      { name: 'Mark', count: true },
      { name: 'Mark', count: 1.5 },
      { name: 'Mark', score: false },
      { name: 'Mark', colors: ['red'] },
      { name: 'Mark', colors: [1] },
    ])
      expect(acceptsForm(schema, content)).toBe(false);
  });

  it('refuses peer validation constraints and invalid schemas even without an answer', () => {
    for (const field of [
      { type: 'string', pattern: '(a+)+$' },
      { type: 'number', minimum: 0 },
      { type: 'object' },
      { type: 'string', enum: [1] },
      { type: 'number', enum: [1] },
      { type: 'string', items: { type: 'string' } },
      { type: 'array', enum: ['blue'], items: { type: 'string' } },
      {
        type: 'array',
        items: { type: 'string', title: 'unknown item annotation' },
      },
    ]) {
      expect(
        acceptsForm({ type: 'object', properties: { optional: field } }, {}),
      ).toBe(false);
    }
    for (const changed of [
      { required: null },
      { required: 'name' },
      { additionalProperties: null },
      { $schema: 'unsupported' },
      { title: 'unsupported top-level annotation' },
    ])
      expect(acceptsForm({ ...schema, ...changed }, { name: 'Mark' })).toBe(
        false,
      );
  });

  it('permits only the supported annotation fields and protects own prototype keys', () => {
    expect(
      acceptsForm(
        {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              title: 'Name',
              description: 'Your name',
              default: 'Mark',
              enum: ['Mark'],
            },
          },
        },
        { name: 'Mark' },
      ),
    ).toBe(true);
    expect(
      acceptsForm(
        JSON.parse(
          '{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"]}',
        ),
        JSON.parse('{"__proto__":"blue"}'),
      ),
    ).toBe(true);
    expect(
      acceptsForm(
        { type: 'object', properties: {} },
        JSON.parse('{"__proto__":"blue"}'),
      ),
    ).toBe(false);
  });
});
