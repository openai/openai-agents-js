import { OpenAIResponsesModel } from '@openai/agents';
import { OpenAI } from 'openai';

const client = new OpenAI({ apiKey: 'test' });

new OpenAIResponsesModel(client, 'gpt-5.5');
