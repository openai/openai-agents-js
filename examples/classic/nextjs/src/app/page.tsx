'use client';

import type {
  AgentInputItem,
  RunToolApprovalItem,
} from '@openai/agents/classic';
import { useEffect, useState } from 'react';
import { App } from '@/components/App';
import { Approvals } from '@/components/Approvals';

export default function Home() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [accessToken, setAccessToken] = useState('');
  const [error, setError] = useState<{
    message: string;
    status?: number;
  } | null>(null);
  const [history, setHistory] = useState<AgentInputItem[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<
    ReturnType<RunToolApprovalItem['toJSON']>[]
  >([]);

  useEffect(() => {
    fetch('/api/session')
      .then((response) => setAuthenticated(response.ok))
      .catch(() => setAuthenticated(false))
      .finally(() => setCheckingSession(false));
  }, []);

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const response = await fetch('/api/session', {
      method: 'POST',
      body: JSON.stringify({ token: accessToken }),
    });
    if (!response.ok) {
      const data = await response.json();
      setError({ message: data.error ?? 'Could not start demo session' });
      return;
    }
    setAccessToken('');
    setAuthenticated(true);
  }

  async function makeRequest({
    message,
    decisions,
  }: {
    message?: string;
    decisions?: Map<string, 'approved' | 'rejected'>;
  }) {
    setError(null);
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

    if (!response.ok) {
      setHistory(response.status === 413 ? history : messages);
      if (response.status === 401) {
        setAuthenticated(false);
        setConversationId(null);
        setApprovals([]);
      }
      setError({
        message: data.error ?? 'Request failed',
        status: response.status,
      });
      return;
    }

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

  if (checkingSession) return null;

  if (!authenticated) {
    return (
      <main className="mx-auto max-w-md p-8">
        <form onSubmit={signIn} className="flex flex-col gap-4">
          <label htmlFor="access-token">Demo access token</label>
          <input
            id="access-token"
            type="password"
            autoComplete="off"
            value={accessToken}
            onChange={(event) => setAccessToken(event.target.value)}
            className="rounded border p-2"
          />
          <button type="submit" className="rounded border p-2">
            Start demo
          </button>
          {error && <p role="alert">{error.message}</p>}
        </form>
      </main>
    );
  }

  return (
    <>
      {error && <p role="alert">{error.message}</p>}
      {error?.status === 413 && (
        <button
          type="button"
          className="underline"
          onClick={() => window.location.reload()}
        >
          Start a new conversation
        </button>
      )}
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
