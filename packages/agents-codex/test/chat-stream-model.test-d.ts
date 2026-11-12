import {
  ChatCompletionsModel,
  ResponsesModel,
  type ChatCompletionsModelOptions,
  type NativeModel,
} from '@openai/agents';

const client = { chat: { completions: { create: async () => ({}) } } };
const options: ChatCompletionsModelOptions = {
  stream: true,
  includeUsage: false,
  requestOptions: { headers: { 'X-Application': 'example' } },
};
const model: NativeModel = new ChatCompletionsModel(client, 'example', options);
void model;
new ChatCompletionsModel(client, undefined, { stream: false });
// @ts-expect-error The stream option has been accepting a boolean.
new ChatCompletionsModel(client, undefined, { stream: 'true' });
// @ts-expect-error The usage option has been accepting a boolean.
new ChatCompletionsModel(client, undefined, { includeUsage: null });
// @ts-expect-error Chat streaming controls have been belonging to the Chat adapter.
new ResponsesModel({}, undefined, { includeUsage: false });
