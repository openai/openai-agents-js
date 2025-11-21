'use client';

import {
  RealtimeAgent,
  RealtimeSession,
  tool,
  TransportEvent,
  RealtimeItem,
  OutputGuardrailTripwireTriggered,
  RealtimeOutputGuardrail,
} from '@openai/agents/realtime';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { WavRecorder, WavStreamPlayer } from 'wavtools';
import { handleRefundRequest } from '../server/backendAgent.action';
import { getToken } from '../server/token.action';
import { App } from '@/components/App';
import { hostedMcpTool } from '@openai/agents';
import { CameraCapture } from '@/components/CameraCapture';

const refundBackchannel = tool({
  name: 'refundBackchannel',
  description: 'Evaluate a refund',
  parameters: z.object({
    request: z.string(),
  }),
  execute: async ({ request }) => {
    return handleRefundRequest(request);
  },
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

const weatherExpert = new RealtimeAgent({
  name: 'Weather Expert',
  instructions:
    'You are a weather expert. You are able to answer questions about the weather.',
  tools: [weatherTool],
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

const agent = new RealtimeAgent({
  name: 'Greeter',
  instructions:
    'You are a friendly assistant. When you use a tool always first say what you are about to do.',
  tools: [
    hostedMcpTool({
      serverLabel: 'dnd',
    }),
    hostedMcpTool({
      serverLabel: 'deepwiki',
    }),
    secretTool,
  ],
  handoffs: [weatherExpert],
});

export default function Home() {
  const session = useRef<RealtimeSession | null>(null);
  const player = useRef<WavStreamPlayer | null>(null);
  const recorder = useRef<WavRecorder | null>(null);

  const [isConnected, setIsConnected] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [outputGuardrailResult, setOutputGuardrailResult] =
    useState<OutputGuardrailTripwireTriggered<any> | null>(null);
  const [events, setEvents] = useState<TransportEvent[]>([]);
  const [history, setHistory] = useState<RealtimeItem[]>([]);
  const [mcpTools, setMcpTools] = useState<string[]>([]);
  // Image capture handled by CameraCapture component.

  useEffect(() => {
    session.current = new RealtimeSession(agent, {
      transport: 'websocket',
      model: 'gpt-realtime',
      outputGuardrails: guardrails,
      config: {
        audio: {
          output: {
            voice: 'cedar',
          },
        },
      },
    });
    recorder.current = new WavRecorder({ sampleRate: 24000 });
    player.current = new WavStreamPlayer({ sampleRate: 24000 });

    session.current.on('audio', (event) => {
      player.current?.add16BitPCM(event.data, event.responseId);
    });

    session.current.on('transport_event', (event) => {
      setEvents((events) => [...events, event]);
    });

    session.current.on('audio_interrupted', () => {
      // We only need to interrupt the player if we are already playing
      // everything else is handled by the session
      player.current?.interrupt();
    });

    session.current.on('history_updated', (history) => {
      setHistory(history);
    });

    session.current.on('error', (error) => {
      console.error('error', error);
    });

    session.current.on(
      'guardrail_tripped',
      (_context, _agent, guardrailError) => {
        setOutputGuardrailResult(guardrailError);
      },
    );
    session.current.on('mcp_tools_changed', (tools) => {
      setMcpTools(tools.map((t) => t.name));
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

    session.current.on(
      'mcp_tool_call_completed',
      (_context, _agent, toolCall) => {
        session.current?.transport?.sendEvent({
          type: 'response.create',
        });
      },
    );
  }, []);

  async function record() {
    await recorder.current?.record(async (data) => {
      await session.current?.sendAudio(data.mono as unknown as ArrayBuffer);
    });
  }

  async function connect() {
    if (isConnected) {
      await session.current?.close();
      await player.current?.interrupt();
      await recorder.current?.end();
      setIsConnected(false);
    } else {
      await player.current?.connect();
      const token = await getToken();
      await session.current?.connect({
        apiKey: token,
      });
      await recorder.current?.begin();
      await record();
      setIsConnected(true);
    }
  }

  async function toggleMute() {
    if (isMuted) {
      await record();
      setIsMuted(false);
    } else {
      await recorder.current?.pause();
      setIsMuted(true);
    }
  }

  return (
    <div className="relative">
      <App
        title="Realtime Demo via WebSocket"
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
