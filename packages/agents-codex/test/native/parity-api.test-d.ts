import { expectTypeOf } from 'vitest';
import type {
  ActionReply,
  NativeAgentsOptions,
  NativeRoleOptions,
  SessionUpdate,
  SessionInterruptOptions,
  FunctionCallOutput,
  Session,
  SessionState,
  Turn,
  UserInput,
} from '@openai/agents';

type RootOutput = { answer: string };
declare const session: Session<RootOutput>;
declare const input: UserInput;
declare const reply: ActionReply;
declare const output: FunctionCallOutput;
declare const either: UserInput | ActionReply;

expectTypeOf(session.submit(input)).toEqualTypeOf<Promise<Turn<RootOutput>>>();
expectTypeOf(session.respond(reply)).toEqualTypeOf<Promise<void>>();
expectTypeOf(session.respond(output)).toEqualTypeOf<Promise<void>>();
// @ts-expect-error User input and bound replies require different operations.
session.respond(either);

expectTypeOf(session.fork()).toEqualTypeOf<Promise<SessionState>>();
// @ts-expect-error fork captures only the latest settled root, without selectors.
session.fork({ turn: 1 });

// Named options are available from the owner and the convenience root.
expectTypeOf<NativeAgentsOptions<{ account: string }>>().toEqualTypeOf<
  import('@openai/agents-codex').NativeAgentsOptions<{ account: string }>
>();
expectTypeOf<NativeRoleOptions>().toEqualTypeOf<
  import('@openai/agents-codex').NativeRoleOptions
>();
expectTypeOf<SessionUpdate<unknown>>().toEqualTypeOf<
  import('@openai/agents-codex').SessionUpdate<unknown>
>();
expectTypeOf<SessionInterruptOptions>().toEqualTypeOf<
  import('@openai/agents-codex').SessionInterruptOptions
>();
const update: SessionUpdate<unknown> = { instructions: 'Continue carefully.' };
const interrupt: SessionInterruptOptions = { scope: 'all', mode: 'graceful' };
session.update(update);
session.interrupt(interrupt);
