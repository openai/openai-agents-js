import { openai } from '@ai-sdk/openai';
import { aisdk } from '@openai/agents-extensions/ai-sdk';

const model = aisdk(openai('gpt-5-mini'));
