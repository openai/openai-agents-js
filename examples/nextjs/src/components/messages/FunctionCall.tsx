import React from 'react';

import ClockIcon from '@/components/icons/ClockIcon';
import FunctionsIcon from '@/components/icons/FunctionsIcon';

export type ProcessedFunctionCallItem = {
  type: 'function_call';
  name: string;
  arguments: string;
  id: string;
  callId: string;
  output?: string;
  status: 'completed' | 'in_progress';
};

type FunctionCallMessageProps = {
  message: ProcessedFunctionCallItem;
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
  return (
    <div className="flex flex-col w-[70%] relative mb-[8px]">
      <div>
        <div className="flex flex-col text-sm rounded-[16px]">
          <div className="font-semibold p-3 pl-0 text-gray-700 rounded-b-none flex gap-2">
            <div className="flex gap-2 items-center text-blue-500 ml-[-8px] fill-blue-500">
              <FunctionsIcon width={16} height={16} />
              <div className="text-sm font-medium">
                {message.status === 'completed'
                  ? `Called ${message.name}`
                  : `Calling ${message.name}...`}
              </div>
            </div>
          </div>

          <div className="bg-[#fafafa] rounded-xl py-2 ml-4 mt-2">
            <div className="max-h-96 overflow-y-scroll text-xs border-b mx-6 p-2">
              <pre>
                {JSON.stringify(JSON.parse(message.arguments), null, 2)}
              </pre>
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
