import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { loadFormSchemas } from '../../node/decision-schema.js';
import emailAddresses from 'email-addresses';
import type { JsonObject, JsonValue } from './binding';

export type NativeFormMode = 'form' | 'openai/form' | 'openaiForm';

export interface PreparedNativeForm {
  readonly schema: Readonly<JsonObject>;
  validate(values: unknown): JsonObject;
}

const extensionDraft = 'https://json-schema.org/draft/2020-12/schema';
const annotations = [
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  'format',
];
const extensionKeywords = new Set([
  '$schema',
  '$defs',
  '$ref',
  ...annotations,
  'type',
  'enum',
  'const',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
  'minProperties',
  'maxProperties',
  'dependentRequired',
  'dependentSchemas',
  'unevaluatedProperties',
  'items',
  'prefixItems',
  'contains',
  'minItems',
  'maxItems',
  'uniqueItems',
  'unevaluatedItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
]);
const standardRootKeywords = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'title',
  'description',
]);
const standardPropertyKeywords = new Set([
  'type',
  'title',
  'description',
  'default',
  'enum',
  'enumNames',
  'oneOf',
  'items',
  'minItems',
  'maxItems',
  'format',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
]);

function object(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Copy data properties only. JSON.stringify would erase unsupported values or
// invoke application getters before validation has established JSON content.
function copyJson(value: unknown, parents = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null || parents.has(value))
    throw new TypeError();
  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!array && prototype !== Object.prototype && prototype !== null)
    throw new TypeError();
  if (array && prototype !== Array.prototype) throw new TypeError();
  parents.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length) throw new TypeError();
    if (array) {
      const length = (value as unknown[]).length;
      if (Object.keys(descriptors).length !== length + 1) throw new TypeError();
      const result: JsonValue[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !('value' in descriptor))
          throw new TypeError();
        result.push(copyJson(descriptor.value, parents));
      }
      return result;
    }
    const result: JsonObject = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !('value' in descriptor))
        throw new TypeError();
      Object.defineProperty(result, key, {
        value: copyJson(descriptor.value, parents),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    parents.delete(value);
  }
}

function onlyKeys(value: JsonObject, allowed: ReadonlySet<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new TypeError();
}

function schemaNodes(schema: JsonValue): JsonValue[] {
  const nodes = [schema];
  if (!object(schema)) return nodes;
  for (const key of ['$defs', 'properties', 'dependentSchemas']) {
    const children = schema[key];
    if (children !== undefined) {
      if (!object(children)) throw new TypeError();
      for (const child of Object.values(children))
        nodes.push(...schemaNodes(child));
    }
  }
  for (const key of [
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
  ]) {
    if (schema[key] !== undefined) nodes.push(...schemaNodes(schema[key]));
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    const children = schema[key];
    if (children !== undefined) {
      if (!Array.isArray(children)) throw new TypeError();
      for (const child of children) nodes.push(...schemaNodes(child));
    }
  }
  return nodes;
}

type Decimal = readonly [coefficient: bigint, exponent: number];

function decimal(value: number): Decimal {
  const [significand, exponent = '0'] = value.toString().split('e');
  const [whole, fraction = ''] = significand.split('.');
  return [BigInt(whole + fraction), Number(exponent) - fraction.length];
}

// These handlers and their vocabulary live for the module's lifetime. Each
// preparation separately owns and removes its schema and dialect registrations.
const keywordNamespace = `https://openai.invalid/agents/forms/${randomUUID()}`;
const validationVocabulary = `${keywordNamespace}/validation`;
const formKeywordIds: Readonly<Record<string, string>> = {
  const: `${keywordNamespace}/const`,
  enum: `${keywordNamespace}/enum`,
  multipleOf: `${keywordNamespace}/multipleOf`,
};

function comparableJson(value: JsonValue): JsonValue {
  // JSON number equality treats negative zero as zero, including nested values.
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

let formSchemas: Awaited<ReturnType<typeof loadFormSchemas>>;
let formInitialization: Promise<void> | undefined;

function initializeFormSchemas(): Promise<void> {
  return (formInitialization ??= (async () => {
    formSchemas = await loadFormSchemas();
    formSchemas.addKeyword<JsonValue>({
      id: formKeywordIds.const,
      compile: async (schema) =>
        JSON.parse(formSchemas.schemaValue(schema) as string) as JsonValue,
      interpret: (expected, instance) =>
        isDeepStrictEqual(
          expected,
          comparableJson(formSchemas.instanceValue<JsonValue>(instance)),
        ),
    });
    formSchemas.addKeyword<JsonValue[]>({
      id: formKeywordIds.enum,
      compile: async (schema) =>
        (formSchemas.schemaValue(schema) as string[]).map(
          (value) => JSON.parse(value) as JsonValue,
        ),
      interpret: (expected, instance) => {
        const actual = comparableJson(
          formSchemas.instanceValue<JsonValue>(instance),
        );
        return expected.some((value) => isDeepStrictEqual(value, actual));
      },
    });
    formSchemas.addKeyword<Decimal>({
      id: formKeywordIds.multipleOf,
      compile: async (schema) =>
        decimal(formSchemas.schemaValue(schema) as number),
      interpret: ([divisor, divisorExponent], instance) => {
        const value = formSchemas.instanceValue<JsonValue>(instance);
        if (typeof value !== 'number') return true;
        const [coefficient, exponent] = decimal(value);
        const difference = exponent - divisorExponent;
        return difference >= 0
          ? (coefficient * 10n ** BigInt(difference)) % divisor === 0n
          : coefficient % (divisor * 10n ** BigInt(-difference)) === 0n;
      },
    });
    formSchemas.defineVocabulary(
      validationVocabulary,
      Object.fromEntries(
        [
          'const',
          'dependentRequired',
          'enum',
          'exclusiveMaximum',
          'exclusiveMinimum',
          'maxContains',
          'maxItems',
          'maxLength',
          'maxProperties',
          'maximum',
          'minContains',
          'minItems',
          'minLength',
          'minProperties',
          'minimum',
          'multipleOf',
          'pattern',
          'required',
          'type',
          'uniqueItems',
        ].map((name) => [
          name,
          formKeywordIds[name] ??
            formSchemas.getKeywordId(name, extensionDraft),
        ]),
      ),
    );
  })());
}

async function extensionValidator(
  schema: JsonObject,
): Promise<(value: JsonObject) => boolean> {
  const nodes = schemaNodes(schema);
  for (const node of nodes) {
    if (typeof node === 'boolean') continue;
    if (!object(node)) throw new TypeError();
    onlyKeys(node, extensionKeywords);
    if (node.$schema !== undefined && node.$schema !== extensionDraft)
      throw new TypeError();
  }
  for (const node of nodes) {
    if (!object(node) || node.$ref === undefined) continue;
    const reference = node.$ref;
    if (typeof reference !== 'string' || !reference.startsWith('#/$defs/'))
      throw new TypeError();
    const segment = decodeURIComponent(reference.slice('#/$defs/'.length));
    if (segment.includes('/') || /~(?![01])/.test(segment))
      throw new TypeError();
    const name = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    const definitions = schema.$defs;
    if (!object(definitions) || !Object.hasOwn(definitions, name))
      throw new TypeError();
    if (
      schemaNodes(definitions[name]).some(
        (child) => object(child) && '$ref' in child,
      )
    )
      throw new TypeError();
  }
  const compiledSchema = copyJson(schema) as JsonObject;
  const definitionAliases = new Map<string, string>();
  if (object(compiledSchema.$defs)) {
    const definitions: JsonObject = {};
    for (const [name, definition] of Object.entries(compiledSchema.$defs)) {
      const alias = `definition${definitionAliases.size}`;
      definitionAliases.set(name, alias);
      definitions[alias] = definition;
    }
    compiledSchema.$defs = definitions;
  }
  const compiledNodes = schemaNodes(compiledSchema);
  // Local aliases keep admitted definition names out of the dependency's URI
  // parser. Public schema names and reference spelling remain unchanged.
  for (const node of compiledNodes) {
    if (object(node) && typeof node.$ref === 'string') {
      const name = decodeURIComponent(node.$ref.slice('#/$defs/'.length))
        .replace(/~1/g, '/')
        .replace(/~0/g, '~');
      const alias = definitionAliases.get(name);
      if (alias === undefined) throw new TypeError();
      node.$ref = `#/$defs/${alias}`;
    }
  }
  // Validate explicitly: an application may disable the library's automatic
  // schema checks. Validate all constraints before adapting the compiler copy.
  const validateSchema = await formSchemas.compileSchema(extensionDraft);
  if (!validateSchema(compiledSchema, 'FLAG').valid) throw new TypeError();
  for (const node of compiledNodes) {
    if (!object(node)) continue;
    for (const key of annotations) delete node[key];
    // Literal data must not enter the dependency's schema/resource traversal.
    if (Object.hasOwn(node, 'const')) node.const = JSON.stringify(node.const);
    if (Array.isArray(node.enum))
      node.enum = node.enum.map((value) => JSON.stringify(value));
  }
  const id = `urn:uuid:${randomUUID()}`;
  const dialect = `urn:uuid:${randomUUID()}`;
  try {
    formSchemas.registerSchema(
      {
        $id: dialect,
        $schema: extensionDraft,
        $dynamicAnchor: 'meta',
        $vocabulary: {
          'https://json-schema.org/draft/2020-12/vocab/core': true,
          'https://json-schema.org/draft/2020-12/vocab/applicator': true,
          'https://json-schema.org/draft/2020-12/vocab/unevaluated': true,
          'https://json-schema.org/draft/2020-12/vocab/meta-data': true,
          'https://json-schema.org/draft/2020-12/vocab/format-annotation': true,
          'https://json-schema.org/draft/2020-12/vocab/content': true,
          [validationVocabulary]: true,
        },
        allOf: [{ $ref: extensionDraft }],
      },
      dialect,
      extensionDraft,
    );
    compiledSchema.$schema = dialect;
    formSchemas.registerSchema(compiledSchema, id, dialect);
    const validator = await formSchemas.compileSchema(id);
    return (value) => validator(value, 'FLAG').valid;
  } finally {
    formSchemas.unregisterSchema(id);
    formSchemas.unregisterSchema(dialect);
  }
}

function stringChoices(
  value: JsonValue | undefined,
  titled: boolean,
): string[] {
  if (!Array.isArray(value) || !value.length) throw new TypeError();
  return value.map((choice) => {
    if (!titled) {
      if (typeof choice !== 'string') throw new TypeError();
      return choice;
    }
    if (!object(choice)) throw new TypeError();
    onlyKeys(choice, new Set(['const', 'title']));
    if (
      typeof choice.const !== 'string' ||
      (choice.title !== undefined && typeof choice.title !== 'string')
    )
      throw new TypeError();
    return choice.const;
  });
}

function integerBound(value: JsonValue | undefined): void {
  if (
    value !== undefined &&
    (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
  )
    throw new TypeError();
}

// Choose by represented constraints, never by whether a primitive answer passes.
function primitiveForm(schema: JsonObject): boolean {
  if (
    Object.keys(schema).some((key) => !standardRootKeywords.has(key)) ||
    !object(schema.properties) ||
    (schema.additionalProperties !== undefined &&
      typeof schema.additionalProperties !== 'boolean')
  )
    return false;
  const common = ['type', 'title', 'description', 'default', 'enum'];
  const keywords: Record<string, readonly string[]> = {
    string: ['format', 'minLength', 'maxLength', 'enumNames', 'oneOf'],
    boolean: [],
    integer: ['minimum', 'maximum'],
    number: ['minimum', 'maximum'],
    array: ['items', 'minItems', 'maxItems'],
  };
  const titledChoices = (value: JsonValue): boolean =>
    Array.isArray(value) &&
    value.every(
      (choice) =>
        object(choice) &&
        typeof choice.const === 'string' &&
        Object.keys(choice).every((key) => key === 'const' || key === 'title'),
    ) &&
    new Set(value.map((choice) => (choice as JsonObject).const)).size ===
      value.length;
  return Object.values(schema.properties).every((property) => {
    if (!object(property) || typeof property.type !== 'string') return false;
    const represented = Object.hasOwn(keywords, property.type)
      ? keywords[property.type]
      : undefined;
    if (
      !represented ||
      Object.keys(property).some(
        (key) => !common.includes(key) && !represented.includes(key),
      )
    )
      return false;
    if (
      Array.isArray(property.enum) &&
      property.enum.some(
        (choice) => choice !== null && typeof choice === 'object',
      )
    )
      return false;
    if (property.oneOf !== undefined && !titledChoices(property.oneOf))
      return false;
    if (property.type !== 'array') return true;
    const items = property.items;
    return (
      object(items) &&
      Object.keys(items).every((key) =>
        ['type', 'enum', 'anyOf'].includes(key),
      ) &&
      (items.type === undefined || items.type === 'string') &&
      (items.enum !== undefined || items.anyOf !== undefined) &&
      (items.enum === undefined ||
        (Array.isArray(items.enum) &&
          items.enum.every((choice) => typeof choice === 'string'))) &&
      (items.anyOf === undefined || titledChoices(items.anyOf))
    );
  });
}

function standardValidator(schema: JsonObject): (value: JsonObject) => boolean {
  onlyKeys(schema, standardRootKeywords);
  const properties = schema.properties;
  if (!object(properties)) throw new TypeError();
  const required = schema.required ?? [];
  if (
    !Array.isArray(required) ||
    required.some(
      (key) => typeof key !== 'string' || !Object.hasOwn(properties, key),
    )
  )
    throw new TypeError();
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== 'boolean'
  )
    throw new TypeError();
  const checks = new Map<string, (value: JsonValue) => boolean>();
  for (const [name, property] of Object.entries(properties)) {
    if (!object(property)) throw new TypeError();
    onlyKeys(property, standardPropertyKeywords);
    for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems'])
      integerBound(property[key]);
    for (const key of ['minimum', 'maximum'])
      if (property[key] !== undefined && typeof property[key] !== 'number')
        throw new TypeError();
    if (
      property.format !== undefined &&
      !['email', 'uri', 'date', 'date-time'].includes(property.format as string)
    )
      throw new TypeError();
    const offered = property.enum;
    if (
      offered !== undefined &&
      (!Array.isArray(offered) ||
        !offered.length ||
        offered.some((choice) => choice !== null && typeof choice === 'object'))
    )
      throw new TypeError();
    let choices: string[] | undefined;
    if (property.oneOf !== undefined) {
      const titled = stringChoices(property.oneOf, true);
      choices =
        choices === undefined
          ? titled
          : choices.filter((choice) => titled.includes(choice));
    }
    if (property.type === 'array') {
      if (!object(property.items)) throw new TypeError();
      onlyKeys(property.items, new Set(['type', 'enum', 'anyOf']));
      if (property.items.type !== undefined && property.items.type !== 'string')
        throw new TypeError();
      const items = property.items;
      if (items.enum === undefined && items.anyOf === undefined)
        throw new TypeError();
      choices =
        items.enum === undefined ? undefined : stringChoices(items.enum, false);
      if (items.anyOf !== undefined) {
        const titled = stringChoices(items.anyOf, true);
        choices =
          choices === undefined
            ? titled
            : choices.filter((choice) => titled.includes(choice));
      }
    } else if (
      !['string', 'boolean', 'integer', 'number'].includes(
        property.type as string,
      )
    )
      throw new TypeError();
    checks.set(name, (value) => {
      if (Array.isArray(offered) && !offered.some((choice) => choice === value))
        return false;
      switch (property.type) {
        case 'string': {
          if (typeof value !== 'string') return false;
          const length = Array.from(value).length;
          if (!within(length, property.minLength, property.maxLength))
            return false;
          if (choices !== undefined && !choices.includes(value)) return false;
          return validFormat(property.format, value);
        }
        case 'boolean':
          return typeof value === 'boolean';
        case 'integer':
        case 'number':
          return (
            typeof value === 'number' &&
            (property.type !== 'integer' || Number.isInteger(value)) &&
            within(value, property.minimum, property.maximum)
          );
        case 'array':
          return (
            Array.isArray(value) &&
            within(value.length, property.minItems, property.maxItems) &&
            value.every(
              (item) => typeof item === 'string' && choices!.includes(item),
            )
          );
        default:
          return false;
      }
    });
  }
  return (value) =>
    required.every((key) => Object.hasOwn(value, key as string)) &&
    Object.entries(value).every(([name, item]) =>
      checks.has(name)
        ? checks.get(name)!(item)
        : schema.additionalProperties === true,
    );
}

function within(
  value: number,
  minimum: JsonValue | undefined,
  maximum: JsonValue | undefined,
): boolean {
  return (
    (minimum === undefined || value >= (minimum as number)) &&
    (maximum === undefined || value <= (maximum as number))
  );
}

// The parser omits folding whitespace from semantic local parts. Whitespace
// inside a quoted string still counts as a nonempty Python Address username.
function quotedWhitespace(node: emailAddresses.ASTNode): boolean {
  if (node.name === 'quoted-string') {
    const children = node.children[0]?.children ?? [];
    const firstQuote = children.findIndex((child) => child.name === 'dquote');
    const lastQuote = children.findLastIndex(
      (child) => child.name === 'dquote',
    );
    if (
      firstQuote >= 0 &&
      lastQuote > firstQuote &&
      children
        .slice(firstQuote + 1, lastQuote)
        .some((child) => child.tokens.length > 0)
    )
      return true;
  }
  return node.children.some(quotedWhitespace);
}

function validEmail(value: string): boolean {
  if (value.includes('\r') || value.includes('\n')) return false;
  const parsed = emailAddresses.parseOneAddress({
    input: value,
    rfc6532: true,
    simple: false,
    partial: false,
    strict: true,
  });
  if (
    parsed?.type !== 'mailbox' ||
    parsed.node?.children[0]?.name !== 'addr-spec' ||
    !parsed.domain
  )
    return false;
  if (
    Array.from(parsed.local).some(
      (character) => character.codePointAt(0)! > 127,
    )
  )
    return false;
  return parsed.local.length > 0 || quotedWhitespace(parsed.parts.local);
}

function validUri(value: string): boolean {
  // Require ASCII URI input, including rejection of final line terminators.
  if (/[^\x21-\x7e]/.test(value)) return false;
  try {
    formSchemas.parseUri(value);
    return true;
  } catch {
    // Parser errors contain the submitted value; expose only our fixed error.
    return false;
  }
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
  );
}

function validFormat(format: JsonValue | undefined, value: string): boolean {
  if (format === undefined) return true;
  if (format === 'email') return validEmail(value);
  if (format === 'uri') return validUri(value);
  if (format === 'date') return validDate(value);
  if (format === 'date-time') {
    const match =
      /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(
        value,
      );
    return (
      match !== null &&
      validDate(match[1]) &&
      Number(match[2]) < 24 &&
      Number(match[3]) < 60 &&
      Number(match[4]) < 60 &&
      (match[5] === undefined ||
        (Number(match[6]) < 24 && Number(match[7]) < 60))
    );
  }
  return false;
}

export async function prepareNativeForm(
  mode: NativeFormMode,
  schema: unknown,
): Promise<PreparedNativeForm> {
  let captured: JsonObject;
  let accepts: (value: JsonObject) => boolean;
  try {
    const copied = copyJson(schema);
    if (!object(copied) || copied.type !== 'object') throw new TypeError();
    captured = copied;
    await initializeFormSchemas();
    accepts =
      mode === 'form' && primitiveForm(captured)
        ? standardValidator(captured)
        : await extensionValidator(captured);
  } catch {
    throw new TypeError(
      mode === 'form'
        ? 'Unsupported MCP form schema'
        : 'Unsupported MCP extension form schema',
    );
  }
  return Object.freeze({
    get schema(): Readonly<JsonObject> {
      return copyJson(captured) as JsonObject;
    },
    validate(values: unknown): JsonObject {
      try {
        const content = copyJson(values);
        if (object(content) && accepts(content)) return content;
      } catch {
        // Validation details and application data must not escape this boundary.
      }
      throw new TypeError('MCP form failed validation');
    },
  });
}
