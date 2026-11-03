// Public Agent fixtures for output/handoff admission and Context/output types.
// Native execution credit requires the recorded composed source and products.
import { expectTypeOf } from 'vitest';
import { z } from 'zod';
import { Agent, handoff, tool } from '@openai/agents/classic';
import { ScriptedModel } from '@openai/agents/classic/testing';
import { SDKRunner, type MigrationRunResult } from '@openai/agents/migration';

interface Context {
  tenant: string;
}
const report = z.object({ title: z.string(), count: z.number() });

export function structuredRootTextTarget() {
  const effects = { execute: 0, onHandoff: 0 };
  const model = new ScriptedModel([]);
  const target = new Agent<Context>({
    name: 'Text target',
    model,
    modelSettings: {},
    tools: [
      tool({
        name: 'target_effect',
        description: 'Synthetic effect must not execute.',
        parameters: z.object({}),
        execute: () => {
          effects.execute++;
          return 'unexpected';
        },
      }),
    ],
  });
  const agent = new Agent<Context, typeof report>({
    name: 'Structured root',
    model,
    modelSettings: {},
    outputType: report,
    handoffs: [
      handoff(target, {
        onHandoff: () => {
          effects.onHandoff++;
        },
      }),
    ],
  });
  return { agent, target, effects, model };
}

export function textRootStructuredTarget() {
  const effects = { execute: 0, onHandoff: 0 };
  const model = new ScriptedModel([]);
  const target = new Agent<Context, typeof report>({
    name: 'Structured target',
    model,
    modelSettings: {},
    outputType: report,
    tools: [
      tool({
        name: 'target_effect',
        description: 'Synthetic effect must not execute.',
        parameters: z.object({}),
        execute: () => {
          effects.execute++;
          return 'unexpected';
        },
      }),
    ],
  });
  const agent = new Agent<Context>({
    name: 'Text root',
    model,
    modelSettings: {},
    handoffs: [
      handoff(target, {
        onHandoff: () => {
          effects.onHandoff++;
        },
      }),
    ],
  });
  return { agent, target, effects, model };
}

export function publicTypeContract() {
  const model = new ScriptedModel([]);
  const context = { tenant: 'synthetic' };
  const objectAgent = new Agent<Context, typeof report>({
    name: 'Object without handoff',
    model,
    modelSettings: {},
    outputType: report,
  });
  const _objectResult = () =>
    SDKRunner.run(objectAgent, 'Report.', { context });
  expectTypeOf<
    Awaited<ReturnType<typeof _objectResult>>['finalOutput']
  >().toEqualTypeOf<{ title: string; count: number }>();
  expectTypeOf<
    Awaited<ReturnType<typeof _objectResult>>['runContext']['context']
  >().toEqualTypeOf<Context>();
  expectTypeOf<
    MigrationRunResult<Context>['finalOutput']
  >().toEqualTypeOf<string>();
  const textAgent = new Agent<Context>({
    name: 'Text',
    model,
    modelSettings: {},
  });
  const _textResult = () => SDKRunner.run(textAgent, 'Text.', { context });
  expectTypeOf<
    Awaited<ReturnType<typeof _textResult>>['finalOutput']
  >().toEqualTypeOf<string>();
}

// Keep the two runtime refusal tests separate: their public Agents have different
// output generics. Do not hide that difference behind a heterogeneous any array.
// Each must await actionable combination refusal, then independently assert
// model.calls.length === 0 and both effect counters === 0. A generic rejection
// alone could accidentally accept an empty-script Model failure as admission.
