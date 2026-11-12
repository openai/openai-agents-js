import { expectTypeOf } from 'vitest';
import { z } from 'zod';
import type * as Agents from '../src/classic';
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
} from '../src/classic';

const _parameters = z.object({ query: z.string() });
type TestAgent = Agents.Agent<undefined>;
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
