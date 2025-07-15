import { z } from '@openai/zod';
import { Agent, handoff, RunContext } from '@openai/agents';

const EscalationData = z.object({ reason: z.string() });
type EscalationData = z.infer<typeof EscalationData>;

async function onHandoff(
  ctx: RunContext<EscalationData>,
  input: EscalationData | undefined,
) {
  console.log(`Escalation agent called with reason: ${input?.reason}`);
}

const agent = new Agent<EscalationData>({ name: 'Escalation agent' });

const handoffObj = handoff(agent, {
  onHandoff,
  inputType: EscalationData,
});
