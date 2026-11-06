import { openai } from '@ai-sdk/openai';
import { aisdk } from '@openai/agents-extensions/ai-sdk';

const model = aisdk(openai('gpt-5.4'), {
  transformOutputText(text) {
    return text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)?.[1]?.trim() ?? text;
  },
});
