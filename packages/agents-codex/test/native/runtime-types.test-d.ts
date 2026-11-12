import { expectTypeOf } from 'vitest';
import {
  allowExecutorCall,
  stopExecutorTurn,
  type ExecutorPolicyDecision,
} from '../../src/runtime/executor-decisions';
import type { EnvironmentOptions } from '../../src/runtime/environment';
import type {
  ActionRequested,
  ExecutorContext,
  NativeToolCall,
  ToolContext,
} from '@openai/agents';

{
  type Approval = NonNullable<EnvironmentOptions['approval']>;
  type Arguments = NonNullable<EnvironmentOptions['transformArguments']>;
  type Result = NonNullable<EnvironmentOptions['transformResult']>;
  expectTypeOf(stopExecutorTurn).returns.toExtend<ExecutorPolicyDecision>();
  expectTypeOf<ReturnType<typeof stopExecutorTurn>>().toExtend<
    Awaited<ReturnType<Approval>>
  >();
  expectTypeOf<ExecutorPolicyDecision>().toExtend<
    Awaited<ReturnType<Arguments>>
  >();
  expectTypeOf<ReturnType<typeof allowExecutorCall>>().not.toExtend<
    Awaited<ReturnType<Approval>>
  >();
  expectTypeOf<ExecutorPolicyDecision>().not.toExtend<
    Awaited<ReturnType<Result>>
  >();
}

{
  const unusedDecision: ToolContext['decide'] = () => {
    throw new Error('Unexpected decision call in synthetic tool context');
  };
  const unusedUsageReport: ToolContext['reportUsage'] = () => {
    throw new Error('Unexpected usage report in synthetic tool context');
  };
  const _context = {
    decide: unusedDecision,
    reportUsage: unusedUsageReport,
    context: undefined,
    submission: {
      sessionId: 'root',
      childId: 'child',
      instanceId: '1',
      turnId: 't',
      submissionId: 's',
    },
    threadId: 'root',
    turnId: 't',
    callId: 'c',
    signal: new AbortController().signal,
  };

  expectTypeOf<
    typeof _context & {
      originalArguments: Readonly<Record<string, never>>;
      effectiveArguments: Readonly<Record<string, never>>;
    }
  >().toExtend<ToolContext>();
  expectTypeOf<Omit<ActionRequested, 'call'>>().toExtend<ActionRequested>();
  expectTypeOf<Omit<ExecutorContext, 'call'>>().toExtend<ExecutorContext>();
  expectTypeOf<
    Omit<NativeToolCall, 'agentRole' | 'model'>
  >().toExtend<NativeToolCall>();
}
