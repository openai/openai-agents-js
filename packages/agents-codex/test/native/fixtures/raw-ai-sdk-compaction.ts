export const token = 'SYNTHETIC_COMPACTION_RAW_ONLY_731';
export const compact = {
  type: 'compaction',
  id: 'cmp_fixture',
  encrypted_content: token,
};
export const item = {
  type: 'message',
  id: 'msg_fixture',
  status: 'completed',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'raw answer', annotations: [] }],
};
export const response = {
  id: 'resp_fixture',
  object: 'response',
  status: 'completed',
  created_at: 1,
  model: 'gpt-4.1',
  output: [compact, item],
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
};
export function frames() {
  return [
    { type: 'response.created', response: { ...response, output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: compact },
    { type: 'response.output_item.done', output_index: 0, item: compact },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { ...item, content: [] },
    },
    {
      type: 'response.content_part.added',
      item_id: item.id,
      output_index: 1,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: item.id,
      output_index: 1,
      content_index: 0,
      delta: 'raw answer',
    },
    {
      type: 'response.output_text.done',
      item_id: item.id,
      output_index: 1,
      content_index: 0,
      text: 'raw answer',
    },
    {
      type: 'response.content_part.done',
      item_id: item.id,
      output_index: 1,
      content_index: 0,
      part: item.content[0],
    },
    { type: 'response.output_item.done', output_index: 1, item },
    { type: 'response.completed', response },
  ];
}
