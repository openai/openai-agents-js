import { RECOMMENDED_PROMPT_PREFIX } from '@openai/agents-core/extensions';
import { RealtimeAgent, tool } from '@openai/agents/realtime';
import { z } from 'zod';

export const WELCOME_MESSAGE =
  'Hello, this is ABC customer service. How can I help you today?';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const faqLookupSchema = z.object({
  question: z.string().describe('The caller question to search for.'),
});

const faqLookupTool = tool({
  name: 'faq_lookup_tool',
  description: 'Lookup frequently asked questions for the caller.',
  parameters: faqLookupSchema,
  execute: async ({ question }: z.infer<typeof faqLookupSchema>) => {
    await wait(1000);

    const normalized = question.toLowerCase();
    if (normalized.includes('wi-fi') || normalized.includes('wifi')) {
      return 'We provide complimentary Wi-Fi. Join the ABC-Customer network.';
    }
    if (normalized.includes('billing') || normalized.includes('invoice')) {
      return 'Your latest invoice is available in the ABC portal under Billing > History.';
    }
    if (normalized.includes('hours') || normalized.includes('support')) {
      return 'Human support agents are available 24/7; transfer to the specialist if needed.';
    }
    return "I'm not sure about that. Let me transfer you back to the triage agent.";
  },
});

const updateCustomerRecordSchema = z.object({
  customerId: z
    .string()
    .describe('Unique identifier for the customer you are updating.'),
  note: z
    .string()
    .describe('Brief summary of the customer request to store in records.'),
});

const updateCustomerRecord = tool({
  name: 'update_customer_record',
  description: 'Record a short note about the caller.',
  parameters: updateCustomerRecordSchema,
  execute: async ({
    customerId,
    note,
  }: z.infer<typeof updateCustomerRecordSchema>) => {
    await wait(1000);
    return `Recorded note for ${customerId}: ${note}`;
  },
});

const faqAgent = new RealtimeAgent({
  name: 'FAQ Agent',
  handoffDescription:
    'Handles frequently asked questions and general account inquiries.',
  instructions: `${RECOMMENDED_PROMPT_PREFIX}
You are an FAQ specialist. Always rely on the faq_lookup_tool for answers and keep replies concise. If the caller needs hands-on help, transfer back to the triage agent.`,
  tools: [faqLookupTool],
});

const recordsAgent = new RealtimeAgent({
  name: 'Records Agent',
  handoffDescription:
    'Updates customer records with brief notes and confirmation numbers.',
  instructions: `${RECOMMENDED_PROMPT_PREFIX}
You handle structured updates. Confirm the customer's ID, capture their request in a short note, and use the update_customer_record tool. For anything outside data updates, return to the triage agent.`,
  tools: [updateCustomerRecord],
});

const triageAgent = new RealtimeAgent({
  name: 'Triage Agent',
  handoffDescription:
    'Greets callers and routes them to the most appropriate specialist.',
  instructions: `${RECOMMENDED_PROMPT_PREFIX}
Always begin the call by saying exactly '${WELCOME_MESSAGE}' before collecting details. Once the greeting is complete, gather context and hand off to the FAQ or Records agents when appropriate.`,
  handoffs: [faqAgent, recordsAgent],
});

faqAgent.handoffs = [triageAgent, recordsAgent];
recordsAgent.handoffs = [triageAgent, faqAgent];

export function getStartingAgent(): RealtimeAgent {
  return triageAgent;
}
