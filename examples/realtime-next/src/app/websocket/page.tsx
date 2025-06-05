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
import { handleRefundRequest } from '../server/backendAgent';
import { getToken } from '../server/token';
import { App } from '@/components/App';

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

const agent = new RealtimeAgent({
  name: 'Greeter',
  instructions:
    'You are a greeter. Always greet the user with a "top of the morning". When you use a tool always first say what you are about to do.',
  tools: [refundBackchannel],
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

  useEffect(() => {
    session.current = new RealtimeSession(agent, {
      transport: 'websocket',
      outputGuardrails: guardrails,
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

    session.current.on(
      'guardrail_tripped',
      (_context, _agent, guardrailError) => {
        setOutputGuardrailResult(guardrailError);
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
    <App
      title="Realtime Demo via WebSocket"
      isConnected={isConnected}
      isMuted={isMuted}
      toggleMute={toggleMute}
      connect={connect}
      history={history}
      outputGuardrailResult={outputGuardrailResult}
      events={events}
    />
  );
}
