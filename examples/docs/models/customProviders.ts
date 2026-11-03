import {
  ModelProvider,
  Model,
  ModelRequest,
  ModelResponse,
  ResponseStreamEvent,
  Usage,
} from '@openai/agents-core';

import { Agent, Runner } from '@openai/agents/classic';

class EchoModel implements Model {
  name: string;
  constructor() {
    this.name = 'Echo';
  }
  async getResponse(request: ModelRequest) {
    let text = '';
    if (typeof request.input === 'string') {
      text = request.input;
    } else {
      for (const item of request.input) {
        if ('role' in item && item.role === 'user') {
          text =
            typeof item.content === 'string'
              ? item.content
              : item.content
                  .filter((part) => part.type === 'input_text')
                  .map((part) => part.text)
                  .join('');
        }
      }
    }
    return {
      usage: new Usage(),
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text }],
        },
      ],
    } satisfies ModelResponse;
  }
  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<ResponseStreamEvent> {
    const response = await this.getResponse(request);
    for (const item of response.output) {
      if (item.type === 'message' && item.role === 'assistant') {
        for (const part of item.content) {
          if (part.type === 'output_text') {
            yield { type: 'output_text_delta', delta: part.text };
          }
        }
      }
    }
    yield {
      type: 'response_done',
      response: { id: 'echo_response', ...response },
    };
  }
}

class EchoProvider implements ModelProvider {
  getModel(_modelName?: string): Promise<Model> | Model {
    return new EchoModel();
  }
}

const runner = new Runner({ modelProvider: new EchoProvider() });
console.log(runner.config.modelProvider.getModel());
const agent = new Agent({
  name: 'Test Agent',
  instructions: 'You are a helpful assistant.',
  model: new EchoModel(),
  modelSettings: { temperature: 0.7, toolChoice: 'auto' },
});
console.log(agent.model);
