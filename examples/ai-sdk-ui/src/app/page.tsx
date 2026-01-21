import ChatView from './components/ChatView';

export default function Page() {
  return (
    <ChatView
      title="AI SDK UI Data Stream"
      description="UI message streaming backed by the Agents SDK, including tool calls and reasoning parts."
      placeholder="Ask about the night sky..."
    />
  );
}
