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
      // This is just a placeholder to show on the UI to show the agent is working
      {
        type: 'message',
        role: 'assistant',
        content: [],
        status: 'in_progress',
      },
    ]);

    // We will send the messages to the API route along with the conversation ID if we have one
    // and the decisions if we had any approvals in this turn
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
    } else {
      setApprovals([]);
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
      {/**
       * If we have any approvals, we will show the approvals component to allow the user to
       * approve or reject the tool calls. If we don't have any approvals, we will just show the
       * history. Once all the approvals are done, we will call the handleDone function to continue
       * the run. What kind of UI you render to show approval requests is up to you. You could also
       * render them as part of the chat history. We are rendering them separately here to show
       * that it can be an entirely different UI.
       */}
      <Approvals approvals={approvals} onDone={handleDone} />
    </>
  );
}
