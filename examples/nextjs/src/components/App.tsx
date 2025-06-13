import type { AgentInputItem } from '@openai/agents';
import { History } from '@/components/History';
import { Button } from '@/components/ui/Button';
import { useState, useRef, useEffect } from 'react';
import ArrowUpIcon from './icons/ArrowUpIcon';

export type AppProps = {
  title?: string;
  history?: AgentInputItem[];
  onSend: (message: string) => void;
};

export function App({ title = 'Agent Demo', history, onSend }: AppProps) {
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isLoading) {
      inputRef.current?.focus();
    }
  }, [isLoading]);

  const handleSend = async () => {
    if (!message.trim()) return;
    setIsLoading(true);
    const msg = message;
    setMessage('');
    await onSend(msg);
    setIsLoading(false);
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!message.trim()) return;
    await handleSend();
  };

  return (
    <div className="flex justify-center">
      <div className="p-4 md:max-h-screen overflow-hidden h-screen flex flex-col max-w-6xl w-full items-center">
        <header className="flex-none flex justify-between items-center pb-4 w-full max-w-6xl">
          <h1 className="text-2xl font-bold">{title}</h1>
        </header>
        <div className="flex flex-col h-full max-h-full max-w-4xl w-full">
          <div className="flex-1 overflow-y-auto">
            {history && history.length > 0 ? (
              <History history={history} />
            ) : (
              <div className="h-full flex items-center justify-center text-center text-gray-500">
                No history available
              </div>
            )}
          </div>
          <form
            className="gap-4 pt-4 flex flex-none w-full border border-gray-300 rounded-4xl p-4 focus-within:border-gray-500"
            onSubmit={handleSubmit}
          >
            <input
              type="text"
              className="flex-1 p-2 focus:outline-none"
              value={message}
              placeholder="Ask me anything..."
              onChange={(e) => setMessage(e.target.value)}
              disabled={isLoading}
              ref={inputRef}
            />
            <Button
              variant="primary"
              size="icon"
              type="submit"
              disabled={isLoading || !message.trim()}
            >
              <ArrowUpIcon />
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
