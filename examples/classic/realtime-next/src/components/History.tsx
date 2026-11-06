import { RealtimeItem } from '@openai/agents/realtime';
import { TextMessage } from './messages/TextMessage';
import { FunctionCallMessage } from './messages/FunctionCall';

export type HistoryProps = {
  history: RealtimeItem[];
};

export function History({ history }: HistoryProps) {
  return (
    <div
      className="overflow-y-scroll pl-4 flex-1 rounded-lg bg-white space-y-4 max-w-2xl"
      id="chatHistory"
    >
      {history.map((item) => {
        if (item.type === 'function_call') {
          return <FunctionCallMessage message={item} key={item.itemId} />;
        }

        if (item.type === 'mcp_call' || item.type === 'mcp_tool_call') {
          return <FunctionCallMessage message={item} key={item.itemId} />;
        }

        if (item.type === 'message') {
          return (
            <TextMessage
              text={
                item.content.length > 0
                  ? item.content
                      .map((content) => {
                        if (
                          content.type === 'output_text' ||
                          content.type === 'input_text'
                        ) {
                          return content.text;
                        }
                        if (
                          content.type === 'input_audio' ||
                          content.type === 'output_audio'
                        ) {
                          return content.transcript ?? '⚫︎⚫︎⚫︎';
                        }
                        return '';
                      })
                      .join('\n')
                  : '⚫︎⚫︎⚫︎'
              }
              isUser={item.role === 'user'}
              key={item.itemId}
            />
          );
        }

        return null;
      })}
    </div>
  );
}
