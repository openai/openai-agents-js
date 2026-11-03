import { expectTypeOf } from 'vitest';
import {
  Agent,
  type RunOptions,
  type SessionOptions,
  type Tool,
} from '../../src';

expectTypeOf<SessionOptions['tools']>().toEqualTypeOf<
  readonly Tool<undefined>[] | undefined
>();
expectTypeOf<'tools'>().not.toExtend<keyof RunOptions>();

declare const agent: Agent;
declare const tools: readonly Tool<undefined>[];
agent.session({ tools });
// @ts-expect-error Opening declarations do not select tools for a one-shot run.
agent.run('Hello', { tools });
