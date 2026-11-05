import { expectTypeOf } from 'vitest';
import type { NativeProviderOptions } from '@openai/agents';
import { runGreeting } from '../../examples/basic';
import { runTypedContext, type Answer } from '../../examples/typed-context';

const endpoint: NativeProviderOptions = { baseUrl: 'http://127.0.0.1:1234/v1' };
expectTypeOf(runGreeting(endpoint)).toEqualTypeOf<Promise<string>>();
expectTypeOf(runTypedContext({ displayName: 'Ada' }, endpoint)).toEqualTypeOf<
  Promise<Answer>
>();
declare const answer: Awaited<ReturnType<typeof runTypedContext>>;
expectTypeOf(answer.greeting).toEqualTypeOf<string>();
// @ts-expect-error Application context is required by this example.
runTypedContext();
// @ts-expect-error Account display names must be strings.
runTypedContext({ displayName: 123 });
