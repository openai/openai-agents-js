import { expectTypeOf } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  type EnvironmentLease,
  type EnvironmentSource,
  type RunOptions,
  type SessionOptions,
} from '../../src';

type Context = { tenant: string };
declare const environment: Environment<Context>;
declare const caller: AbortSignal;
declare const sourceOwner: AbortSignal;
const lease = Environment.lease(environment, async () => {}, sourceOwner);
expectTypeOf(lease).toEqualTypeOf<EnvironmentLease<Context>>();
expectTypeOf(lease.environment).toEqualTypeOf<Environment<Context>>();
expectTypeOf(lease.close()).toEqualTypeOf<Promise<void>>();
expectTypeOf(lease[Symbol.asyncDispose]()).toEqualTypeOf<PromiseLike<void>>();

const source: EnvironmentSource<Context> = async ({ signal }) => {
  expectTypeOf(signal).toEqualTypeOf<AbortSignal>();
  return Environment.lease(environment, () => {});
};
const options = {
  context: { tenant: 'one' },
  environment: source,
  signal: caller,
};
expectTypeOf(options).toExtend<SessionOptions<Context>>();
expectTypeOf(options).toExtend<RunOptions<Context>>();
declare const agent: Agent<Context>;
agent.session(options);
agent.run('Hello', options);
const output = agent.withOutputType(z.object({ answer: z.string() }));
const _outputResult = output.run('Hello', options);
expectTypeOf<Awaited<typeof _outputResult>['finalOutput']>().toEqualTypeOf<{
  answer: string;
}>();
output.session(options);
agent.session({ context: { tenant: 'one' }, environment, signal: caller });
// @ts-expect-error A source does not weaken required application context.
agent.session({ environment: source });
// @ts-expect-error Only Environment.lease can issue the opaque lease identity.
const foreign: EnvironmentLease<Context> = {
  environment,
  async close() {},
  async [Symbol.asyncDispose]() {},
};
void foreign;
// @ts-expect-error A concrete lease belongs in a source, not the borrowed Environment slot.
agent.session({ context: { tenant: 'one' }, environment: lease });
