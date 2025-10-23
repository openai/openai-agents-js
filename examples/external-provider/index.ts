import { Agent, Runner, OpenAIChatCompletionsModel } from '@openai/agents';
import { OpenAI } from 'openai';

const BASE_URL = process.env.EXAMPLE_BASE_URL || '';
const API_KEY = process.env.EXAMPLE_API_KEY || '';
const MODEL_NAME = process.env.EXAMPLE_MODEL_NAME || '';

const client = new OpenAI({
    apiKey: API_KEY,
    baseURL: BASE_URL, // external endpoint
});

const model = new OpenAIChatCompletionsModel(client, MODEL_NAME);

async function main() {
    const agent = new Agent({
        name: 'Assistant',
        instructions: 'You are a helpful AI assistant.',
    });

    const runner = new Runner({ model });
    const result = await runner.run(agent, "What's 2 + 2?");
    console.log(result.finalOutput);
}

main();
