import type { ZodObject, ZodType } from 'zod';

type ZodDefinition = Record<string, unknown> | undefined;
type ZodLike = {
  _def?: Record<string, unknown>;
  def?: Record<string, unknown>;
  _zod?: { def?: Record<string, unknown> };
  shape?: Record<string, unknown> | (() => Record<string, unknown>);
};

type ZodTypeAny = ZodType<any, any, any>;

export type ZodTypeLike = ZodTypeAny;
export type ZodObjectLike = ZodObject<any, any>;

export function asZodType(schema: ZodTypeLike): ZodTypeLike {
  return schema;
}

export function readZodDefinition(input: unknown): ZodDefinition {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }

  const candidate = input as ZodLike;
  return candidate._zod?.def || candidate._def || candidate.def;
}

export function readZodDescription(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null) {
    const direct = (value as { description?: unknown }).description;
    if (typeof direct === 'string' && direct.trim()) {
      return direct;
    }
  }

  let current = value;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const def = readZodDefinition(current);
    if (typeof def?.description === 'string' && def.description.trim()) {
      return def.description;
    }
    const next =
      def?.innerType ??
      def?.schema ??
      def?.base ??
      def?.type ??
      def?.wrapped ??
      def?.underlying;
    if (!next || next === current) {
      break;
    }
    current = next;
  }
  return undefined;
}

export function readZodType(input: unknown): string | undefined {
  const def = readZodDefinition(input);
  if (!def) {
    return undefined;
  }

  const rawType =
    (typeof def.typeName === 'string' && def.typeName) ||
    (typeof def.type === 'string' && def.type);

  if (typeof rawType !== 'string') {
    return undefined;
  }

  const lower = rawType.toLowerCase();
  return lower.startsWith('zod') ? lower.slice(3) : lower;
}

export type ZodInfer<T extends ZodTypeLike> = T extends {
  _output: infer Output;
}
  ? Output
  : never;
