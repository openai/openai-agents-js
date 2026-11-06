import { expectTypeOf } from 'vitest';
import type { Session as ConvenienceSession } from '@openai/agents';
import {
  Agent,
  nativeGoals,
  type NativeGoals,
  type NativeGoal,
  type Tool,
  type Session,
} from '../../src';
expectTypeOf(nativeGoals()).toEqualTypeOf<NativeGoals>();
expectTypeOf<NativeGoals>().toExtend<Tool>();
expectTypeOf<ReturnType<Session['goal']>>().toEqualTypeOf<
  Promise<Readonly<NativeGoal> | null>
>();
expectTypeOf<NativeGoal['tokensUsed']>().toEqualTypeOf<number | bigint>();
const agent = new Agent({
  instructions: 'Manage the goal.',
  tools: [nativeGoals()],
});
agent.session({ storage: { path: '/current/profile' } });
declare const session: Session;
expectTypeOf<Session['setPausedGoal']>().toEqualTypeOf<
  (
    objective: string,
    options?: { readonly tokenBudget?: number | bigint },
  ) => Promise<Readonly<NativeGoal>>
>();
expectTypeOf<ConvenienceSession['setPausedGoal']>().toEqualTypeOf<
  Session['setPausedGoal']
>();
expectTypeOf(
  session.setPausedGoal('Prepare the release notes', { tokenBudget: 4000n }),
).toEqualTypeOf<Promise<Readonly<NativeGoal>>>();
