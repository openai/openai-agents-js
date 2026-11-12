import { Agent, run } from '../src';
import { expectTypeOf } from 'vitest';
import { z } from 'zod';
import type * as AgentsCore from '../src/index';
import type {
  AgentHookEvents,
  AgentTool,
  AgentToolOptions,
  AgentToolOptionsWithDefault,
  AgentToolOptionsWithParameters,
  RunHookEvents,
  SessionHistoryTransactionArgs,
  SessionHistoryTransactionAwareSession,
  ToolNameCollisionPolicy,
} from '../src/index';
import type { SerializedTool } from '../src/model';
import type { SandboxClient, SandboxSession } from '../src/sandbox';
import type { ScriptedSandboxCallFor } from '../src/testing';

const _parameters = z.object({ query: z.string() });
type TestAgent = AgentsCore.Agent<undefined>;
type PublicTypes = [
  AgentHookEvents<undefined>,
  RunHookEvents<undefined>,
  AgentToolOptions<undefined, TestAgent, typeof _parameters>,
  AgentToolOptionsWithDefault<undefined, TestAgent>,
  AgentToolOptionsWithParameters<undefined, TestAgent, typeof _parameters>,
  AgentTool<undefined, TestAgent, typeof _parameters>,
  SessionHistoryTransactionArgs,
  SessionHistoryTransactionAwareSession,
  ToolNameCollisionPolicy,
];

expectTypeOf<PublicTypes>().not.toBeNever();

const tool: SerializedTool = {
  type: 'function',
  name: 'test',
  description: 'test',
  parameters: {
    type: 'object',
    properties: {
      foo: { type: 'string' },
      bar: { type: 'number' },
    },
    required: ['foo'],
    additionalProperties: false,
  },
  strict: false,
};
void tool;

expectTypeOf<
  ReturnType<NonNullable<SandboxClient['canReusePreservedOwnedSession']>>
>().toEqualTypeOf<boolean | Promise<boolean>>();

type ExecCall = ScriptedSandboxCallFor<'execCommand'>;
expectTypeOf<ExecCall['args'][0]>().toEqualTypeOf<
  Parameters<NonNullable<SandboxSession['execCommand']>>[0]
>();

{
  type Context = { locale: string };
  const agent = new Agent<Context>({
    name: 'Typed blocked-message formatter agent',
  });
  const typecheckRunOptions = () =>
    run(agent, 'input', {
      context: { locale: 'ja' },
      outputGuardrailBlockedMessage: (args) => {
        expectTypeOf(args.runContext.context).toEqualTypeOf<Context>();
        return args.defaultMessage;
      },
    });

  expectTypeOf(typecheckRunOptions).toBeFunction();
}
