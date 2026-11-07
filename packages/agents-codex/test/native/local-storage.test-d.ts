import { expectTypeOf } from 'vitest';
import {
  Agent,
  localStorage,
  type LocalStorage,
  type SessionOptions,
  type SessionBaseOptions,
  type SessionState,
  type SessionStore,
  type ReconciledCall,
  type RunOptions,
} from '../../src';

type ExtendedSession = SessionOptions & {
  application?: string;
};
interface ExtendedRun extends RunOptions {
  application?: string;
}
type ContextOptions = SessionOptions<{ tenant: string }> & {
  application?: string;
};
interface ExtendedBase extends SessionBaseOptions {
  application?: string;
}
expectTypeOf<ExtendedBase>().toExtend<SessionBaseOptions>();
expectTypeOf<ExtendedSession>().toExtend<SessionOptions>();
expectTypeOf<ExtendedRun>().toExtend<RunOptions>();
expectTypeOf<ContextOptions>().toExtend<SessionOptions<{ tenant: string }>>();
expectTypeOf(localStorage('/profile')).toEqualTypeOf<LocalStorage>();
expectTypeOf<'tools' | 'storage' | 'resume'>().not.toExtend<keyof RunOptions>();
declare const agent: Agent;
const legacy: SessionOptions = {};
agent.session(legacy);
agent.session({ storage: { path: '/structural' }, resume: 'native-id' });
// @ts-expect-error Resume requires the selected persistence owner.
const invalidCombination: SessionOptions = { resume: 'without-profile' };
agent.session(invalidCombination);
declare const state: SessionState;
declare const store: SessionStore;
declare const receipts: readonly ReconciledCall[];
agent.session({ state });
agent.session({ storage: store, resume: 'native-id' });
agent.session({
  storage: localStorage('/profile'),
  resume: 'native-id',
  reconciledCalls: receipts,
});
agent.session({
  storage: localStorage('/profile'),
  resume: 'native-id',
  reconciledCalls: [
    {
      threadId: 'thread',
      turnId: 'turn',
      callId: 'call',
      outcome: 'applied',
      result: 'verified',
    },
  ],
});
// @ts-expect-error A portable checkpoint cannot select persistent storage.
agent.session({ state, storage: store });
// @ts-expect-error Local recovery requires resume.
agent.session({ storage: localStorage('/profile'), reconciledCalls: receipts });
agent.session({
  storage: store,
  resume: 'native-id',
  // @ts-expect-error Custom-store reconciliation uses its explicit result API.
  reconciledCalls: receipts,
});
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
