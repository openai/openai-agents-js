'use client';

import { useMemo } from 'react';
import { TextStreamChatTransport, type UIMessage } from 'ai';
import ChatView from '../components/ChatView';

type TextStreamChatClientProps = {
  sessionId: string;
  initialMessages: UIMessage[];
};

export default function TextStreamChatClient({
  sessionId,
  initialMessages,
}: TextStreamChatClientProps) {
  const transport = useMemo(
    () => new TextStreamChatTransport({ api: '/api/chat/text' }),
    [],
  );

  return (
    <ChatView
      title="AI SDK UI Text Stream"
      description="Text-only UI rendering using the Agents SDK text stream adapter."
      placeholder="Ask about the night sky..."
      sessionId={sessionId}
      initialMessages={initialMessages}
      transport={transport}
    />
  );
}
