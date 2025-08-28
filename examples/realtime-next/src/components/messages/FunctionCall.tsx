import React from 'react';

import ClockIcon from '@/components/icons/ClockIcon';
import {
  RealtimeMcpCallItem,
  RealtimeToolCallItem,
} from '@openai/agents/realtime';
import FunctionsIcon from '@/components/icons/FunctionsIcon';
import McpIcon from '../icons/McpIcon';

type FunctionCallMessageProps = {
  message: RealtimeToolCallItem | RealtimeMcpCallItem;
};

export function FunctionCallMessage({ message }: FunctionCallMessageProps) {
  let output = message?.output;
  try {
    if (message.output) {
      output = JSON.stringify(JSON.parse(message.output), null, 2);
    }
  } catch {
    output = message.output;
  }
  let input = message.arguments;
  try {
    if (message.arguments) {
      input = JSON.stringify(JSON.parse(message.arguments), null, 2);
    }
  } catch {
    input = message.arguments;
  }
  return (
    <div className="flex flex-col w-[70%] relative mb-[8px]">
      <div>
        <div className="flex flex-col text-sm rounded-[16px]">
          <div className="font-semibold p-3 pl-0 text-gray-700 rounded-b-none flex gap-2">
            <div className="flex gap-2 items-center text-blue-500 ml-[-8px] fill-blue-500">
              {message.type === 'mcp_call' ||
              message.type === 'mcp_tool_call' ? (
                <McpIcon width={16} height={16} />
              ) : (
                <FunctionsIcon width={16} height={16} />
              )}
              <div className="text-sm font-medium">
                {message.status === 'completed'
                  ? `Called ${message.name}`
                  : `Calling ${message.name}...`}
              </div>
            </div>
          </div>

          <div className="bg-[#fafafa] rounded-xl py-2 ml-4 mt-2">
            <div className="max-h-96 overflow-y-scroll text-xs border-b mx-6 p-2">
              <pre>{input}</pre>
            </div>
            <div className="max-h-80 overflow-y-scroll mx-6 p-2 text-xs">
              {output ? (
                <pre>{output}</pre>
              ) : (
                <div className="text-zinc-500 flex items-center gap-2 py-2">
                  <ClockIcon width={16} height={16} /> Waiting for result...
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
