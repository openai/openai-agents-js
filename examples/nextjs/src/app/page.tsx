'use client';

import type { AgentInputItem, RunToolApprovalItem } from '@openai/agents';
import { useState } from 'react';
import { App } from '@/components/App';
import { Approvals } from '@/components/Approvals';

export default function Home() {
  const [history, setHistory] = useState<AgentInputItem[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<
    ReturnType<RunToolApprovalItem['toJSON']>[]
  >([]);

  async function makeRequest({
    message,
    decisions,
  }: {
    message?: string;
    decisions?: Map<string, 'approved' | 'rejected'>;
  }) {
    const messages = [...history];

    if (message) {
      messages.push({ type: 'message', role: 'user', content: message });
    }

    setHistory([
      ...messages,
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
        messages,
        conversationId,
        decisions: Object.fromEntries(decisions ?? []),
      }),
    });

    const data = await response.json();

    if (data.conversationId) {
      setConversationId(data.conversationId);
    }

    if (data.history) {
      setHistory(data.history);
    }

    if (data.approvals) {
      setApprovals(data.approvals);
    }
  }

  const handleSend = async (message: string) => {
    await makeRequest({ message });
  };

  async function handleDone(decisions: Map<string, 'approved' | 'rejected'>) {
    await makeRequest({ decisions });
  }

  return (
    <>
      <App history={history} onSend={handleSend} />
      <Approvals approvals={approvals} onDone={handleDone} />
    </>
  );
}
