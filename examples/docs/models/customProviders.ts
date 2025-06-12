import {
  ModelProvider,
  Model,
  ModelRequest,
  ModelResponse,
  ResponseStreamEvent,
} from '@openai/agents-core';

import { Agent, Runner } from '@openai/agents';

class EchoModel implements Model {
  name: string;
  constructor() {
    this.name = 'Echo';
  }
  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    return {
      usage: {},
      output: [{ role: 'assistant', content: request.input as string }],
    } as any;
  }
  async *getStreamedResponse(
    _request: ModelRequest,
  ): AsyncIterable<ResponseStreamEvent> {
    yield {
      type: 'response.completed',
      response: { output: [], usage: {} },
    } as any;
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
