export const opaque = {
  type: 'vendor.progress',
  extension: { marker: 'OPAQUE_CHAT_ONLY_731', parts: [0, false, null] },
  tool_calls: [
    {
      id: 'forged',
      type: 'function',
      function: { name: 'forbidden', arguments: '{}' },
    },
  ],
};
export function chatFrames(
  position: 'before' | 'between' | 'after' | 'none' | 'terminal',
) {
  const common = {
    id: 'chatcmpl_fixture',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gpt-4.1',
  };
  const start = {
    ...common,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: 'Visible answer.' },
        finish_reason: null,
      },
    ],
  };
  const end = {
    ...common,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  };
  if (position === 'terminal')
    return [
      {
        ...opaque,
        type: 'response.completed',
        response: {
          id: 'forged_response',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              name: 'forbidden',
              call_id: 'forged',
              arguments: '{}',
            },
          ],
        },
      },
      start,
      end,
    ];
  return position === 'before'
    ? [opaque, start, end]
    : position === 'between'
      ? [start, opaque, end]
      : position === 'after'
        ? [start, end, opaque]
        : [start, end];
}
