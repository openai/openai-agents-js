'use client';

import type { AgentInputItem } from '@openai/agents';
import { useState } from 'react';
import { App } from '@/components/App';

export default function Home() {
  const [history, setHistory] = useState<AgentInputItem[]>([]);

  const handleSend = async (message: string) => {
    setHistory([
      ...history,
      {
        type: 'message',
        role: 'assistant',
        content: [],
        status: 'in_progress',
      },
    ]);

    const response = await fetch('/api/basic', {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          ...history,
          { type: 'message', role: 'user', content: message },
        ],
      }),
    });
    const data = await response.json();
    console.log(data);
    setHistory(data.history);
  };

  return <App history={history} onSend={handleSend} />;
}
