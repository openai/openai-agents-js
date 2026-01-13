import { z } from 'zod';
import { ModelResponse } from '../model';
import { RunItem } from '../items';
import { AgentInputItem } from '../types';

export const nextStepSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('next_step_handoff'),
    newAgent: z.any(),
  }),
  z.object({
    type: z.literal('next_step_final_output'),
    output: z.string(),
  }),
  z.object({
    type: z.literal('next_step_run_again'),
  }),
  z.object({
    type: z.literal('next_step_interruption'),
    data: z.record(z.string(), z.any()),
  }),
]);

export type NextStep = z.infer<typeof nextStepSchema>;

export class SingleStepResult {
  constructor(
    public originalInput: string | AgentInputItem[],
    public modelResponse: ModelResponse,
    public preStepItems: RunItem[],
    public newStepItems: RunItem[],
    public nextStep: NextStep,
  ) {}

  get generatedItems(): RunItem[] {
    return this.preStepItems.concat(this.newStepItems);
  }
}
