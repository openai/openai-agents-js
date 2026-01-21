'use client';

import { useMemo } from 'react';
import { TextStreamChatTransport } from 'ai';

import ChatView from '../components/ChatView';

export default function TextStreamPage() {
  const transport = useMemo(
    () => new TextStreamChatTransport({ api: '/api/chat/text' }),
    [],
  );

  return (
    <ChatView
      title="AI SDK UI Text Stream"
      description="Text-only UI rendering using the Agents SDK text stream adapter."
      placeholder="Ask about the night sky..."
      transport={transport}
    />
  );
}
