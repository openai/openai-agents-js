import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { demoAccessResponse } from '@/app/lib/demoAccess';
import ChatView from '@/app/components/ChatView';
import { toUiMessages } from '@/app/lib/messageConverters';
import { findSession, getOwnerId, readSessionHistory } from '@/app/lib/session';

export const dynamic = 'force-dynamic';

const SESSION_QUERY_KEY = 'session';

type PageProps = {
  searchParams?:
    | Record<string, string | string[] | undefined>
    | Promise<Record<string, string | string[] | undefined>>;
};

function readSessionId(
  searchParams: Record<string, string | string[] | undefined> | undefined,
): string | undefined {
  const value = searchParams?.[SESSION_QUERY_KEY];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export default async function Page({ searchParams }: PageProps) {
  if (demoAccessResponse(await headers())) {
    return <p>Open this demo URL directly in your browser to sign in.</p>;
  }
  const resolvedSearchParams = await Promise.resolve(searchParams);
  const sessionId = readSessionId(resolvedSearchParams);

  const ownerId = sessionId ? await getOwnerId(sessionId) : undefined;
  const entry = sessionId ? findSession(sessionId, ownerId) : undefined;
  if (!sessionId || !entry) {
    redirect('/api/session');
  }

  const historyItems = await readSessionHistory(sessionId, entry);
  const initialMessages = toUiMessages(historyItems);

  return (
    <ChatView
      title="AI SDK UI Data Stream"
      description="UI message streaming backed by the Agents SDK, including tool calls and reasoning parts."
      placeholder="Ask about the night sky..."
      sessionId={sessionId}
      initialMessages={initialMessages}
    />
  );
}
