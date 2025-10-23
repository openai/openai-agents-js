import { z } from 'zod';
import readline from 'node:readline';
import { Agent, withTrace, tool, run, RunContext } from '@openai/agents';
import { RECOMMENDED_PROMPT_PREFIX } from '@openai/agents-core/extensions';

// ------------------------------------------------
// Context

interface AirlineAgentContext {
  passengerName?: string;
  confirmationNumber?: string;
  seatNumber?: string;
  flightNumber?: string;
}

// ------------------------------------------------
// Tools

// FAQ lookup tool
const faqLookupTool = tool({
  name: 'faq_lookup_tool',
  description: 'Lookup frequently asked questions.',
  parameters: z.object({
    question: z.string(),
  }),
  async execute(input: { question: string }) {
    const q = input.question.toLowerCase();
    if (q.includes('bag') || q.includes('baggage')) {
      return (
        'You are allowed to bring one bag on the plane. ' +
        'It must be under 50 pounds and 22 inches x 14 inches x 9 inches.'
      );
    } else if (q.includes('seats') || q.includes('plane')) {
      return (
        'There are 120 seats on the plane. ' +
        'There are 22 business class seats and 98 economy seats. ' +
        'Exit rows are rows 4 and 16. ' +
        'Rows 5-8 are Economy Plus, with extra legroom. '
      );
    } else if (q.includes('wifi')) {
      return 'We have free wifi on the plane, join Airline-Wifi';
    }
    return "I'm sorry, I don't know the answer to that question.";
  },
});

// Mock update_seat tool
const updateSeat = tool({
  name: 'update_seat',
  description: 'Update a seat on a flight',
  parameters: z.object({
    confirmationNumber: z.string(),
    seatNumber: z.string(),
  }),
  async execute(
    input: { confirmationNumber: string; seatNumber: string },
    context?: RunContext<AirlineAgentContext>,
  ) {
    if (context && context.context) {
      context.context.seatNumber = input.seatNumber;
      context.context.confirmationNumber = input.confirmationNumber;
    }
    return `Seat updated to ${input.seatNumber} for confirmation ${input.confirmationNumber}`;
  },
});

// ------------------------------------------------
// Agents

// FAQ Agent
const faqAgent = new Agent({
  name: 'FAQ Agent',
  handoffDescription:
    'A helpful agent that can answer questions about the airline.',
  instructions: `${RECOMMENDED_PROMPT_PREFIX}
You are an FAQ agent. If you are speaking to a customer, you probably were transferred to from the triage agent.
Use the following routine to support the customer.

# Routine
1. Identify the last question asked by the customer.
2. Use the faq lookup tool to answer the question. Do not rely on your own knowledge.
3. If you cannot answer the question, transfer back to the triage agent
`,
  tools: [faqLookupTool],
});

// Seat Booking Agent
const seatBookingAgent = new Agent<AirlineAgentContext>({
  name: 'Seat Booking Agent',
  handoffDescription: 'A helpful agent that can update a seat on a flight.',
  instructions: `${RECOMMENDED_PROMPT_PREFIX}
You are a seat booking agent. If you are speaking to a customer, you probably were transferred to from the triage agent.
Use the following routine to support the customer.

# Routine
1. Ask for their confirmation number.
2. Ask the customer what their desired seat number is.
3. Use the update seat tool to update the seat on the flight.
If the customer asks a question that is not related to the routine, transfer back to the triage agent.`,
  tools: [updateSeat],
});

// Triage Agent
const triageAgent = Agent.create({
  name: 'Triage Agent',
  handoffDescription:
    "A triage agent that can delegate a customer's request to the appropriate agent.",
  instructions: `${RECOMMENDED_PROMPT_PREFIX}
  You are a helpful triaging agent. You can use your tools to delegate questions to other appropriate agents.`,
  handoffs: [faqAgent, seatBookingAgent],
});

// Make sure agents can handoff to each other
faqAgent.handoffs = [triageAgent];
seatBookingAgent.handoffs = [triageAgent];

// ------------------------------------------------
// Main function

// CLI runner loop
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function promptUser(query: string): Promise<string> {
  return new Promise((resolve) => rl.question(query, resolve));
}

async function main() {
  let currentAgent = triageAgent;
  const context: AirlineAgentContext = {};
  let inputItems: any[] = [];
  while (true) {
    const userInput = await promptUser('Enter your message: ');
    await withTrace('Customer service', async () => {
      inputItems.push({ content: userInput, role: 'user' });
      const result = await run(currentAgent, inputItems, { context });

      console.log(
        '-----------------------------------------------------------',
      );
      console.log(`result.output: ${JSON.stringify(result.output, null, 2)}`);
      console.log(`context: ${JSON.stringify(context, null, 2)}`);
      console.log(
        '-----------------------------------------------------------',
      );

      for (const newItem of result.newItems) {
        // Type guards for RunItem discriminated union
        if (newItem.type === 'message_output_item') {
          const agentName = (newItem as any).agent?.name || 'Agent';
          console.log(`${agentName}: ${newItem.content}`);
        } else if (newItem.type === 'handoff_output_item') {
          const handoffItem = newItem as any;
          console.log(
            `Handed off from ${handoffItem.sourceAgent.name} to ${handoffItem.targetAgent.name}`,
          );
        } else if (newItem.type === 'tool_call_item') {
          const agentName = (newItem as any).agent?.name || 'Agent';
          console.log(`${agentName}: Calling a tool`);
        } else if (newItem.type === 'tool_call_output_item') {
          const agentName = (newItem as any).agent?.name || 'Agent';
          console.log(
            `${agentName}: Tool call output: ${(newItem as any).output}`,
          );
        } else {
          const agentName = (newItem as any).agent?.name || 'Agent';
          console.log(`${agentName}: Skipping item: ${newItem.type}`);
        }
      }
      // Defensive: check if history and lastAgent exist
      if ((result as any).history) {
        inputItems = (result as any).history;
      }
      if ((result as any).lastAgent) {
        currentAgent = (result as any).lastAgent;
      }
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
