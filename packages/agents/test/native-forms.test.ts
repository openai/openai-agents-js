import { inspect } from 'node:util';
import '@hyperjump/json-schema/formats';
import {
  getAllRegisteredSchemaUris,
  registerSchema,
  unregisterSchema,
  validate as compileSchema,
  getShouldValidateFormat,
  getShouldValidateSchema,
  setShouldValidateFormat,
  setShouldValidateSchema,
} from '@hyperjump/json-schema/draft-2020-12';
import { describe, expect, it, vi } from 'vitest';
import { prepareNativeForm } from '../src/runtime/native-forms';

// These pure validator tests establish no native grant or transport acceptance.
const privateText = 'synthetic-private-form-value';

function privateFailure(run: () => unknown, message?: string) {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TypeError);
  const error = caught as TypeError;
  if (message) expect(error.message).toBe(message);
  expect(error.cause).toBeUndefined();
  expect(inspect(error, { depth: 8 })).not.toContain(privateText);
  expect(error.stack).not.toContain(privateText);
  return error;
}

async function privatePreparationFailure(
  run: () => Promise<unknown>,
  message?: string,
) {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  return privateFailure(() => {
    throw caught;
  }, message);
}

async function withExternalValidatorSettings(
  settings: { schema: boolean; format: boolean },
  run: () => Promise<void>,
) {
  const originalSchema = getShouldValidateSchema();
  const originalFormat = getShouldValidateFormat();
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Unexpected external schema fetch'));
  setShouldValidateSchema(settings.schema);
  setShouldValidateFormat(settings.format);
  try {
    await run();
  } finally {
    const observed = {
      schema: getShouldValidateSchema(),
      format: getShouldValidateFormat(),
    };
    const fetchCalls = fetch.mock.calls.length;
    setShouldValidateSchema(originalSchema);
    setShouldValidateFormat(originalFormat);
    fetch.mockRestore();
    expect(observed).toEqual(settings);
    expect(fetchCalls).toBe(0);
  }
}

const primitiveSchema = {
  type: 'object',
  properties: {
    'display-name': { type: 'string', minLength: 2, maxLength: 7 },
    count: { type: 'integer', minimum: 1, maximum: 3 },
    price: { type: 'number', minimum: 0.5, maximum: 2.5 },
    enabled: { type: 'boolean' },
    choice: { type: 'string', enum: ['a', 'b'], enumNames: ['Alpha', 'Beta'] },
    titled: {
      type: 'string',
      oneOf: [
        { const: 'a', title: 'Alpha' },
        { const: 'b', title: 'Beta' },
      ],
    },
    multiple: {
      type: 'array',
      items: { type: 'string', enum: ['a', 'b', 'c'] },
      minItems: 1,
      maxItems: 2,
    },
    'titled-multiple': {
      type: 'array',
      items: {
        anyOf: [
          { const: 'a', title: 'Alpha' },
          { const: 'b', title: 'Beta' },
        ],
      },
      minItems: 1,
      maxItems: 2,
    },
    optional: { type: 'string', default: 'offered default' },
  },
  required: ['display-name', 'count', 'choice'],
};
const primitiveValues = {
  'display-name': 'A name',
  count: 2,
  price: 1.5,
  enabled: true,
  choice: 'b',
  titled: 'a',
  multiple: ['a', 'c'],
  'titled-multiple': ['a', 'b'],
};

const nestedSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  $defs: { tag: { type: 'string', minLength: 2 } },
  properties: {
    profile: {
      type: 'object',
      properties: { name: { type: 'string' }, enabled: { type: 'boolean' } },
      required: ['name', 'enabled'],
      additionalProperties: false,
    },
    tags: { type: 'array', items: { $ref: '#/$defs/tag' }, minItems: 1 },
    count: { type: 'integer', minimum: 1 },
    note: { type: ['string', 'null'] },
    format: { type: 'string', format: 'email' },
  },
  required: ['profile', 'tags', 'count', 'note'],
  additionalProperties: false,
};
const nestedValues = {
  profile: { name: 'Sample', enabled: true },
  tags: ['alpha', 'beta'],
  count: 2,
  note: null,
  format: 'an annotation',
};

describe('standard native primitive forms', () => {
  it('preserves literal keys and offered values without adding defaults', async () => {
    const form = await prepareNativeForm('form', primitiveSchema);
    expect(form.schema).toEqual(primitiveSchema);
    expect(form.validate(primitiveValues)).toEqual(primitiveValues);
    expect(form.validate(primitiveValues)).not.toHaveProperty('optional');
    expect(
      form.validate({ 'display-name': 'ab', count: 1, choice: 'a' }),
    ).toEqual({ 'display-name': 'ab', count: 1, choice: 'a' });
    expect(
      form.validate({ 'display-name': 'abcdefg', count: 3, choice: 'b' }),
    ).toEqual({ 'display-name': 'abcdefg', count: 3, choice: 'b' });
    expect(form.validate({ ...primitiveValues, price: 0.5 }).price).toBe(0.5);
    expect(form.validate({ ...primitiveValues, price: 2.5 }).price).toBe(2.5);
  });

  it.each([
    ['short string', 'display-name', 'x'],
    ['long string', 'display-name', privateText],
    ['string type', 'display-name', 3],
    ['low integer', 'count', 0],
    ['high integer', 'count', 4],
    ['fractional integer', 'count', 1.5],
    ['boolean integer', 'count', true],
    ['string integer', 'count', '2'],
    ['low number', 'price', 0.4],
    ['high number', 'price', 2.6],
    ['boolean number', 'price', false],
    ['string number', 'price', '1.5'],
    ['string boolean', 'enabled', 'true'],
    ['numeric boolean', 'enabled', 1],
    ['foreign enum', 'choice', 'c'],
    ['enum label', 'choice', 'Beta'],
    ['titled label', 'titled', 'Alpha'],
    ['empty selection', 'multiple', []],
    ['too many selections', 'multiple', ['a', 'b', 'c']],
    ['foreign selection', 'multiple', ['foreign']],
    ['selection type', 'multiple', ['a', 2]],
    ['scalar selection', 'multiple', 'a'],
    ['titled selection label', 'titled-multiple', ['Beta']],
    ['titled foreign selection', 'titled-multiple', ['foreign']],
  ])('rejects %s and allows a corrected answer', async (_name, key, value) => {
    const form = await prepareNativeForm('form', primitiveSchema);
    privateFailure(() => form.validate({ ...primitiveValues, [key]: value }));
    expect(form.validate(primitiveValues)).toEqual(primitiveValues);
  });

  it('requires a mapping and all required keys, and rejects unknown keys', async () => {
    const form = await prepareNativeForm('form', primitiveSchema);
    for (const value of [null, [], 'answer', 1])
      privateFailure(() => form.validate(value));
    privateFailure(() => form.validate({ count: 2, choice: 'a' }));
    const { 'display-name': name, ...rest } = primitiveValues;
    privateFailure(() => form.validate({ ...rest, display_name: name }));
    privateFailure(() =>
      form.validate({ ...primitiveValues, unknown: privateText }),
    );
    const permissive = await prepareNativeForm('form', {
      type: 'object',
      properties: {},
      additionalProperties: true,
    });
    expect(permissive.validate({ unknown: privateText })).toEqual({
      unknown: privateText,
    });
  });

  it.each([
    [
      'email',
      'person@example.invalid',
      [privateText, 'not two@addresses@example.invalid'],
    ],
    [
      'uri',
      'urn:example:case-7',
      [
        'relative/path',
        'https://example.invalid/bad%GG',
        'https://example.invalid/<private>',
      ],
    ],
    ['date', '2024-02-29', ['2023-02-29', '20240229']],
    [
      'date-time',
      '2024-02-29T23:42:00Z',
      ['2024-02-29', '2024-02-30T00:00:00Z', '2024-02-29T23:42:00'],
    ],
  ] as const)(
    'checks the standard %s format',
    async (format, valid, invalid) => {
      const form = await prepareNativeForm('form', {
        type: 'object',
        properties: { value: { type: 'string', format } },
      });
      expect(form.validate({ value: valid })).toEqual({ value: valid });
      for (const value of invalid)
        privateFailure(() => form.validate({ value }));
    },
  );

  it.each(['a . b@example.com', 'a@b . com', '"a" . b@example.com'])(
    'rejects obsolete email syntax %s and accepts a corrected answer',
    async (email) => {
      const form = await prepareNativeForm('form', {
        type: 'object',
        properties: { email: { type: 'string', format: 'email' } },
      });
      privateFailure(
        () => form.validate({ email }),
        'MCP form failed validation',
      );
      expect(form.validate({ email: 'a.b@example.com' })).toEqual({
        email: 'a.b@example.com',
      });
    },
  );

  it('accepts quoted email mailboxes and domain literals', async () => {
    const form = await prepareNativeForm('form', {
      type: 'object',
      properties: { email: { type: 'string', format: 'email' } },
    });
    for (const email of [
      '"sample user"@example.com',
      'user@[127.0.0.1]',
      'user@localhost',
      'user@[IPv6:2001:db8::1]',
      'user@[opaque-domain]',
      'user(comment)@example.com',
      'user(outer(inner))@example.com',
      'user(注釈)@example.com',
      'user@例子.测试',
      '" "@example.com',
      '"sample\\"user"@example.com',
    ])
      expect(form.validate({ email })).toEqual({ email });
  });

  it('rejects non-ASCII mailboxes and malformed bracketed URI hosts', async () => {
    const email = await prepareNativeForm('form', {
      type: 'object',
      properties: { value: { type: 'string', format: 'email' } },
    });
    privateFailure(() => email.validate({ value: 'usér@example.com' }));
    const uri = await prepareNativeForm('form', {
      type: 'object',
      properties: { value: { type: 'string', format: 'uri' } },
    });
    expect(uri.validate({ value: 'https://[2001:db8::1]/path' })).toEqual({
      value: 'https://[2001:db8::1]/path',
    });
    for (const value of [
      'https://[2001:db8::1/path',
      'https://[not-an-ip]/path',
      'https://[127.0.0.1]/path',
    ])
      privateFailure(() => uri.validate({ value }));
  });

  it.each([
    'https://example.com:abc',
    'https://[::1]:abc',
    'https://example.com:%38%30',
    'https://example.com:12:34',
    'https://user@@example.com/',
    'https://[user]@example.com/',
    'custom://2001:db8::1/',
    'custom://[v1.host%20]/',
    'custom://[::1]suffix/',
    'custom:path[segment]',
    'custom:path#first#second',
    'https://example.com/\n',
    'https://example.com/\r',
    'https://example.com/\u2028',
  ])(
    'rejects malformed URI authority %s without invalidating the form',
    async (value) => {
      const form = await prepareNativeForm('form', {
        type: 'object',
        properties: { value: { type: 'string', format: 'uri' } },
      });
      privateFailure(
        () => form.validate({ value }),
        'MCP form failed validation',
      );
      expect(form.validate({ value: 'https://example.com:443/path' })).toEqual({
        value: 'https://example.com:443/path',
      });
    },
  );

  it.each([
    'urn:example:case-7',
    'mailto:user@example.com',
    'file:///tmp/report.txt',
    'custom:',
    'custom://',
    'custom://user%40name:pass@example.com:123/path?query#fragment',
    'custom://example.com:',
    'custom://[2001:db8::1]:999999/path',
    "custom://[v1.host:port!$&'()*+,;=]/",
  ])(
    'preserves generic URI syntax without URL normalization: %s',
    async (value) => {
      const form = await prepareNativeForm('form', {
        type: 'object',
        properties: { value: { type: 'string', format: 'uri' } },
      });
      expect(form.validate({ value })).toEqual({ value });
    },
  );

  it('requires a bare addr-spec rather than a display name, group, or list', async () => {
    const form = await prepareNativeForm('form', {
      type: 'object',
      properties: { email: { type: 'string', format: 'email' } },
    });
    for (const email of [
      'Sample User <user@example.com>',
      '<user@example.com>',
      'Friends: user@example.com;',
      'first@example.com, second@example.com',
      '""@example.com',
      'user\r\n @example.com',
    ])
      privateFailure(() => form.validate({ email }));
  });

  it('rejects unsupported standard schemas rather than dropping constraints', async () => {
    for (const schema of [
      { type: 'array' },
      {
        type: 'object',
        properties: { value: { type: 'string', pattern: privateText } },
      },
      {
        type: 'object',
        properties: {
          value: { $ref: 'https://should-not-fetch.invalid/schema' },
        },
      },
    ])
      await privatePreparationFailure(
        () => prepareNativeForm('form', schema),
        'Unsupported MCP form schema',
      );
  });
});

describe('general standard native forms', () => {
  it('preserves nested objects, arrays and local references with private answer failures', async () => {
    const form = await prepareNativeForm('form', nestedSchema);
    expect(form.schema).toEqual(nestedSchema);
    expect(form.validate(nestedValues)).toEqual(nestedValues);
    for (const invalid of [
      { ...nestedValues, profile: { name: privateText } },
      { ...nestedValues, tags: ['x'] },
      { ...nestedValues, tags: [3] },
      { ...nestedValues, count: true },
      { ...nestedValues, extra: privateText },
    ])
      privateFailure(
        () => form.validate(invalid),
        'MCP form failed validation',
      );
    expect(form.validate(nestedValues)).toEqual(nestedValues);
  });

  it.each([true, false])(
    'enforces root allOf constraints with top-level properties=%s and treats formats as annotations',
    async (properties) => {
      const schema = {
        type: 'object',
        ...(properties
          ? {
              properties: {
                count: { type: 'integer' },
                email: { type: 'string', format: 'email' },
              },
            }
          : {}),
        allOf: [
          {
            properties: { count: { type: 'integer', minimum: 2 } },
            required: ['count'],
          },
        ],
      };
      await withExternalValidatorSettings(
        { schema: true, format: true },
        async () => {
          const registered = getAllRegisteredSchemaUris().sort();
          const form = await prepareNativeForm('form', schema);
          expect(getAllRegisteredSchemaUris().sort()).toEqual(registered);
          expect(form.schema).toEqual(schema);
          const valid = { count: 2, email: 'a format annotation' };
          expect(form.validate(valid)).toEqual(valid);
          for (const value of [{}, { count: 1 }, { count: true }])
            privateFailure(() => form.validate(value));
        },
      );
    },
  );

  it.each([undefined, false, true])(
    'keeps primitive formats, types, bounds and enums strict with additionalProperties=%s',
    async (additionalProperties) => {
      const form = await prepareNativeForm('form', {
        type: 'object',
        properties: {
          count: { type: 'integer', minimum: 1 },
          email: { type: 'string', format: 'email' },
          choice: { type: 'string', enum: ['a', 'b'] },
        },
        required: ['count', 'email', 'choice'],
        ...(additionalProperties === undefined ? {} : { additionalProperties }),
      });
      const valid = { count: 2, email: 'a@example.invalid', choice: 'a' };
      for (const invalid of [
        { ...valid, count: true },
        { ...valid, count: 0 },
        { ...valid, email: privateText },
        { ...valid, choice: 'c' },
      ])
        privateFailure(() => form.validate(invalid));
      const extra = { ...valid, extra: { values: [null, true, 2, 'value'] } };
      if (additionalProperties === true)
        expect(form.validate(extra)).toEqual(extra);
      else privateFailure(() => form.validate(extra));
      privateFailure(() => form.validate({ ...valid, extra: { value: NaN } }));
      expect(form.validate(valid)).toEqual(valid);
    },
  );
});

describe.each(['openai/form', 'openaiForm'] as const)(
  '%s extension forms',
  (mode) => {
    it.each(['const', 'enum'] as const)(
      'keeps reserved-looking %s operands as literal JSON data',
      async (keyword) => {
        await withExternalValidatorSettings(
          { schema: true, format: true },
          async () => {
            const offered = {
              undefined: 'literal',
              $schema: 'https://should-not-fetch.invalid/schema',
              $ref: 'https://should-not-fetch.invalid/value',
            };
            const schema = {
              type: 'object',
              properties: {
                value: {
                  [keyword]: keyword === 'const' ? offered : [offered],
                },
              },
              required: ['value'],
            };
            const form = await prepareNativeForm(mode, schema);
            expect(form.validate({ value: { ...offered } })).toEqual({
              value: offered,
            });
            privateFailure(
              () =>
                form.validate({ value: { ...offered, undefined: 'changed' } }),
              'MCP form failed validation',
            );
            expect(form.schema).toEqual(schema);
          },
        );
      },
    );

    it.each(['const', 'enum'] as const)(
      'uses JSON equality for signed zero in %s operands',
      async (keyword) => {
        for (const offered of [0, -0]) {
          const schema = {
            type: 'object',
            properties: {
              value: {
                [keyword]: keyword === 'const' ? offered : [offered],
              },
            },
          };
          const form = await prepareNativeForm(mode, schema);
          expect(form.validate({ value: -offered })).toEqual({
            value: -offered,
          });
          for (const value of [1, '0', false, null])
            privateFailure(
              () => form.validate({ value }),
              'MCP form failed validation',
            );
          expect(form.schema).toEqual(schema);
        }
      },
    );

    it('preserves reserved-looking default and example data without fetching', async () => {
      await withExternalValidatorSettings(
        { schema: true, format: true },
        async () => {
          const annotation = {
            $schema: 'https://should-not-fetch.invalid/schema',
            undefined: 'literal',
          };
          const schema = {
            type: 'object',
            default: annotation,
            examples: [annotation],
            properties: {
              value: {
                type: 'string',
                default: annotation,
                examples: [annotation],
              },
            },
          };
          const form = await prepareNativeForm(mode, schema);
          expect(form.validate({ value: 'ok' })).toEqual({ value: 'ok' });
          expect(form.validate({})).toEqual({});
          privateFailure(
            () => form.validate({ value: 1 }),
            'MCP form failed validation',
          );
          expect(form.schema).toEqual(schema);
          expect(schema.default).toEqual(annotation);
          expect(schema.examples).toEqual([annotation]);
        },
      );
    });

    it('rejects literal inherited-name keys that no branch evaluated', async () => {
      const form = await prepareNativeForm(mode, {
        type: 'object',
        anyOf: [
          { properties: { a: { type: 'string' } } },
          { properties: { b: { type: 'string' } } },
        ],
        unevaluatedProperties: false,
      });
      expect(form.validate({ a: 'x' })).toEqual({ a: 'x' });
      for (const key of [
        'extra',
        '__proto__',
        'constructor',
        'toString',
        'hasOwnProperty',
      ])
        privateFailure(
          () => form.validate({ a: 'x', [key]: 'unoffered' }),
          'MCP form failed validation',
        );
    });

    it.each(['const', 'enum'] as const)(
      'uses JSON equality for object %s values',
      async (keyword) => {
        const offered = {
          valueOf: 'ordinary',
          toString: { ['__proto__']: 'data' },
          constructor: 'value',
          numbers: [0, '0'],
        };
        const form = await prepareNativeForm(mode, {
          type: 'object',
          [keyword]: keyword === 'const' ? offered : [offered, { other: true }],
        });
        const answer = {
          numbers: [-0, '0'],
          constructor: 'value',
          toString: { ['__proto__']: 'data' },
          valueOf: 'ordinary',
        };
        expect(form.validate(answer)).toEqual(answer);
        for (const value of [
          { ...answer, valueOf: privateText },
          { ...answer, numbers: ['0', '0'] },
          { ...answer, extra: true },
        ])
          privateFailure(
            () => form.validate(value),
            'MCP form failed validation',
          );
      },
    );

    it('rejects duplicate literal strings in a typed unique array', async () => {
      const form = await prepareNativeForm(mode, {
        type: 'object',
        properties: {
          values: {
            type: 'array',
            items: { type: 'string' },
            uniqueItems: true,
          },
        },
      });
      privateFailure(
        () => form.validate({ values: ['__proto__', '__proto__'] }),
        'MCP form failed validation',
      );
      expect(form.validate({ values: ['__proto__', 'ordinary'] })).toEqual({
        values: ['__proto__', 'ordinary'],
      });
    });

    it('uses JSON equality for mixed unique arrays', async () => {
      const form = await prepareNativeForm(mode, {
        type: 'object',
        properties: { values: { type: 'array', uniqueItems: true } },
      });
      for (const values of [
        [0, '0', false, null],
        [{ valueOf: 'a' }, { valueOf: 'b' }],
        [{ toString: 'a' }, { toString: 'b' }],
        [{}, []],
        [{ '\u00e9': 1 }, { 'e\u0301': 1 }],
      ])
        expect(form.validate({ values })).toEqual({ values });
      for (const values of [
        ['__proto__', '__proto__'],
        [0, -0],
        [null, null],
        [{ valueOf: 'a' }, { valueOf: 'a' }],
        [{ toString: 'a' }, { toString: 'a' }],
        [
          { '\u00e9': 1, 'e\u0301': 2 },
          { 'e\u0301': 2, '\u00e9': 1 },
        ],
      ])
        privateFailure(
          () => form.validate({ values }),
          'MCP form failed validation',
        );
    });

    it.each([
      {},
      { additionalProperties: false },
      { unevaluatedProperties: false },
    ])('enforces literal __proto__ fields with %j', async (bounds) => {
      const schema = {
        type: 'object',
        properties: { ['__proto__']: { type: 'string', minLength: 2 } },
        required: ['__proto__'],
        ...bounds,
      };
      const form = await prepareNativeForm(mode, schema);
      const values = { ['__proto__']: 'ok' };
      const result = form.validate(values);
      expect(result).toEqual(values);
      expect(result).not.toBe(values);
      expect(Object.hasOwn(result, '__proto__')).toBe(true);
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      for (const value of [2, 'x'])
        privateFailure(
          () => form.validate({ ['__proto__']: value }),
          'MCP form failed validation',
        );
      privateFailure(() => form.validate({}), 'MCP form failed validation');
      if (Object.keys(bounds).length) {
        privateFailure(
          () => form.validate({ ...values, extra: privateText }),
          'MCP form failed validation',
        );
        privateFailure(
          () => form.validate({ ...values, ['__proto__\n']: 'ok' }),
          'MCP form failed validation',
        );
      }
      expect(form.schema).toEqual(schema);
    });

    it('enforces literal __proto__ fields in referenced nested schemas', async () => {
      const schema = {
        type: 'object',
        $defs: {
          entry: {
            type: 'object',
            properties: { ['__proto__']: { type: 'integer' } },
            required: ['__proto__'],
            additionalProperties: false,
          },
        },
        properties: {
          entries: { type: 'array', items: { $ref: '#/$defs/entry' } },
        },
      };
      const form = await prepareNativeForm(mode, schema);
      const values = { entries: [{ ['__proto__']: 2 }] };
      expect(form.validate(values)).toEqual(values);
      privateFailure(
        () => form.validate({ entries: [{ ['__proto__']: '2' }] }),
        'MCP form failed validation',
      );
      expect(form.schema).toEqual(schema);
    });

    it('validates nested JSON without coercion and treats formats as annotations', async () => {
      const form = await prepareNativeForm(mode, nestedSchema);
      expect(form.validate(nestedValues)).toEqual(nestedValues);
      for (const value of [
        { ...nestedValues, profile: { name: privateText, enabled: 'true' } },
        { ...nestedValues, tags: ['x'] },
        { ...nestedValues, count: 0 },
        { ...nestedValues, count: true },
        { ...nestedValues, count: '2' },
        { ...nestedValues, unknown: privateText },
        {
          ...nestedValues,
          profile: { name: 'Sample', enabled: true, extra: privateText },
        },
      ])
        privateFailure(
          () => form.validate(value),
          'MCP form failed validation',
        );
      expect(form.validate(nestedValues)).toEqual(nestedValues);
    });

    it('supports compositions, dependencies, and evaluated properties', async () => {
      const form = await prepareNativeForm(mode, {
        type: 'object',
        properties: {
          kind: { enum: ['text', 'number'] },
          payload: { anyOf: [{ type: 'string' }, { type: 'number' }] },
          both: { allOf: [{ type: 'integer' }, { minimum: 2 }] },
          only: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
          safe: { not: { const: 'forbidden' } },
          token: { type: 'string' },
        },
        required: ['kind', 'payload'],
        dependentRequired: { token: ['safe'] },
        dependentSchemas: { token: { properties: { safe: { const: true } } } },
        unevaluatedProperties: false,
      });
      const valid = {
        kind: 'text',
        payload: 'answer',
        both: 2,
        only: 3,
        safe: true,
        token: 'x',
      };
      expect(form.validate(valid)).toEqual(valid);
      expect(form.validate({ kind: 'number', payload: 2 })).toEqual({
        kind: 'number',
        payload: 2,
      });
      for (const value of [
        { ...valid, payload: null },
        { ...valid, both: 1 },
        { ...valid, only: null },
        { kind: 'text', payload: 'answer', safe: 'forbidden' },
        { kind: 'text', payload: 'answer', token: 'x' },
        { ...valid, safe: false },
        { ...valid, extra: privateText },
      ])
        privateFailure(
          () => form.validate(value),
          'MCP form failed validation',
        );
    });

    it('preserves existing allOf when dependent schemas track evaluated fields', async () => {
      const schema = {
        type: 'object',
        properties: { token: { type: 'string' } },
        allOf: [{ properties: { payload: { type: 'integer', minimum: 1 } } }],
        dependentSchemas: {
          token: {
            properties: { safe: { const: true } },
            required: ['safe'],
          },
        },
        unevaluatedProperties: false,
      };
      const form = await prepareNativeForm(mode, schema);
      expect(form.schema).toEqual(schema);
      expect(form.validate({ payload: 1 })).toEqual({ payload: 1 });
      expect(form.validate({ payload: 1, token: 'x', safe: true })).toEqual({
        payload: 1,
        token: 'x',
        safe: true,
      });
      for (const values of [
        { payload: 0 },
        { payload: 1, token: 'x' },
        { payload: 1, token: 'x', safe: false },
        { payload: 1, token: 'x', safe: true, extra: privateText },
        { payload: 1, safe: true },
      ])
        privateFailure(
          () => form.validate(values),
          'MCP form failed validation',
        );
      expect(form.schema).toEqual(schema);
    });

    it('applies dependent schemas only to object values', async () => {
      const schema = {
        type: 'object',
        properties: {
          value: {
            dependentSchemas: {
              present: { type: 'object', required: ['confirm'] },
            },
          },
        },
      };
      const form = await prepareNativeForm(mode, schema);
      for (const value of [
        'plain',
        [],
        7,
        true,
        null,
        {},
        { present: true, confirm: true },
      ])
        expect(form.validate({ value })).toEqual({ value });
      privateFailure(
        () => form.validate({ value: { present: true } }),
        'MCP form failed validation',
      );
      expect(form.schema).toEqual(schema);
    });

    it('applies property count, name, exclusive numeric, and multiple bounds', async () => {
      const form = await prepareNativeForm(mode, {
        type: 'object',
        minProperties: 1,
        maxProperties: 2,
        propertyNames: { minLength: 2 },
        additionalProperties: {
          type: 'number',
          exclusiveMinimum: 0,
          exclusiveMaximum: 10,
          multipleOf: 2,
        },
      });
      expect(form.validate({ aa: 2, bb: 8 })).toEqual({ aa: 2, bb: 8 });
      for (const values of [
        {},
        { a: 2 },
        { aa: 0 },
        { aa: 10 },
        { aa: 3 },
        { aa: 2, bb: 4, cc: 6 },
      ])
        privateFailure(
          () => form.validate(values),
          'MCP form failed validation',
        );
    });

    it('supports tuple prefixes, contains, item bounds, and evaluated items', async () => {
      const form = await prepareNativeForm(mode, {
        type: 'object',
        properties: {
          tuple: {
            type: 'array',
            prefixItems: [{ const: 'head' }],
            unevaluatedItems: false,
          },
          matches: {
            type: 'array',
            items: { type: 'integer' },
            contains: { minimum: 2 },
            uniqueItems: true,
          },
        },
        required: ['tuple', 'matches'],
      });
      expect(form.validate({ tuple: ['head'], matches: [1, 2] })).toEqual({
        tuple: ['head'],
        matches: [1, 2],
      });
      for (const value of [
        { tuple: ['wrong'], matches: [1, 2] },
        { tuple: ['head', 'extra'], matches: [1, 2] },
        { tuple: ['head'], matches: [0, 1] },
        { tuple: ['head'], matches: [1, 1, 2] },
      ])
        privateFailure(
          () => form.validate(value),
          'MCP form failed validation',
        );
    });

    it.each([
      ['tag', 'tag'],
      ['a/b', 'a~1b'],
      ['a~b', 'a~0b'],
      ['a b', 'a%20b'],
      ['a%2Fb', 'a%252Fb'],
    ])(
      'resolves the direct definition %s with token %s',
      async (name, token) => {
        const form = await prepareNativeForm(mode, {
          type: 'object',
          $defs: { [name]: { type: 'string', minLength: 2 } },
          properties: { value: { $ref: `#/$defs/${token}` } },
        });
        expect(form.validate({ value: 'ok' })).toEqual({ value: 'ok' });
        privateFailure(
          () => form.validate({ value: 'x' }),
          'MCP form failed validation',
        );
      },
    );

    it('accepts boolean definition targets and leaves data annotations uninterpreted', async () => {
      const form = await prepareNativeForm(mode, {
        type: 'object',
        $defs: { yes: true, no: false },
        properties: {
          allowed: { $ref: '#/$defs/yes' },
          forbidden: { $ref: '#/$defs/no' },
          annotation: {
            type: 'string',
            default: { pattern: privateText, $ref: 'https://example.invalid' },
          },
        },
      });
      expect(form.validate({ allowed: { nested: true } })).toEqual({
        allowed: { nested: true },
      });
      privateFailure(
        () => form.validate({ forbidden: null }),
        'MCP form failed validation',
      );
    });
  },
);

describe('extension schema refusal', () => {
  const mode = 'openai/form';
  const unsupported = 'Unsupported MCP extension form schema';

  it.each([
    { type: 'array' },
    { type: 'object', $schema: 'http://json-schema.org/draft-07/schema#' },
    { type: 'object', $id: 'https://example.invalid' },
    { type: 'object', $anchor: 'node' },
    { type: 'object', $vocabulary: {} },
    { type: 'object', unknown: privateText },
    { type: 'object', then: true },
    { type: 'object', else: true },
    { type: 'object', minContains: 1 },
    { type: 'object', maxContains: 1 },
    {
      type: 'object',
      properties: { value: { type: 'string', enumNames: ['Label'] } },
    },
    { type: 'object', $dynamicRef: '#node' },
    { type: 'object', pattern: privateText },
    {
      type: 'object',
      patternProperties: { [privateText]: { type: 'string' } },
    },
    { type: 'object', properties: { value: { type: privateText } } },
    {
      type: 'object',
      properties: { value: { $ref: 'https://example.invalid/private' } },
    },
    { type: 'object', properties: { value: { $ref: 'relative.json' } } },
    { type: 'object', properties: { value: { $ref: '#/$defs/missing' } } },
    {
      type: 'object',
      $defs: { a: { $ref: '#/$defs/b' }, b: { type: 'string' } },
      properties: { value: { $ref: '#/$defs/a' } },
    },
    {
      type: 'object',
      $defs: { a: { $ref: '#/$defs/a' } },
      properties: { value: { $ref: '#/$defs/a' } },
    },
  ])(
    'rejects unsupported schema %# without private details',
    async (schema) => {
      await privatePreparationFailure(
        () => prepareNativeForm(mode, schema),
        unsupported,
      );
    },
  );

  it('checks every schema position, including unused definitions', async () => {
    const bad = { type: 'string', pattern: privateText };
    const wrappers = [
      { $defs: { unused: bad } },
      { properties: { unused: bad } },
      { dependentSchemas: { unused: bad } },
      ...[
        'items',
        'contains',
        'additionalProperties',
        'unevaluatedProperties',
        'unevaluatedItems',
        'propertyNames',
        'not',
        'if',
        'then',
        'else',
      ].map((key) => ({ [key]: bad })),
      ...['allOf', 'anyOf', 'oneOf', 'prefixItems'].map((key) => ({
        [key]: [bad],
      })),
    ];
    for (const wrapper of wrappers)
      await privatePreparationFailure(
        () => prepareNativeForm(mode, { type: 'object', ...wrapper }),
        unsupported,
      );
    await privatePreparationFailure(
      () =>
        prepareNativeForm(mode, {
          type: 'object',
          $defs: { unused: { $schema: 'https://example.invalid/private' } },
        }),
      unsupported,
    );
  });

  it('refuses nested definition paths even when the target is an allowed boolean', async () => {
    for (const separator of ['/', '%2F', '%2f']) {
      for (const keyword of ['items', 'default']) {
        for (const value of [true, false]) {
          await privatePreparationFailure(
            () =>
              prepareNativeForm(mode, {
                type: 'object',
                $defs: { boolean: value, a: { [keyword]: value } },
                properties: {
                  unused: { $ref: `#/$defs/a${separator}${keyword}` },
                },
              }),
            unsupported,
          );
        }
      }
    }
  });
});

describe('extension form configuration isolation', () => {
  describe.each(['openai/form', 'openaiForm'] as const)('%s', (mode) => {
    it('validates unused definitions when another application disables schema checks', async () => {
      await withExternalValidatorSettings(
        { schema: false, format: false },
        async () => {
          const valid = await prepareNativeForm(mode, {
            type: 'object',
            properties: { value: { type: 'string' } },
          });
          expect(valid.validate({ value: 'ok' })).toEqual({ value: 'ok' });
          await privatePreparationFailure(
            () =>
              prepareNativeForm(mode, {
                type: 'object',
                $defs: { unused: { type: privateText } },
              }),
            'Unsupported MCP extension form schema',
          );
        },
      );
    });

    it.each(['email', 'unknown-application-format'])(
      'keeps %s as an annotation when another application enables format assertions',
      async (format) => {
        await withExternalValidatorSettings(
          { schema: true, format: true },
          async () => {
            const schema = {
              type: 'object',
              properties: {
                value: { allOf: [{ type: 'string', format }] },
                metadata: { const: { format: 'application data' } },
                choice: { enum: [{ format: 'choice data' }] },
              },
              required: ['value', 'metadata', 'choice'],
              default: { format: 'application data' },
              examples: [{ format: 'example data' }],
            };
            const form = await prepareNativeForm(mode, schema);
            const values = {
              value: 'an annotation',
              metadata: { format: 'application data' },
              choice: { format: 'choice data' },
            };
            expect(form.validate(values)).toEqual(values);
            expect(form.schema).toEqual(schema);
            expect(schema.default.format).toBe('application data');
            expect(schema.examples[0].format).toBe('example data');
          },
        );
      },
    );

    it('rejects malformed format keywords before removing annotations', async () => {
      await withExternalValidatorSettings(
        { schema: false, format: true },
        async () => {
          await privatePreparationFailure(
            () =>
              prepareNativeForm(mode, {
                type: 'object',
                $defs: { unused: { type: 'string', format: 7 } },
              }),
            'Unsupported MCP extension form schema',
          );
        },
      );
    });

    it.each([
      ['a/b', 'a~1b'],
      ['a b', 'a%20b'],
      ['a b', 'a b'],
    ])(
      'preserves the local target %s spelled %s under enabled URI format checks',
      async (name, token) => {
        await withExternalValidatorSettings(
          { schema: false, format: true },
          async () => {
            const schema = {
              type: 'object',
              $defs: { [name]: { type: 'string', minLength: 2 } },
              properties: { value: { $ref: `#/$defs/${token}` } },
              required: ['value'],
            };
            const form = await prepareNativeForm(mode, schema);
            expect(form.schema).toEqual(schema);
            expect(form.validate({ value: 'ok' })).toEqual({ value: 'ok' });
            privateFailure(
              () => form.validate({ value: 'x' }),
              'MCP form failed validation',
            );
          },
        );
      },
    );
  });
});

describe.each(['openai/form', 'openaiForm'] as const)(
  '%s registry isolation',
  (mode) => {
    it('keeps concurrent schemas distinct and releases only its own registrations', async () => {
      const before = getAllRegisteredSchemaUris().sort();
      const foreignId = 'urn:forms-test:application-schema';
      registerSchema(
        { type: 'string', const: 'application value' },
        foreignId,
        'https://json-schema.org/draft/2020-12/schema',
      );
      try {
        const registered = getAllRegisteredSchemaUris().sort();
        const [text, number] = await Promise.all([
          prepareNativeForm(mode, {
            type: 'object',
            properties: { value: { const: 'text' } },
          }),
          prepareNativeForm(mode, {
            type: 'object',
            properties: { value: { type: 'integer', minimum: 2 } },
          }),
          privatePreparationFailure(() =>
            prepareNativeForm(mode, {
              type: 'object',
              $defs: { unused: { type: 'invalid' } },
            }),
          ),
        ]);
        expect(text.validate({ value: 'text' })).toEqual({ value: 'text' });
        expect(number.validate({ value: 2 })).toEqual({ value: 2 });
        privateFailure(() => text.validate({ value: 2 }));
        privateFailure(() => number.validate({ value: 'text' }));
        expect(getAllRegisteredSchemaUris().sort()).toEqual(registered);
        const foreign = await compileSchema(foreignId);
        expect(foreign('application value').valid).toBe(true);
        expect(foreign('changed').valid).toBe(false);
      } finally {
        unregisterSchema(foreignId);
      }
      expect(getAllRegisteredSchemaUris().sort()).toEqual(before);
    });
  },
);

describe('form capture and JSON boundaries', () => {
  it.each(['form', 'openai/form', 'openaiForm'] as const)(
    'captures the %s schema before the first await',
    async (mode) => {
      const schema = {
        type: 'object',
        properties: { value: { type: 'string', minLength: 2 } },
      };
      const preparing = prepareNativeForm(mode, schema);
      schema.properties.value.minLength = 0;
      const form = await preparing;
      expect(form.schema).toEqual({
        type: 'object',
        properties: { value: { type: 'string', minLength: 2 } },
      });
      privateFailure(
        () => form.validate({ value: '' }),
        'MCP form failed validation',
      );
      expect(form.validate({ value: 'ok' })).toEqual({ value: 'ok' });
    },
  );

  it.each(['openai/form', 'openaiForm'] as const)(
    'resolves local %s definitions and refuses external references without fetch',
    async (mode) => {
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Unexpected external schema fetch'));
      try {
        const form = await prepareNativeForm(mode, {
          type: 'object',
          $defs: { entry: { type: 'string', minLength: 2 } },
          properties: { value: { $ref: '#/$defs/entry' } },
        });
        expect(form.validate({ value: 'ok' })).toEqual({ value: 'ok' });
        await privatePreparationFailure(
          () =>
            prepareNativeForm(mode, {
              type: 'object',
              properties: {
                value: { $ref: 'https://schema.invalid/entry' },
              },
            }),
          'Unsupported MCP extension form schema',
        );
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
      }
    },
  );

  it.each(['form', 'openai/form', 'openaiForm'] as const)(
    'counts Unicode characters rather than UTF-16 units for %s strings',
    async (mode) => {
      const form = await prepareNativeForm(mode, {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1, maxLength: 1 } },
      });
      expect(form.validate({ text: '😀' })).toEqual({ text: '😀' });
      privateFailure(() => form.validate({ text: '😀x' }));
    },
  );

  it('captures the input schema and returns a fresh detached schema on every read', async () => {
    const schema = structuredClone(nestedSchema);
    const form = await prepareNativeForm('openai/form', schema);
    schema.properties.count.minimum = 0;
    const view = form.schema as unknown as typeof nestedSchema;
    view.properties.count.minimum = 0;
    expect(form.schema).not.toBe(view);
    expect(form.schema).toEqual(nestedSchema);
    privateFailure(
      () => form.validate({ ...nestedValues, count: 0 }),
      'MCP form failed validation',
    );
  });

  it.each(['form', 'openai/form', 'openaiForm'] as const)(
    'detaches validated %s content',
    async (mode) => {
      const schema = {
        type: 'object',
        properties: {
          multiple: {
            type: 'array',
            items: { type: 'string', enum: ['a', 'b'] },
          },
        },
      };
      const values = { multiple: ['a'] };
      const form = await prepareNativeForm(mode, schema);
      const first = form.validate(values);
      values.multiple[0] = 'b';
      expect(first.multiple).toEqual(['a']);
      (first.multiple as string[])[0] = 'b';
      expect(form.validate({ multiple: ['a'] })).toEqual({ multiple: ['a'] });
    },
  );

  it('detaches nested extension content at every level', async () => {
    const values = structuredClone(nestedValues);
    const form = await prepareNativeForm('openai/form', nestedSchema);
    const content = form.validate(values);
    values.profile.name = 'changed';
    values.tags[0] = 'changed';
    expect(content).toEqual(nestedValues);
  });

  it('rejects values that JSON serialization would silently change or omit', async () => {
    class Foreign {
      value = privateText;
    }
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const sparse = new Array(2);
    sparse[1] = 'present';
    const form = await prepareNativeForm('openai/form', { type: 'object' });
    for (const value of [
      undefined,
      NaN,
      Infinity,
      -Infinity,
      1n,
      Symbol(privateText),
      () => privateText,
      new Date('2024-01-01'),
      new Map(),
      new Set(),
      new Foreign(),
      cycle,
      sparse,
      [undefined],
    ])
      privateFailure(
        () => form.validate({ value }),
        'MCP form failed validation',
      );
    for (const value of [new Foreign(), new Map(), new Date('2024-01-01')])
      privateFailure(() => form.validate(value));
    expect(
      form.validate({ value: [null, true, 1, 'ok', { nested: [] }] }),
    ).toEqual({ value: [null, true, 1, 'ok', { nested: [] }] });
  });

  it.each(['form', 'openai/form', 'openaiForm'] as const)(
    'rejects nonfinite %s numeric replies',
    async (mode) => {
      const form = await prepareNativeForm(mode, {
        type: 'object',
        properties: { value: { type: 'number' } },
      });
      for (const value of [NaN, Infinity, -Infinity])
        privateFailure(() => form.validate({ value }));
    },
  );
});
