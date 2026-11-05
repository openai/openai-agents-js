import { expectTypeOf } from 'vitest';
import {
  Agent,
  localStorage,
  type LocalStorage,
  type SessionOptions,
  type RunOptions,
} from '../../src';

interface ExtendedSession extends SessionOptions {
  application?: string;
}
interface ExtendedRun extends RunOptions {
  application?: string;
}
interface ContextOptions extends SessionOptions<{ tenant: string }> {
  application?: string;
}
expectTypeOf<ExtendedSession>().toExtend<SessionOptions>();
expectTypeOf<ExtendedRun>().toExtend<RunOptions>();
expectTypeOf<ContextOptions>().toExtend<SessionOptions<{ tenant: string }>>();
expectTypeOf(localStorage('/profile')).toEqualTypeOf<LocalStorage>();
expectTypeOf<'tools' | 'storage' | 'resume'>().not.toExtend<keyof RunOptions>();
declare const agent: Agent;
const legacy: SessionOptions = {};
agent.session(legacy);
agent.session({ storage: { path: '/structural' }, resume: 'native-id' });
// Optional interface fields retain compatibility; runtime validates this combination.
const invalidCombination: SessionOptions = { resume: 'without-profile' };
agent.session(invalidCombination);
declare const required: Agent<{ tenant: string }>;
const captured: SessionOptions<{ tenant: string }> & {
  context: { tenant: string };
} = {
  context: { tenant: 'one' },
  storage: localStorage('/profile'),
};
required.session(captured);
// @ts-expect-error The existing required-context call contract remains in force.
required.session({ storage: localStorage('/profile') });
// @ts-expect-error Local profiles belong to explicit Sessions.
agent.run('hello', { storage: localStorage('/profile') });
// @ts-expect-error A one-shot cannot select a local native resume.
agent.run('hello', { resume: 'id' });
const wider = { storage: localStorage('/profile'), returnState: false };
agent.run('hello', wider); // Runtime presence rejection covers structural aliases.
