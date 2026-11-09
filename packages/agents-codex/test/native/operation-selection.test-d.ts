import { expectTypeOf } from 'vitest';
import { z } from 'zod';
import {
  NativeAgents,
  type ChildBeforeStepContext,
  type ChildTurn,
  type ChildCompleted,
  type StepDecision,
} from '@openai/agents';
import {
  Agent,
  manualTool,
  tool,
  toolRef,
  type Turn,
  type BeforeStepContext,
  type ToolContext,
  type ToolSelector,
} from '../../src';

// Compile-only contracts; no application work runs at module load.
export async function operationSelectionContracts() {
  const a = tool({ name: 'a', parameters: z.object({}), execute: () => 'a' });
  const manual = manualTool({
    name: 'decision',
    description: 'Choose.',
    parameters: z.object({}),
    result: z.string(),
  });
  const context = { enabled: true };
  const contextual = tool({
    name: 'contextual',
    parameters: z.object({}),
    execute: (_args, call: ToolContext<typeof context>) =>
      String(call.context.enabled),
  });
  const session = await new Agent<typeof context>({
    instructions: 'Answer.',
    tools: [a, manual, contextual],
  }).session({ context });
  const selected = session.submit('go', {
    tools: [a, manual],
    beforeStep(step) {
      expectTypeOf(step).toEqualTypeOf<BeforeStepContext<typeof context>>();
      expectTypeOf(step.submission).toEqualTypeOf<Turn<unknown>>();
      expectTypeOf(step.stepIndex).toEqualTypeOf<number>();
      return step.context.enabled ? [a] : [];
    },
  });
  expectTypeOf(selected).toEqualTypeOf<Promise<Turn<string>>>();
  expectTypeOf(
    session.enqueue('go', {
      tools: [toolRef('a'), toolRef('lookup', 'mcp__reports')],
    }),
  ).toEqualTypeOf<Promise<Turn<string, string | null>>>();
  expectTypeOf(
    session.submit('go', { ...{ tools: [] }, outputType: z.number() }),
  ).toEqualTypeOf<Promise<Turn<number>>>();
  const incompatible = tool({
    name: 'incompatible',
    parameters: z.object({}),
    execute: (_args, call: ToolContext<string>) => call.context,
  });
  const legacySelector: ToolSelector = incompatible;
  void legacySelector;
  void session.submit('typed', {
    tools: [contextual],
    beforeStep: () => [contextual, toolRef('a')],
  });
  void session.submit('async', {
    beforeStep: async ({ stepIndex }) =>
      stepIndex === 0 ? [contextual] : undefined,
  });
  const stop: StepDecision<typeof context> = { action: 'stop' };
  void session.submit('stop', { beforeStep: () => stop });
  void session.submit('stop asynchronously', {
    beforeStep: async () => ({ action: 'stop' }),
  });
  // @ts-expect-error Selected function declarations must accept the Session context.
  void session.submit('wrong context', { tools: [incompatible] });
  // @ts-expect-error Synchronous preparation cannot select an incompatible context.
  void session.submit('wrong context', { beforeStep: () => [incompatible] });
  void session.submit('wrong context', {
    // @ts-expect-error Asynchronous preparation cannot select an incompatible context.
    beforeStep: async () => [incompatible],
  });
  // @ts-expect-error beforeStep returns selectors, not a new declaration roster.
  void session.submit('go', { beforeStep: () => ['a'] });
  // @ts-expect-error A steering call has no operation-selection option.
  void (await selected).steer('go', { tools: [] });
  // @ts-expect-error A manual reply cannot select operation tools.
  void session.respond({}, { tools: [] });
}

// Child selectors expose only controls supported by the exact child Turn.
export function childSelectionContracts() {
  new NativeAgents({ beforeStep: () => ({ action: 'stop' }) });
  return new NativeAgents<{ enabled: boolean }>({
    async beforeStep(step) {
      expectTypeOf(step).toEqualTypeOf<
        ChildBeforeStepContext<{ enabled: boolean }>
      >();
      expectTypeOf(step.submission).toEqualTypeOf<ChildTurn>();
      expectTypeOf(step.submission.wait()).toEqualTypeOf<
        Promise<ChildCompleted>
      >();
      const completed = await step.submission.wait();
      expectTypeOf(completed.finalOutput).toEqualTypeOf<string>();
      expectTypeOf(completed.turn).toEqualTypeOf<ChildTurn>();
      // @ts-expect-error Child Turns cannot directly cancel native child work.
      void step.submission.cancel();
      // @ts-expect-error Child Turns cannot steer native child work.
      void step.submission.steer('detail');
      // @ts-expect-error Exact steering is a root Turn control.
      void step.submission.steerExact('detail');
      return step.context.enabled ? undefined : { action: 'stop' };
    },
  });
}
