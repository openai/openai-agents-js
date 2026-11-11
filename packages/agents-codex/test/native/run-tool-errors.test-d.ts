import { expectTypeOf } from 'vitest';
import {
  tool,
  type RunOptions,
  type SessionBaseOptions,
  type ToolCallInfo,
  type ToolErrorContext,
  type ToolErrorFormatter,
} from '../../src';
import { z } from 'zod';

type Application = { label: string };
const _formatter: ToolErrorFormatter<Application> = (context) => {
  expectTypeOf(context.context).toEqualTypeOf<Application>();
  expectTypeOf(context.call).toEqualTypeOf<ToolCallInfo>();
  expectTypeOf(context.signal).toEqualTypeOf<AbortSignal>();
  expectTypeOf(context.phase).toEqualTypeOf<'arguments' | 'execution'>();
  expectTypeOf(context.error).toEqualTypeOf<unknown>();
  return context.defaultMessage;
};
expectTypeOf<
  SessionBaseOptions<Application>['toolErrorFormatter']
>().toEqualTypeOf<ToolErrorFormatter<Application> | undefined>();
expectTypeOf<RunOptions<Application>['toolErrorFormatter']>().toEqualTypeOf<
  ToolErrorFormatter<Application> | undefined
>();
expectTypeOf<Parameters<typeof _formatter>[0]>().toEqualTypeOf<
  ToolErrorContext<Application>
>();
tool({
  name: 'suppressed',
  parameters: z.object({}),
  execute: () => '',
  errorFunction: null,
});
// @ts-expect-error The per-tool suppression marker is not a Session formatter.
const invalid: SessionBaseOptions = { toolErrorFormatter: null };
void invalid;
