'use client';

import { useMemo, useState } from 'react';
import {
  ChatTransport,
  getStaticToolName,
  isReasoningUIPart,
  isToolUIPart,
  type UIDataTypes,
  type UIMessage,
  type UIMessagePart,
  type UITools,
} from 'ai';
import { useChat } from '@ai-sdk/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

type ChatViewProps = {
  title: string;
  description: string;
  placeholder: string;
  sessionId: string;
  initialMessages?: UIMessage[];
  transport?: ChatTransport<UIMessage>;
};

function renderJson(value: unknown) {
  return (
    <pre
      style={{
        margin: '8px 0 0',
        padding: '10px 12px',
        background: '#0f1116',
        borderRadius: 10,
        fontSize: 12,
        overflowX: 'auto',
      }}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function renderText(text: string) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      components={{
        p: ({ children }) => <p style={{ margin: 0 }}>{children}</p>,
        a: ({ children, href }) => (
          <a
            href={href}
            style={{ color: '#8aa4ff' }}
            target="_blank"
            rel="noreferrer"
          >
            {children}
          </a>
        ),
        code: ({ children, className }) => {
          const isBlock = typeof className === 'string';
          if (isBlock) {
            return (
              <pre
                style={{
                  background: '#0f1116',
                  padding: 12,
                  borderRadius: 10,
                  overflowX: 'auto',
                  margin: '12px 0 0',
                }}
              >
                <code>{children}</code>
              </pre>
            );
          }
          return (
            <code
              style={{
                background: '#0f1116',
                padding: '2px 6px',
                borderRadius: 6,
              }}
            >
              {children}
            </code>
          );
        },
        ul: ({ children }) => (
          <ul style={{ margin: '8px 0 0 20px' }}>{children}</ul>
        ),
        ol: ({ children }) => (
          <ol style={{ margin: '8px 0 0 20px' }}>{children}</ol>
        ),
        blockquote: ({ children }) => (
          <blockquote
            style={{
              margin: '8px 0 0',
              paddingLeft: 12,
              borderLeft: '2px solid #2b4bff',
              color: '#c0c7d2',
            }}
          >
            {children}
          </blockquote>
        ),
        strong: ({ children }) => (
          <strong style={{ color: '#f7f9ff' }}>{children}</strong>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function renderPart(part: UIMessagePart<UIDataTypes, UITools>, index: number) {
  if (part.type === 'text') {
    return (
      <div key={`text-${index}`} style={{ display: 'grid', gap: 8 }}>
        {renderText(part.text)}
      </div>
    );
  }

  if (isReasoningUIPart(part)) {
    return (
      <details
        key={`reasoning-${index}`}
        style={{
          marginTop: 0,
          padding: '10px 12px',
          borderRadius: 10,
          background: '#0f1116',
          color: '#cbd0d6',
          fontSize: 13,
        }}
      >
        <summary style={{ cursor: 'pointer' }}>Reasoning</summary>
        <div style={{ marginTop: 8 }}>{renderText(part.text)}</div>
      </details>
    );
  }

  if (isToolUIPart(part)) {
    if (part.type === 'dynamic-tool') {
      return (
        <div
          key={`tool-${part.toolCallId}-${index}`}
          style={{
            marginTop: 0,
            padding: '10px 12px',
            borderRadius: 10,
            background: '#0f1116',
            color: '#cbd0d6',
            fontSize: 13,
          }}
        >
          <div style={{ fontWeight: 600, color: '#f5f6f7' }}>
            Tool: {part.toolName} ({part.state})
          </div>
          {part.input !== undefined ? (
            <div>
              <div style={{ marginTop: 6, fontWeight: 600 }}>Input</div>
              {renderJson(part.input)}
            </div>
          ) : null}
          {part.output !== undefined ? (
            <div>
              <div style={{ marginTop: 6, fontWeight: 600 }}>Output</div>
              {renderJson(part.output)}
            </div>
          ) : null}
          {part.errorText ? (
            <div style={{ marginTop: 6, color: '#f7bfbf' }}>
              Error: {part.errorText}
            </div>
          ) : null}
        </div>
      );
    }

    const toolName = getStaticToolName(part);
    const toolInput = (part as { input?: unknown }).input;
    const toolOutput = (part as { output?: unknown }).output;
    const toolError = (part as { errorText?: string }).errorText;
    return (
      <div
        key={`tool-${toolName}-${index}`}
        style={{
          marginTop: 0,
          padding: '10px 12px',
          borderRadius: 10,
          background: '#0f1116',
          color: '#cbd0d6',
          fontSize: 13,
        }}
      >
        <div style={{ fontWeight: 600, color: '#f5f6f7' }}>
          Tool: {toolName}
        </div>
        {toolInput !== undefined ? (
          <div>
            <div style={{ marginTop: 6, fontWeight: 600 }}>Input</div>
            {renderJson(toolInput)}
          </div>
        ) : null}
        {toolOutput !== undefined ? (
          <div>
            <div style={{ marginTop: 6, fontWeight: 600 }}>Output</div>
            {renderJson(toolOutput)}
          </div>
        ) : null}
        {toolError ? (
          <div style={{ marginTop: 6, color: '#f7bfbf' }}>
            Error: {toolError}
          </div>
        ) : null}
      </div>
    );
  }

  if (part.type.startsWith('data-')) {
    return (
      <div
        key={`data-${index}`}
        style={{
          marginTop: 0,
          padding: '10px 12px',
          borderRadius: 10,
          background: '#0f1116',
          color: '#cbd0d6',
          fontSize: 13,
        }}
      >
        <div style={{ fontWeight: 600, color: '#f5f6f7' }}>{part.type}</div>
        {renderJson((part as { data?: unknown }).data)}
      </div>
    );
  }

  return null;
}

function renderMessageParts(message: UIMessage) {
  if (!message.parts?.length) {
    return null;
  }
  return message.parts.map((part, index) => renderPart(part, index));
}

export default function ChatView({
  title,
  description,
  placeholder,
  sessionId,
  initialMessages,
  transport,
}: ChatViewProps) {
  const [input, setInput] = useState('');
  const { messages, sendMessage, status, error } = useChat({
    id: sessionId,
    messages: initialMessages,
    transport,
  });
  const messageList = useMemo(() => messages ?? [], [messages]);

  return (
    <main
      style={{
        display: 'flex',
        minHeight: '100vh',
        flexDirection: 'column',
        gap: 24,
        padding: '32px 24px 40px',
        maxWidth: 920,
        margin: '0 auto',
      }}
    >
      <header>
        <h1 style={{ marginBottom: 8 }}>{title}</h1>
        <p style={{ margin: 0, color: '#cbd0d6' }}>{description}</p>
      </header>

      <section
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          padding: 20,
          background: '#14161c',
          borderRadius: 16,
          border: '1px solid #242830',
          minHeight: 360,
        }}
      >
        {error ? (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid #51252a',
              background: '#2a161a',
              color: '#f7bfbf',
              fontSize: 13,
            }}
          >
            Error: {error.message}
          </div>
        ) : null}
        {messageList.length === 0 ? (
          <p style={{ color: '#9aa3ad' }}>
            Start the conversation by sending a message below.
          </p>
        ) : (
          messageList.map((message) => (
            <div
              key={message.id}
              style={{
                alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '80%',
                padding: '12px 14px',
                borderRadius: 12,
                backgroundColor:
                  message.role === 'user' ? '#2b4bff' : '#1d2027',
                color: message.role === 'user' ? '#f7f9ff' : '#e6e8eb',
                lineHeight: 1.5,
                display: 'grid',
                gap: 14,
              }}
            >
              {renderMessageParts(message)}
            </div>
          ))
        )}
      </section>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!input.trim()) {
            return;
          }
          sendMessage({ text: input }, { body: { sessionId } });
          setInput('');
        }}
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          background: '#14161c',
          padding: 16,
          borderRadius: 16,
          border: '1px solid #242830',
        }}
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={placeholder}
          style={{
            flex: 1,
            padding: '12px 14px',
            background: '#0f1116',
            borderRadius: 12,
            border: '1px solid #2a2f3a',
            color: '#f5f6f7',
            fontSize: 16,
          }}
        />
        <button
          type="submit"
          disabled={status !== 'ready'}
          style={{
            padding: '12px 18px',
            borderRadius: 12,
            border: 'none',
            backgroundColor: status === 'ready' ? '#2b4bff' : '#2a2f3a',
            color: '#f5f6f7',
            fontWeight: 600,
            cursor: status === 'ready' ? 'pointer' : 'not-allowed',
          }}
        >
          Send
        </button>
      </form>
    </main>
  );
}
