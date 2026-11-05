import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod-deferred';
import * as core from 'zod-deferred/v4/core';
import { deferredTool } from '../../src/experimental/deferred-tool';
import {
  canonicalDeferredInput,
  createDeferredCodec,
  deferredDefault,
} from '../../src/experimental/deferred-codec';

// Deliberately materialize these known plain fixtures outside recognition.
function object<T extends z.ZodRawShape>(shape: T) {
  const schema = z.strictObject(shape);
  void schema.shape;
  return schema;
}

// Unsupported fixture metadata is materialized as explicit trusted construction.
function materialize(parameters: z.ZodType, result: z.ZodType) {
  z.toJSONSchema(result, { io: 'input' });
  z.toJSONSchema(parameters, { io: 'input' });
}

const empty = object({});
const codec = (schema: z.ZodType) => createDeferredCodec(schema, empty);

describe('private deferred deterministic codec', () => {
  it.each(['max', 'length'] as const)(
    'rejects oversized arrays with %s before collecting element errors',
    (limit) => {
      const schema = object({ values: z.array(z.number())[limit](1) });
      const c = createDeferredCodec(schema, schema);
      for (const parse of [c.parseInput, c.parseResult]) {
        expect(() => parse({ values: ['bad', 'bad', 'bad'] })).toThrowError(
          expect.objectContaining({
            issues: [
              expect.objectContaining({ code: 'too_big', path: ['values'] }),
            ],
          }),
        );
        expect(parse({ values: [1] })).toEqual({ values: [1] });
        expect(() => parse({ values: ['bad'] })).toThrowError(
          expect.objectContaining({
            issues: [
              expect.objectContaining({
                code: 'invalid_type',
                path: ['values', 0],
              }),
            ],
          }),
        );
      }
    },
  );

  it('uses owned declaration conversion for nested/default/union schemas', () => {
    const parameters = z.strictObject({
      job: z.union([
        z.strictObject({
          kind: z.literal('a'),
          attempts: deferredDefault(z.int().min(1), 1),
        }),
        z.strictObject({ kind: z.literal('b'), tags: z.array(z.string()) }),
      ]),
    });
    const result = z.strictObject({
      items: z.array(z.strictObject({ value: z.number().nullable() })),
    });
    expect(() => createDeferredCodec(parameters, result)).toThrow();
    const declaration = deferredTool({
      name: 'job',
      description: 'A private codec fixture',
      schemas: () => ({ parameters, result }),
    });
    expect(declaration.kind).toBe('manual');
    const c = createDeferredCodec(parameters, result);
    expect(c.parseInput({ job: { kind: 'a' } })).toEqual({
      job: { kind: 'a', attempts: 1 },
    });
    expect(c.parseInput({ job: { kind: 'b', tags: ['b', 'a'] } })).toEqual({
      job: { kind: 'b', tags: ['b', 'a'] },
    });
    expect(c.parseResult({ items: [{ value: null }, { value: 2 }] })).toEqual({
      items: [{ value: null }, { value: 2 }],
    });
  });

  it.each(['enum', 'literal', 'union'] as const)(
    'refuses retained %s accessors without rereading caller code after trusted conversion',
    (kind) => {
      const callback = vi.fn();
      let value: z.ZodType;
      if (kind === 'enum') {
        const entries = { selected: 'one' };
        callback.mockImplementation(() => 'one');
        Object.defineProperty(entries, 'selected', {
          get: callback,
          enumerable: true,
        });
        value = z.enum(entries);
      } else if (kind === 'literal') {
        const values: [string] = ['one'];
        callback.mockImplementation(() => 'one');
        Object.defineProperty(values, '0', { get: callback, enumerable: true });
        value = z.literal(values);
      } else {
        const first = z.strictObject({ id: z.string() });
        const second = z.strictObject({ id: z.number() });
        const options: [typeof first, typeof second] = [first, second];
        callback.mockImplementation(() => first);
        Object.defineProperty(options, '0', {
          get: callback,
          enumerable: true,
        });
        value = z.union(options);
      }
      const parameters = z.strictObject({ value });
      materialize(parameters, empty);
      callback.mockClear();
      let rejected = false;
      try {
        createDeferredCodec(parameters, empty);
      } catch {
        rejected = true;
      }
      expect(callback).not.toHaveBeenCalled();
      expect(rejected).toBe(true);
    },
  );

  it('refuses a caller-retained check definition getter after trusted declaration conversion', () => {
    const value = vi.fn(() => 1);
    const check = new core.$ZodCheckGreaterThan({
      check: 'greater_than',
      inclusive: true,
      get value() {
        return value();
      },
    });
    const parameters = z.strictObject({ n: z.number().check(check) });
    materialize(parameters, empty);
    value.mockClear();
    let rejected = false;
    try {
      createDeferredCodec(parameters, empty);
    } catch {
      rejected = true;
    }
    expect(value).not.toHaveBeenCalled();
    expect(rejected).toBe(true);
  });

  it('refuses retained check-list accessors before reading a check slot', () => {
    const check = new core.$ZodCheckGreaterThan({
      check: 'greater_than',
      inclusive: true,
      value: 1,
    });
    const slot = vi.fn(() => check);
    const checks = [check];
    Object.defineProperty(checks, '0', { get: slot, enumerable: true });
    const parameters = z.strictObject({
      n: new z.ZodNumber({ type: 'number', checks }),
    });
    materialize(parameters, empty);
    slot.mockClear();
    let rejected = false;
    try {
      createDeferredCodec(parameters, empty);
    } catch {
      rejected = true;
    }
    expect(slot).not.toHaveBeenCalled();
    expect(rejected).toBe(true);
  });

  it('refuses a retained catchall definition getter before checking strictness', () => {
    const type = vi.fn(() => 'never' as const);
    const catchall = new z.ZodNever({
      get type() {
        return type();
      },
    });
    const parameters = z.strictObject({}).catchall(catchall);
    materialize(parameters, empty);
    type.mockClear();
    let rejected = false;
    try {
      createDeferredCodec(parameters, empty);
    } catch {
      rejected = true;
    }
    expect(type).not.toHaveBeenCalled();
    expect(rejected).toBe(true);
  });

  it('refuses an inherited getter on a retained check definition without invoking it', () => {
    const value = vi.fn(() => 1);
    const definition = Object.create(
      {
        get value() {
          return value();
        },
      },
      {
        check: { value: 'greater_than', enumerable: true },
        inclusive: { value: true, enumerable: true },
      },
    ) as core.$ZodCheckGreaterThanDef;
    const parameters = z.strictObject({
      n: z.number().check(new core.$ZodCheckGreaterThan(definition)),
    });
    materialize(parameters, empty);
    value.mockClear();
    let rejected = false;
    try {
      createDeferredCodec(parameters, empty);
    } catch {
      rejected = true;
    }
    expect(value).not.toHaveBeenCalled();
    expect(rejected).toBe(true);
  });

  it('retains scalar default typing, validates omitted defaults and captures original schemas', () => {
    const parameters = object({
      id: z.string().min(1),
      attempts: deferredDefault(z.number().int().min(1).max(3), 1),
      enabled: deferredDefault(z.boolean(), false),
      label: deferredDefault(z.string(), ''),
      none: deferredDefault(z.null(), null),
    });
    const result = object({ value: z.number().nullable() });
    const c = createDeferredCodec(parameters, result);
    expect(c.parseInput({ id: 'one' })).toEqual({
      id: 'one',
      attempts: 1,
      enabled: false,
      label: '',
      none: null,
    });
    expect(c.parseInput({ id: 'one', attempts: 3 })).toMatchObject({
      attempts: 3,
    });
    expect(() => c.parseInput({ id: 'one', attempts: 4 })).toThrow();
    expect(() =>
      codec(object({ n: deferredDefault(z.number().min(2), 1) })),
    ).toThrow();
    expect(c.parseResult({ value: null })).toEqual({ value: null });
    expect(() => c.parseResult({})).toThrow();
  });

  it.each([
    z.string().min(2).max(4),
    z.string().length(3),
    z.string().regex(/^a/),
    z.string().startsWith('a').endsWith('c').includes('b'),
    z.email(),
    z.string().email(),
    z.uuid(),
    z.iso.date(),
    z.iso.datetime(),
    z.number().int().gt(0).lte(10).multipleOf(2),
    z.float32(),
    z.array(z.string()).min(1).max(2),
    z.array(z.string()).length(2),
  ])(
    'recognizes built-in bounds and own format checks without running them (%#)',
    (schema) => {
      expect(() => createDeferredCodec(schema, schema)).not.toThrow();
    },
  );

  it('enforces supported string, numeric, array and format constraints through Zod', () => {
    const c = codec(
      object({
        name: z
          .string()
          .min(2)
          .max(4)
          .regex(/^[a-z]+$/),
        email: z.email(),
        numbers: z.array(z.int().min(2).max(8).multipleOf(2)).length(2),
      }),
    );
    const good = { name: 'abc', email: 'a@example.com', numbers: [2, 8] };
    expect(c.parseInput(good)).toEqual(good);
    for (const bad of [
      { ...good, name: 'x' },
      { ...good, name: 'abcde' },
      { ...good, name: 'ABC' },
      { ...good, email: 'bad' },
      { ...good, numbers: [2] },
      { ...good, numbers: [2, 3] },
      { ...good, numbers: [2, 10] },
    ])
      expect(() => c.parseInput(bad)).toThrow();
  });

  it('rejects dynamic, unrecorded and cloned defaults without reading the getter', () => {
    const factory = vi.fn(() => 1);
    const dynamic = z.number().default(factory);
    const getter = vi.fn(() => 1);
    const constant = z.number().default(1);
    Object.defineProperty(constant._zod.def, 'defaultValue', { get: getter });
    const recorded = deferredDefault(z.number(), 1);
    const clone = recorded.clone();
    for (const schema of [dynamic, constant, clone, recorded.optional()]) {
      expect(() => codec(object({ n: schema }))).toThrow();
    }
    expect(factory).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    expect(() => createDeferredCodec(empty, object({ n: recorded }))).toThrow();
  });

  it('refuses replaced inner schemas on a helper wrapper', () => {
    const recorded = deferredDefault(z.number(), 1);
    recorded._zod.def.innerType = z.number().min(5);
    expect(() => codec(recorded)).toThrow();
  });

  it('refuses non-scalar helper arguments at construction', () => {
    for (const value of [undefined, Infinity, NaN, {}, [], () => 1]) {
      expect(() => deferredDefault(z.any(), value)).toThrow();
    }
  });

  it('refuses supplied or replaced when callbacks before any parsing', () => {
    const when = vi.fn(() => true);
    const supplied = z
      .string()
      .check(
        new core.$ZodCheckMinLength({ check: 'min_length', minimum: 1, when }),
      );
    const replaced = z.string().min(1);
    replaced._zod.def.checks![0]._zod.def.when = when;
    const numeric = z.number().check(
      new core.$ZodCheckGreaterThan({
        check: 'greater_than',
        value: 0,
        inclusive: false,
        when,
      }),
    );
    const formatted = z.email();
    formatted._zod.def.when = when;
    const getter = vi.fn(() => when);
    const accessor = z.string().min(1);
    Object.defineProperty(accessor._zod.def.checks![0]._zod.def, 'when', {
      get: getter,
    });
    for (const schema of [supplied, replaced, numeric, formatted, accessor])
      expect(() => codec(schema)).toThrow();
    expect(when).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects custom checks even when they claim a supported check name', () => {
    const custom = new core.$ZodCheck({ check: 'min_length' });
    const callback = vi.fn();
    custom._zod.check = callback;
    expect(() => codec(z.string().check(custom))).toThrow();
    expect(callback).not.toHaveBeenCalled();
  });

  it('rejects schema/check error callbacks and masks global maps during invalid validation', () => {
    const callback = vi.fn(() => 'application callback');
    expect(() => codec(z.string({ error: callback }))).toThrow();
    expect(() => codec(z.string().min(2, { error: callback }))).toThrow();
    expect(callback).not.toHaveBeenCalled();
    const previous = { ...z.config() };
    z.config({ customError: callback, localeError: callback });
    try {
      const c = createDeferredCodec(
        object({ x: z.string().min(2) }),
        z.number(),
      );
      expect(() => c.parseInput({ x: 'x' })).toThrow();
      expect(() => c.parseResult('bad')).toThrow();
      expect(() => codec(deferredDefault(z.number().min(2), 1))).toThrow();
      expect(callback).not.toHaveBeenCalled();
    } finally {
      z.config({
        customError: previous.customError,
        localeError: previous.localeError,
      });
    }
  });

  it('recognizes the whole declaration graph before validating any default', () => {
    const custom = vi.fn((value: number) => value > 0);
    expect(() =>
      createDeferredCodec(
        object({ n: deferredDefault(z.number().refine(custom), 1) }),
        empty,
      ),
    ).toThrow();
    expect(custom).not.toHaveBeenCalled();
  });

  it.each([
    z.string().transform((s) => s),
    z.coerce.number(),
    z.string().trim(),
    z.string().toLowerCase(),
    z.string().optional(),
    z.number().catch(0),
    z.number().prefault(1),
    z.lazy(() => z.string()),
    z.unknown(),
    z.date(),
    z.bigint(),
    z.record(z.string(), z.string()),
    z.object({}),
    z.looseObject({}),
    z.stringFormat('custom', () => true),
    z.url(),
  ])('rejects unsupported schemas before recovery (%#)', (schema) => {
    expect(() => codec(schema)).toThrow();
  });

  it('accepts input literals and closed unions without hiding provider fields', () => {
    const parameters = object({
      job: z.union([
        object({
          kind: z.literal('a'),
          count: deferredDefault(z.int(), 1),
        }),
        object({ kind: z.literal('b'), title: z.string() }),
      ]),
      mode: z.enum(['fast', 'safe']),
    });
    const c = codec(parameters);
    expect(c.parseInput({ job: { kind: 'a' }, mode: 'fast' })).toEqual({
      job: { kind: 'a', count: 1 },
      mode: 'fast',
    });
    expect(() =>
      c.parseInput({ job: { kind: 'a', title: 'lost' }, mode: 'fast' }),
    ).toThrow();
    expect(() => createDeferredCodec(empty, parameters)).toThrow();
  });

  it('rejects extra provider fields at every object depth and retains array order', () => {
    const c = codec(object({ items: z.array(object({ id: z.string() })) }));
    expect(c.parseInput({ items: [{ id: 'b' }, { id: 'a' }] })).toEqual({
      items: [{ id: 'b' }, { id: 'a' }],
    });
    expect(() => c.parseInput({ items: [], extra: 1 })).toThrow();
    expect(() => c.parseInput({ items: [{ id: 'a', extra: 1 }] })).toThrow();
  });

  it('rejects JSON losses, rich values and cycles before serialization or getters', () => {
    const getter = vi.fn(() => 1);
    const accessor = Object.defineProperty({}, 'x', {
      get: getter,
      enumerable: true,
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const sparse = Array(1);
    (sparse as unknown as Record<string, unknown>)['4294967295'] = 'lost';
    class RichArray extends Array {
      toJSON = vi.fn(() => []);
    }
    for (const value of [
      NaN,
      Infinity,
      undefined,
      1n,
      new Date(),
      new Map(),
      { x: undefined },
      [undefined],
      Array(1),
      sparse,
      accessor,
      cycle,
      new RichArray(),
      { [Symbol('lost')]: 1 },
      Object.defineProperty({}, 'hidden', { value: 1 }),
    ])
      expect(() => canonicalDeferredInput(value)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('refuses signed zero instead of conflating handler inputs or reply bytes', () => {
    const c = createDeferredCodec(object({ n: z.number() }), z.number());
    expect(c.parseInput({ n: 0 })).toEqual({ n: 0 });
    expect(canonicalDeferredInput({ n: 0 })).toBe('{"n":0}');
    expect(() => c.parseInput({ n: -0 })).toThrow();
    expect(() => c.parseResult(-0)).toThrow();
    expect(() => deferredDefault(z.number(), -0)).toThrow();
    expect(() => canonicalDeferredInput({ n: [-0] })).toThrow();
  });

  it('does not invoke lazy object-field getters or silently drop provider keys', () => {
    const field = vi.fn(() => z.string());
    const shape = Object.defineProperty({}, 'self', {
      get: field,
      enumerable: true,
    });
    expect(() => codec(z.strictObject(shape))).toThrow();
    expect(field).not.toHaveBeenCalled();
    const c = codec(object({ ['__proto__']: z.number() }));
    expect(() => c.parseInput(JSON.parse('{"__proto__":1}'))).toThrow();
  });

  it('canonicalizes only input object keys, preserving scalar values and array order', () => {
    expect(
      canonicalDeferredInput({ z: [2, 1], a: { y: false, b: null } }),
    ).toBe('{"a":{"b":null,"y":false},"z":[2,1]}');
    expect(canonicalDeferredInput({ '2': 'two', '10': 'ten' })).toBe(
      '{"10":"ten","2":"two"}',
    );
    const c = createDeferredCodec(
      empty,
      object({ z: z.number(), a: z.string() }),
    );
    expect(JSON.stringify(c.parseResult({ z: 1, a: 'later' }))).toBe(
      '{"z":1,"a":"later"}',
    );
  });
});
