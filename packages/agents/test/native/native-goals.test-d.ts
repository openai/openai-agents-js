import { expectTypeOf } from 'vitest';
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
// @ts-expect-error No application goal mutation API is added.
session.setGoal('invented');
