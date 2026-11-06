import { Agent, hostedMcpTool } from '@openai/agents/classic';

const authorization = process.env.GOOGLE_CALENDAR_AUTHORIZATION!;

export const connectorAgent = new Agent({
  name: 'Calendar Assistant',
  instructions:
    "You are a helpful assistant that can answer questions about the user's calendar.",
  tools: [
    hostedMcpTool({
      serverLabel: 'google_calendar',
      connectorId: 'connector_googlecalendar',
      authorization,
      requireApproval: 'never',
    }),
  ],
});
