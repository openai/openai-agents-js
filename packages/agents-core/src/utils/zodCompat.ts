import type { ZodObject as ZodObjectV3, ZodTypeAny } from 'zod';
import type { ZodObject as ZodObjectV4, ZodType as ZodTypeV4 } from 'zod/v4';

type ZodDefinition = Record<string, unknown> | undefined;
type ZodLike = {
  _def?: Record<string, unknown>;
  def?: Record<string, unknown>;
  _zod?: { def?: Record<string, unknown> };
  shape?: Record<string, unknown> | (() => Record<string, unknown>);
};

type ZodTypeV4Any = ZodTypeV4<any, any, any>;

export type ZodTypeLike = ZodTypeAny | ZodTypeV4Any;
export type ZodObjectLike =
  | ZodObjectV3<any, any, any, any, any>
  | ZodObjectV4<any, any>;

export function asZodType(schema: ZodTypeLike): ZodTypeAny {
  return schema as unknown as ZodTypeAny;
}

export function readZodDefinition(input: unknown): ZodDefinition {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }

  const candidate = input as ZodLike;
  return candidate._zod?.def || candidate._def || candidate.def;
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
