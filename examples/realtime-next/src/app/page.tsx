'use client';

import {
  RealtimeAgent,
  RealtimeSession,
  tool,
  TransportEvent,
  RealtimeOutputGuardrail,
  OutputGuardrailTripwireTriggered,
  RealtimeItem,
  RealtimeContextData,
} from '@openai/agents/realtime';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { handleRefundRequest } from './server/backendAgent.action';
import { getToken } from './server/token.action';
import { App } from '@/components/App';
import { hostedMcpTool } from '@openai/agents';
import { CameraCapture } from '@/components/CameraCapture';

const params = z.object({
  request: z.string(),
});
const refundBackchannel = tool<typeof params, RealtimeContextData>({
  name: 'Refund Expert',
  description: 'Evaluate a refund',
  parameters: params,
  execute: async ({ request }, details) => {
    const history: RealtimeItem[] = details?.context?.history ?? [];
    return handleRefundRequest(request, history);
  },
});

const weatherTool = tool({
  name: 'weather',
  description: 'Get the weather in a given location',
  parameters: z.object({
    location: z.string(),
  }),
  execute: async ({ location }) => {
    return `The weather in ${location} is sunny.`;
  },
});

// To invoke this tool, you can ask a question like "What is the special number?"
const secretTool = tool({
  name: 'secret',
  description: 'A secret tool to tell the special number',
  parameters: z.object({
    question: z
      .string()
      .describe(
        'The question to ask the secret tool; mainly about the special number.',
      ),
  }),
  execute: async ({ question }) => {
    return `The answer to ${question} is 42.`;
  },
  // RealtimeAgent handles this approval process within tool_approval_requested events
  needsApproval: true,
});

const weatherExpert = new RealtimeAgent({
  name: 'Weather Expert',
  instructions:
    'You are a weather expert. You are able to answer questions about the weather.',
  tools: [weatherTool],
});

const agent = new RealtimeAgent({
  name: 'Greeter',
  instructions: 'You are a greeter',
  tools: [
    refundBackchannel,
    secretTool,
    hostedMcpTool({
      serverLabel: 'deepwiki',
    }),
    weatherTool,
  ],
  handoffs: [weatherExpert],
});

const guardrails: RealtimeOutputGuardrail[] = [
  {
    name: 'No mention of Dom',
    execute: async ({ agentOutput }) => {
      const domInOutput = agentOutput.includes('Dom');
      return {
        tripwireTriggered: domInOutput,
        outputInfo: {
          domInOutput,
        },
      };
    },
  },
];

export default function Home() {
  const session = useRef<RealtimeSession<any> | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [outputGuardrailResult, setOutputGuardrailResult] =
    useState<OutputGuardrailTripwireTriggered<any> | null>(null);

  const [events, setEvents] = useState<TransportEvent[]>([]);
  const [history, setHistory] = useState<RealtimeItem[]>([]);
  const [mcpTools, setMcpTools] = useState<string[]>([]);

  useEffect(() => {
    session.current = new RealtimeSession(agent, {
      model: 'gpt-realtime',
      outputGuardrails: guardrails,
      outputGuardrailSettings: {
        debounceTextLength: 200,
      },
      config: {
        audio: {
          output: {
            voice: 'cedar',
          },
        },
      },
    });
    session.current.on('transport_event', (event) => {
      setEvents((events) => [...events, event]);
    });
    session.current.on('mcp_tools_changed', (tools) => {
      setMcpTools(tools.map((t) => t.name));
    });
    session.current.on(
      'guardrail_tripped',
      (_context, _agent, guardrailError) => {
        setOutputGuardrailResult(guardrailError);
      },
    );
    session.current.on('history_updated', (history) => {
      setHistory(history);
    });
    session.current.on(
      'tool_approval_requested',
      (_context, _agent, approvalRequest) => {
        // You'll be prompted when making the tool call that requires approval in web browser.
        const approved = confirm(
          `Approve tool call to ${approvalRequest.approvalItem.name} with parameters:\n ${approvalRequest.approvalItem.arguments ?? '{}'}?`,
        );
        if (approved) {
          session.current?.approve(approvalRequest.approvalItem);
        } else {
          session.current?.reject(approvalRequest.approvalItem);
        }
      },
    );
  }, []);

  async function connect() {
    if (isConnected) {
      await session.current?.close();
      setIsConnected(false);
    } else {
      const token = await getToken();
      try {
        await session.current?.connect({
          apiKey: token,
        });
        setIsConnected(true);
      } catch (error) {
        console.error('Error connecting to session', error);
      }
    }
  }

  async function toggleMute() {
    if (isMuted) {
      await session.current?.mute(false);
      setIsMuted(false);
    } else {
      await session.current?.mute(true);
      setIsMuted(true);
    }
  }

  return (
    <div className="relative">
      <App
        isConnected={isConnected}
        isMuted={isMuted}
        toggleMute={toggleMute}
        connect={connect}
        history={history}
        outputGuardrailResult={outputGuardrailResult}
        events={events}
        mcpTools={mcpTools}
      />
      <div className="fixed bottom-4 right-4 z-50">
        <CameraCapture
          disabled={!isConnected}
          onCapture={(dataUrl) => {
            if (!session.current) return;
            session.current.addImage(dataUrl, { triggerResponse: false });
          }}
        />
      </div>
    </div>
  );
}
