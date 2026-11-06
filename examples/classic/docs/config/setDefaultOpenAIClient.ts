import { OpenAI } from 'openai';
import { setDefaultOpenAIClient } from '@openai/agents/classic';

const customClient = new OpenAI({ baseURL: '...', apiKey: '...' });
setDefaultOpenAIClient(customClient);
