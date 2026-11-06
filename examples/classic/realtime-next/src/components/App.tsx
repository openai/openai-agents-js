'use client';
import {
  RealtimeItem,
  OutputGuardrailTripwireTriggered,
  TransportEvent,
} from '@openai/agents/realtime';
import { History } from '@/components/History';
import { Button } from '@/components/ui/Button';
import { useEffect, useState } from 'react';

export type AppProps = {
  title?: string;
  isConnected: boolean;
  isMuted: boolean;
  toggleMute: () => void;
  connect: () => void;
  history?: RealtimeItem[];
  outputGuardrailResult?: OutputGuardrailTripwireTriggered<any> | null;
  events: TransportEvent[];
  mcpTools?: string[];
};

export function App({
  title = 'Realtime Agent Demo',
  isConnected,
  isMuted,
  toggleMute,
  connect,
  history,
  outputGuardrailResult,
  events,
  mcpTools = [],
}: AppProps) {
  // Avoid hydration mismatches when layout changes between server and client
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div className="flex justify-center">
      <div className="p-4 md:max-h-screen overflow-hidden h-screen flex flex-col max-w-6xl w-full">
        <header className="flex-none flex justify-between items-center pb-4 w-full max-w-6xl">
          <h1 className="text-2xl font-bold">{title}</h1>
          <div className="flex gap-2">
            {isConnected && (
              <Button
                onClick={toggleMute}
                variant={isMuted ? 'primary' : 'outline'}
              >
                {isMuted ? 'Unmute' : 'Mute'}
              </Button>
            )}
            <Button
              onClick={connect}
              variant={isConnected ? 'stop' : 'primary'}
            >
              {isConnected ? 'Disconnect' : 'Connect'}
            </Button>
          </div>
        </header>
        <div className="flex gap-10 flex-col md:flex-row h-full max-h-full overflow-y-hidden">
          <div className="flex-2/3 flex-grow overflow-y-scroll pb-24">
            {history ? (
              <History history={history} />
            ) : (
              <div className="h-full flex items-center justify-center text-center text-gray-500">
                No history available
              </div>
            )}
          </div>
          <div className="flex-1/3 flex flex-col flex-grow gap-4">
            {outputGuardrailResult && (
              <div className="flex-0 w-full p-2 border border-blue-300 rounded-md bg-blue-50 text-blue-900 text-xs self-end shadow-sm">
                <span className="font-semibold">Guardrail:</span>{' '}
                {outputGuardrailResult?.message ||
                  JSON.stringify(outputGuardrailResult)}
              </div>
            )}
            {mounted && (
              <div className="flex-0 w-full p-3 border border-zinc-200 dark:border-zinc-700 rounded-md bg-white/60 dark:bg-zinc-900/60 text-xs">
                <h3 className="text-sm font-semibold mb-2">
                  Available MCP Tools
                </h3>
                {mcpTools.length === 0 ? (
                  <p className="text-xs text-zinc-500">None</p>
                ) : (
                  <ul className="list-disc pl-4 space-y-1">
                    {mcpTools.map((name) => (
                      <li className="text-xs" key={name}>
                        {name}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div
              className="overflow-scroll w-96 max-h-64 md:h-full md:max-h-none flex-1 p-4 border border-gray-300 rounded-lg [&_pre]:bg-gray-100 [&_pre]:p-4 [&_summary]:mb-2 [&>details]:border-b [&>details]:border-gray-200 [&>details]:py-2 text-xs"
              id="eventLog"
            >
              {events.map((event, index) => (
                <details key={index}>
                  <summary>{event.type}</summary>
                  <pre>{JSON.stringify(event, null, 2)}</pre>
                </details>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
