import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { demoAccessResponse } from '@/app/lib/demoAccess';
import { findSession, getOwnerId, readSessionHistory } from '@/app/lib/session';
import { toUiMessages } from '@/app/lib/messageConverters';
import TextStreamChatClient from './TextStreamChatClient';

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

export default async function TextStreamPage({ searchParams }: PageProps) {
  if (demoAccessResponse(await headers())) {
    return <p>Open this demo URL directly in your browser to sign in.</p>;
  }
  const resolvedSearchParams = await Promise.resolve(searchParams);
  const sessionId = readSessionId(resolvedSearchParams);

  const ownerId = sessionId ? await getOwnerId(sessionId) : undefined;
  const entry = sessionId ? findSession(sessionId, ownerId) : undefined;
  if (!sessionId || !entry) {
    redirect('/api/session?stream=text');
  }

  const historyItems = await readSessionHistory(sessionId, entry);
  const initialMessages = toUiMessages(historyItems);

  return (
    <TextStreamChatClient
      sessionId={sessionId}
      initialMessages={initialMessages}
    />
  );
}
