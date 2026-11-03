import { expectTypeOf } from 'vitest';
import type {
  ActionReply,
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
expectTypeOf(session.submit(reply)).toEqualTypeOf<
  Promise<Turn<RootOutput> | Turn<string>>
>();
expectTypeOf(session.submit(output)).toEqualTypeOf<
  Promise<Turn<RootOutput> | Turn<string>>
>();
expectTypeOf(session.submit(either)).toEqualTypeOf<
  Promise<Turn<RootOutput> | Turn<string>>
>();

expectTypeOf(session.fork()).toEqualTypeOf<Promise<SessionState>>();
// @ts-expect-error fork captures only the latest settled root, without selectors.
session.fork({ turn: 1 });
