import {
  getDefaultOpenAIClient,
  OpenAIResponsesModel,
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

const defaultClient: OpenAI | undefined = getDefaultOpenAIClient();
void defaultClient;
