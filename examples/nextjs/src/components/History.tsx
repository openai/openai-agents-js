import type { AgentInputItem } from '@openai/agents';
import { TextMessage } from './messages/TextMessage';
import { FunctionCallMessage } from './messages/FunctionCall';

export type HistoryProps = {
  history: AgentInputItem[];
};

export function History({ history }: HistoryProps) {
  return (
    <div
      className="overflow-y-scroll pl-4 flex-1 rounded-lg bg-white space-y-4"
      id="chatHistory"
    >
      {history.map((item, idx) => {
        if (item.type === 'function_call') {
          return <FunctionCallMessage message={item} key={item.id} />;
        }

        if (item.type === 'message') {
          if (typeof item.content === 'string') {
            return (
              <TextMessage
                text={item.content}
                isUser={item.role === 'user'}
                key={item?.id ?? JSON.stringify(item.content) + idx}
              />
            );
          }

          return (
            <TextMessage
              text={
                item.content.length > 0
                  ? item.content
                      .map((content) => {
                        if (
                          content.type === 'input_text' ||
                          content.type === 'output_text'
                        ) {
                          return content.text;
                        }
                        if (content.type === 'audio') {
                          return content.transcript ?? '⚫︎⚫︎⚫︎';
                        }

                        if (content.type === 'refusal') {
                          return content.refusal;
                        }

                        return '';
                      })
                      .join('\n')
                  : '⚫︎⚫︎⚫︎'
              }
              isUser={item.role === 'user'}
              key={item?.id ?? JSON.stringify(item.content) + idx}
            />
          );
        }

        return null;
      })}
    </div>
  );
}
