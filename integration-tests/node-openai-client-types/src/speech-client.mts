import OpenAI from 'openai';
import { OpenAISpeechProvider } from '@openai/agents/voice';
import { OpenAISpeechProvider as OwnerSpeechProvider } from '@openai/agents-codex/voice';
import facadeCjs = require('@openai/agents/voice');
import ownerCjs = require('@openai/agents-codex/voice');

const client = new OpenAI({ apiKey: 'synthetic' });
new OpenAISpeechProvider({ client });
new OwnerSpeechProvider({ client });
new facadeCjs.OpenAISpeechProvider({ client });
new ownerCjs.OpenAISpeechProvider({ client });
