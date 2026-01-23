'use client';

import { ChatKit, useChatKit } from '@openai/chatkit-react';

type ChatViewProps = {
  title: string;
  description: string;
  apiUrl: string;
  domainKey: string;
};

export default function ChatView({
  title,
  description,
  apiUrl,
  domainKey,
}: ChatViewProps) {
  const chatkit = useChatKit({
    api: {
      url: apiUrl,
      domainKey,
    },
    history: {
      enabled: true,
      showDelete: true,
      showRename: true,
    },
    threadItemActions: {
      feedback: false,
      retry: false,
    },
    theme: {
      colorScheme: 'dark',
    },
  });

  return (
    <div
      style={{
        maxWidth: 1100,
        margin: '0 auto',
        padding: '32px 24px 24px',
        display: 'grid',
        gridTemplateRows: 'auto 1fr',
        gap: 24,
        minHeight: '100vh',
        height: '100dvh',
        boxSizing: 'border-box',
      }}
    >
      <header style={{ display: 'grid', gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 32 }}>{title}</h1>
        <p style={{ margin: 0, color: '#cbd0d6' }}>{description}</p>
      </header>
      <div
        style={{
          borderRadius: 16,
          background: 'rgba(255, 255, 255, 0.06)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          padding: 12,
          display: 'grid',
          minHeight: 0,
        }}
      >
        <ChatKit
          control={chatkit.control}
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            minHeight: 0,
          }}
        />
      </div>
    </div>
  );
}
