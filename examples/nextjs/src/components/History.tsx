import type { AgentInputItem } from '@openai/agents';
import { TextMessage } from './messages/TextMessage';
import {
  FunctionCallMessage,
  ProcessedFunctionCallItem,
} from './messages/FunctionCall';
import { useMemo } from 'react';

export type HistoryProps = {
  history: AgentInputItem[];
};

export type ProcessedMessageItem = {
  type: 'message';
  role: 'user' | 'assistant';
  content: string;
  id: string;
};

type ProcessedItem = ProcessedMessageItem | ProcessedFunctionCallItem;

function processItems(items: AgentInputItem[]): ProcessedItem[] {
  const processedItems: ProcessedItem[] = [];

  for (const item of items) {
    if (item.type === 'function_call') {
      processedItems.push({
        type: 'function_call',
        name: item.name,
        arguments: item.arguments,
        id: item.id ?? '',
        callId: item.callId ?? '',
        status: 'in_progress',
      });
    }

    if (item.type === 'function_call_result') {
      const index = processedItems.findIndex(
        (i) => i.type === 'function_call' && item.callId === i.callId,
      );

      if (index !== -1 && processedItems[index].type === 'function_call') {
        const outputValue = item.output as
          | string
          | { type: 'text'; text: string }
          | { type: 'image'; data?: string }
          | undefined;

        processedItems[index].output =
          typeof outputValue === 'string'
            ? outputValue
            : outputValue?.type === 'text'
              ? outputValue.text
              : outputValue?.type === 'image'
                ? (outputValue.data ?? '')
                : '';
        processedItems[index].status = 'completed';
      }
    }

    if (item.type === 'message') {
      processedItems.push({
        type: 'message',
        role: item.role === 'system' ? 'assistant' : item.role,
        content:
          typeof item.content === 'string'
            ? item.content
            : item.content
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
                .join('\n') || '⚫︎⚫︎⚫︎',
        id: item.id ?? '',
      });
    }
  }

  return processedItems;
}

export function History({ history }: HistoryProps) {
  const processedItems = useMemo(() => processItems(history), [history]);

  return (
    <div
      className="overflow-y-scroll pl-4 flex-1 rounded-lg bg-white space-y-4"
      id="chatHistory"
    >
      {processedItems.map((item, idx) => {
        if (item.type === 'function_call') {
          return <FunctionCallMessage message={item} key={item.id ?? idx} />;
        }

        if (item.type === 'message') {
          return (
            <TextMessage
              text={item.content}
              isUser={item.role === 'user'}
              key={item.id || idx}
            />
          );
        }

        return null;
      })}
    </div>
  );
}
