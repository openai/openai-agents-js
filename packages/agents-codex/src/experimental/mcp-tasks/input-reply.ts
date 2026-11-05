import { isProxy } from 'node:util/types';
import type { ElicitResponse } from './protocol';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function invalidJson(): never {
  throw new Error('Expected plain finite JSON');
}

/** Capture data without invoking accessors, proxy traps or user serialization. */
export function captureJson(value: unknown): JsonValue {
  const active = new Set<object>();
  function copy(item: unknown): JsonValue {
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || isProxy(item)) return invalidJson();
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (
      prototype !== (array ? Array.prototype : Object.prototype) &&
      !(prototype === null && !array)
    )
      return invalidJson();
    if (active.has(item)) return invalidJson();
    active.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Object.getOwnPropertySymbols(item).length) return invalidJson();
      if (array) {
        const length = (item as unknown[]).length;
        if (
          Object.keys(descriptors).some(
            (key) =>
              key !== 'length' &&
              (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length),
          )
        )
          return invalidJson();
        const result: JsonValue[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !('value' in descriptor)) return invalidJson();
          result.push(copy(descriptor.value));
        }
        return result;
      }
      const result: { [key: string]: JsonValue } = {};
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || !('value' in descriptor))
          return invalidJson();
        Object.defineProperty(result, key, {
          value: copy(descriptor.value),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    } finally {
      active.delete(item);
    }
  }
  return copy(value);
}

function record(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Check decoded strings, escaped JSON contents and actual JS wire scalar spellings. */
export function containsToken(value: unknown, token: string): boolean {
  function check(item: JsonValue): boolean {
    if (item === null) return false;
    if (Array.isArray(item)) return item.some(check);
    if (record(item))
      return Object.entries(item).some(
        ([key, child]) => check(key) || check(child),
      );
    const encoded = JSON.stringify(item);
    return typeof item === 'string'
      ? item.includes(token) || encoded.slice(1, -1).includes(token)
      : encoded.includes(token);
  }
  return check(captureJson(value));
}

/** The Python adapter's flat form profile; never execute peer constraints. */
export function acceptsForm(schema: unknown, content: unknown): boolean {
  let form: JsonValue;
  let answers: JsonValue;
  try {
    form = captureJson(schema);
    answers = captureJson(content);
  } catch {
    return false;
  }
  if (!record(form) || !record(answers)) return false;
  const fields = form.properties;
  const required = Object.hasOwn(form, 'required') ? form.required : [];
  if (
    Object.keys(form).some(
      (key) =>
        ![
          '$schema',
          'type',
          'properties',
          'required',
          'additionalProperties',
        ].includes(key),
    ) ||
    form.type !== 'object' ||
    ('$schema' in form &&
      form.$schema !== 'https://json-schema.org/draft/2020-12/schema') ||
    ('additionalProperties' in form &&
      typeof form.additionalProperties !== 'boolean') ||
    !record(fields) ||
    !Array.isArray(required) ||
    required.some(
      (key) => typeof key !== 'string' || !Object.hasOwn(answers, key),
    ) ||
    Object.keys(answers).some((key) => !Object.hasOwn(fields, key))
  )
    return false;
  for (const [key, definition] of Object.entries(fields)) {
    if (
      !record(definition) ||
      Object.keys(definition).some(
        (name) =>
          ![
            'type',
            'enum',
            'items',
            'title',
            'description',
            'default',
          ].includes(name),
      )
    )
      return false;
    let field = definition;
    let kind = field.type;
    let values: JsonValue[] = Object.hasOwn(answers, key) ? [answers[key]] : [];
    if (kind === 'array') {
      const items = field.items;
      if (
        !record(items) ||
        Object.keys(items).some((name) => !['type', 'enum'].includes(name)) ||
        items.type !== 'string' ||
        'enum' in field ||
        (Object.hasOwn(answers, key) && !Array.isArray(answers[key]))
      )
        return false;
      field = items;
      kind = 'string';
      values = Object.hasOwn(answers, key) ? (answers[key] as JsonValue[]) : [];
    } else if ('items' in field) return false;
    if (
      typeof kind !== 'string' ||
      !['string', 'boolean', 'integer', 'number'].includes(kind)
    )
      return false;
    if (
      values.some((item) =>
        kind === 'integer'
          ? typeof item !== 'number' || !Number.isInteger(item)
          : typeof item !== (kind === 'number' ? 'number' : kind),
      )
    )
      return false;
    if ('enum' in field) {
      const choices = field.enum;
      if (
        kind !== 'string' ||
        !Array.isArray(choices) ||
        choices.some((choice) => typeof choice !== 'string')
      )
        return false;
      if (values.some((item) => !choices.includes(item))) return false;
    }
  }
  return true;
}

/** Host approval for an exact private challenge, never a model-visible value.
 * The target must still bind request keys immutably and reject retired keys.
 */
export class MCPInputReply {
  readonly #challenge: string;
  readonly #responses: JsonValue;

  constructor(options: {
    challenge: string;
    responses: Record<string, ElicitResponse>;
  }) {
    try {
      const captured = captureJson(options);
      if (
        !record(captured) ||
        typeof captured.challenge !== 'string' ||
        !record(captured.responses)
      )
        throw new Error();
      const responses: { [key: string]: JsonValue } = {};
      for (const [key, response] of Object.entries(captured.responses)) {
        if (
          !record(response) ||
          !['accept', 'decline', 'cancel'].includes(response.action as string)
        )
          throw new Error();
        if ('content' in response) {
          if (
            !record(response.content) ||
            Object.values(response.content).some(
              (item) =>
                typeof item !== 'string' &&
                typeof item !== 'number' &&
                typeof item !== 'boolean' &&
                !(
                  Array.isArray(item) &&
                  item.every((value) => typeof value === 'string')
                ),
            )
          )
            throw new Error();
        }
        // Match Python's approval snapshot: extra host metadata is never an
        // elicitation response and must not cross the tasks/update boundary.
        Object.defineProperty(responses, key, {
          value: {
            action: response.action,
            ...('content' in response ? { content: response.content } : {}),
          },
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      this.#challenge = captured.challenge;
      this.#responses = responses;
      Object.freeze(this);
      return;
    } catch {
      // Do not retain caller-owned values, callback errors or nested causes.
    }
    throw new Error('Invalid MCP input approval');
  }

  get challenge(): string {
    return this.#challenge;
  }

  get responses(): Record<string, ElicitResponse> {
    return captureJson(this.#responses) as unknown as Record<
      string,
      ElicitResponse
    >;
  }
}
