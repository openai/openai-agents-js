'use client';

import { TransportEvent, OpenAIRealtimeWebRTC } from '@openai/agents/realtime';
import { useEffect, useRef, useState } from 'react';
import { getToken } from '../server/token.action';
import { App } from '@/components/App';

export default function Home() {
  const connection = useRef<OpenAIRealtimeWebRTC | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  const [events, setEvents] = useState<TransportEvent[]>([]);

  useEffect(() => {
    connection.current = new OpenAIRealtimeWebRTC({
      useInsecureApiKey: true,
    });
    connection.current.on('*', (event) => {
      setEvents((events) => [...events, event]);
    });
  }, []);

  async function connect() {
    if (isConnected) {
      await connection.current?.close();
      setIsConnected(false);
    } else {
      const token = await getToken();
      await connection.current?.connect({
        apiKey: token,
        model: 'gpt-4o-mini-realtime-preview',
        initialSessionConfig: {
          instructions: 'Speak like a pirate',
          voice: 'marin',
          modalities: ['text', 'audio'],
          inputAudioFormat: 'pcm16',
          outputAudioFormat: 'pcm16',
        },
      });
      setIsConnected(true);
    }
  }

  async function toggleMute() {
    if (isMuted) {
      await connection.current?.mute(false);
      setIsMuted(false);
    } else {
      await connection.current?.mute(true);
      setIsMuted(true);
    }
  }

  return (
    <App
      title="Demo Direct WebRTC Client"
      isConnected={isConnected}
      isMuted={isMuted}
      toggleMute={toggleMute}
      connect={connect}
      events={events}
    />
  );
}
