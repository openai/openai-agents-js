import { expectTypeOf } from 'vitest';
import {
  Agent,
  Runner,
  NativeProvider,
  type RunOptions,
  type SessionOptions,
} from '../../src';

declare const agent: Agent<{ tenant: string }>;
declare const provider: NativeProvider;
const options = {
  context: { tenant: 'one' },
  provider,
  model: 'opening-model',
  modelSettings: { reasoningEffort: 'low', serviceTier: null },
};
expectTypeOf(options).toExtend<SessionOptions<{ tenant: string }>>();
expectTypeOf(options).toExtend<RunOptions<{ tenant: string }>>();
agent.session(options);
agent.run('Hello.', options);
Runner.run(agent, 'Hello.', options);
// @ts-expect-error Opening overrides preserve the required-context contract.
agent.session({ provider, model: 'opening-model' });
agent.session({
  context: { tenant: 'one' },
  // @ts-expect-error Only serviceTier supports an explicit null setting.
  modelSettings: { reasoningEffort: null },
});
