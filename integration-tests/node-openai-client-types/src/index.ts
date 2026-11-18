import {
  getDefaultOpenAIClient,
  OpenAIResponsesModel,
  OpenAIProvider,
  OpenAIConversationsSession,
  OpenAIResponsesCompactionSession,
  type OpenAIProviderOptions,
  type OpenAIConversationsSessionOptions,
  type OpenAIResponsesCompactionSessionOptions,
  setDefaultOpenAIClient,
} from '@openai/agents';
import { OpenAI } from 'openai';

const client = new OpenAI({ apiKey: 'test' });

void client.responses.create({
  model: 'gpt-5.6-sol',
  input: 'test',
  service_tier: 'fast',
});

new OpenAIResponsesModel(client, 'gpt-5.5');
setDefaultOpenAIClient(client);

const providerOptions: OpenAIProviderOptions<OpenAI> = { openAIClient: client };
const conversationOptions: OpenAIConversationsSessionOptions<OpenAI> = {
  client,
};
const compactionOptions: OpenAIResponsesCompactionSessionOptions<OpenAI> = {
  client,
};
new OpenAIProvider(providerOptions);
new OpenAIConversationsSession(conversationOptions);
new OpenAIResponsesCompactionSession(compactionOptions);

const defaultClient: OpenAI | undefined = getDefaultOpenAIClient();
void defaultClient;

// Keep validating streaming and response results across SDK versions.
type InvalidResponseClient = Omit<OpenAI, 'responses'> & {
  responses: Omit<OpenAI['responses'], 'create'> & {
    create: () => Promise<undefined>;
  };
};
type EmptyChatChoice = { id: string; choices: { index: number }[] };
type InvalidChatClient = Omit<OpenAI, 'chat'> & {
  chat: {
    completions: {
      create(body: { stream?: false }): Promise<EmptyChatChoice>;
      create(body: { stream: true }): Promise<AsyncIterable<EmptyChatChoice>>;
    };
  };
};
type AcceptsClient<Client> = Client extends Parameters<
  typeof setDefaultOpenAIClient
>[0]
  ? true
  : false;
const invalidResults: [
  AcceptsClient<InvalidResponseClient>,
  AcceptsClient<InvalidChatClient>,
] = [false, false];
void invalidResults;
