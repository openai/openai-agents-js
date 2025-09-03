// @ts-expect-error Typescript doesn't know about the css module.
import './style.css';
import {
  connectButton,
  disconnectButton,
  log,
  muteButton,
  setMcpTools,
  setButtonStates,
} from './utils';

import { z } from 'zod';
import type {
  RealtimeContextData,
  RealtimeItem,
  TransportEvent,
} from '@openai/agents-realtime';
import {
  RealtimeAgent,
  RealtimeSession,
  backgroundResult,
  tool,
} from '@openai/agents-realtime';
import { hostedMcpTool } from '@openai/agents-core';
import type { RunContext, RunToolApprovalItem } from '@openai/agents-core';

setMcpTools([]);

const refundParameters = z.object({
  request: z.string(),
});

const refundBackchannel = tool<typeof refundParameters, RealtimeContextData>({
  name: 'Refund Expert',
  description: 'Evaluate a refund request and provide guidance.',
  parameters: refundParameters,
  execute: async (
    { request }: z.infer<typeof refundParameters>,
    details: RunContext<RealtimeContextData> | undefined,
  ) => {
    const history: RealtimeItem[] = details?.context?.history ?? [];
    return backgroundResult(
      [
        'Refund request received.',
        `Request: ${request}`,
        `Previous conversation turns: ${history.length}.`,
        'In this demo, responses are generated locally without contacting a backend service.',
      ].join('\n'),
    );
  },
});

const weatherParameters = z.object({
  location: z.string(),
});

const weatherTool = tool({
  name: 'weather',
  description: 'Get the weather in a given location.',
  parameters: weatherParameters,
  execute: async ({ location }: z.infer<typeof weatherParameters>) => {
    return backgroundResult(`The weather in ${location} is sunny.`);
  },
});

const secretParameters = z.object({
  question: z.string(),
});

const secretTool = tool({
  name: 'secret',
  description: 'A secret tool to tell the special number.',
  parameters: secretParameters,
  execute: async ({ question }: z.infer<typeof secretParameters>) => {
    return `The answer to ${question} is 42.`;
  },
  needsApproval: true,
});

const weatherAgent = new RealtimeAgent({
  name: 'Weather Expert',
  instructions:
    'You are a weather expert. You are able to answer questions about the weather.',
  tools: [weatherTool],
});

const agent = new RealtimeAgent({
  name: 'Greeter',
  instructions:
    'You are a friendly assistant. When you use a tool always first say what you are about to do.',
  tools: [
    refundBackchannel,
    secretTool,
    hostedMcpTool({
      serverLabel: 'deepwiki',
    }),
    hostedMcpTool({
      serverLabel: 'dnd',
    }),
  ],
  handoffs: [weatherAgent],
});

weatherAgent.handoffs.push(agent);

const session = new RealtimeSession(agent, {
  model: 'gpt-realtime',
  config: {
    audio: {
      output: {
        voice: 'cedar',
      },
    },
  },
});

session.on('transport_event', (event: TransportEvent) => {
  // This logs the events coming directly from the Realtime API server.
  log(event);
});

session.on('mcp_tools_changed', (tools: Array<{ name: string }>) => {
  setMcpTools(tools.map((tool) => tool.name));
});

session.on('tool_approval_requested', (_context, _agent, approvalRequest) => {
  const approvalItem = approvalRequest.approvalItem as RunToolApprovalItem;
  const parameters =
    typeof approvalItem.rawItem.arguments === 'string'
      ? approvalItem.rawItem.arguments
      : JSON.stringify(approvalItem.rawItem.arguments, null, 2);
  const approved = confirm(
    `Approve tool call to ${approvalItem.rawItem.name} with parameters:\n${parameters}`,
  );
  if (approved) {
    session.approve(approvalItem);
  } else {
    session.reject(approvalItem);
  }
});

connectButton.addEventListener('click', async () => {
  const apiKey = prompt(
    'Enter ephemeral API key. Run `pnpm -F realtime-demo generate-token` to get a token.',
  );
  if (!apiKey) {
    return;
  }
  await session.connect({
    apiKey,
  });
  setButtonStates('unmuted');
});

disconnectButton.addEventListener('click', () => {
  session.close();
  setButtonStates('disconnected');
  setMcpTools([]);
});

muteButton.addEventListener('click', () => {
  const newMutedState = !session.muted;
  session.mute(newMutedState);
  setButtonStates(newMutedState ? 'muted' : 'unmuted');
});
