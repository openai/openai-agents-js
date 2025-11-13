import { z } from 'zod';
import { Agent } from '../src/agent';
import {
  Model,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from '../src/model';
import { tool } from '../src/tool';
import type { Computer } from '../src/computer';
import type { Environment } from '../src/computer';
import type { Shell, ShellAction, ShellResult } from '../src/shell';
import type {
  Editor,
  ApplyPatchOperation,
  ApplyPatchResult,
} from '../src/editor';
import * as protocol from '../src/types/protocol';
import { Usage } from '../src/usage';
import { Span, Trace, TracingExporter } from '../src';

export const TEST_MODEL_MESSAGE: protocol.AssistantMessageItem = {
  id: '123',
  status: 'completed' as const,
  type: 'message' as const,
  role: 'assistant' as const,
  content: [
    {
      type: 'output_text' as const,
      text: 'Hello World',
      providerData: {
        annotations: [],
      },
    },
  ],
};

export function fakeModelMessage(text: string): protocol.AssistantMessageItem {
  return {
    ...TEST_MODEL_MESSAGE,
    content: [
      {
        type: 'output_text' as const,
        text,
        providerData: {
          annotations: [],
        },
      },
    ],
  };
}

export const TEST_MODEL_FUNCTION_CALL: protocol.FunctionCallItem = {
  id: '123',
  type: 'function_call' as const,
  name: 'test',
  callId: '123',
  status: 'completed',
  arguments: '{"test": "test"}',
};

export const TEST_MODEL_RESPONSE_WITH_FUNCTION: ModelResponse = {
  output: [{ ...TEST_MODEL_FUNCTION_CALL }, { ...TEST_MODEL_MESSAGE }],
  usage: new Usage(),
};

export const TEST_MODEL_RESPONSE_BASIC: ModelResponse = {
  output: [{ ...TEST_MODEL_MESSAGE }],
  usage: new Usage(),
};

export const TEST_AGENT = new Agent({
  name: 'TestAgent',
  instructions: 'Test instructions',
  handoffDescription: 'Test handoff description',
  handoffs: [],
  model: 'gpt-4o',
  modelSettings: {
    temperature: 0.5,
    maxTokens: 100,
  },
});

export const TEST_TOOL = tool({
  name: 'test',
  description: 'Test tool',
  parameters: z.object({
    test: z.string(),
  }),
  execute: async (_input: any) => {
    return 'Hello World';
  },
});

/**
 * Minimal fake computer implementation for tests.
 */
export class FakeComputer implements Computer {
  environment: Environment = 'mac';
  dimensions: [number, number] = [1, 1];

  async screenshot(): Promise<string> {
    return 'img';
  }
  async click(_x: number, _y: number, _button: any): Promise<void> {}
  async doubleClick(_x: number, _y: number): Promise<void> {}
  async drag(_path: [number, number][]): Promise<void> {}
  async keypress(_keys: string[]): Promise<void> {}
  async move(_x: number, _y: number): Promise<void> {}
  async scroll(
    _x: number,
    _y: number,
    _scrollX: number,
    _scrollY: number,
  ): Promise<void> {}
  async type(_text: string): Promise<void> {}
  async wait(): Promise<void> {}
}

export class FakeModel implements Model {
  constructor(private _responses: ModelResponse[] = []) {}

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    const response = this._responses.shift();
    if (!response) {
      throw new Error('No response found');
    }
    return response;
  }

  /* eslint-disable require-yield */
  async *getStreamedResponse(
    _request: ModelRequest,
  ): AsyncIterable<protocol.StreamEvent> {
    throw new Error('Not implemented');
  }
}

export class FakeModelProvider implements ModelProvider {
  async getModel(_name: string): Promise<Model> {
    return new FakeModel([TEST_MODEL_RESPONSE_BASIC]);
  }
}

export class FakeTracingExporter implements TracingExporter {
  export(_items: (Trace | Span<any>)[], _signal?: AbortSignal): Promise<void> {
    return Promise.resolve();
  }
}

export class FakeShell implements Shell {
  public readonly calls: ShellAction[] = [];
  public result: ShellResult = {
    output: [
      {
        stdout: 'shell result',
        stderr: '',
        outcome: { type: 'exit', exitCode: 0 },
      },
    ],
  };
  public error: Error | null = null;

  async run(action: ShellAction): Promise<ShellResult> {
    this.calls.push(action);
    if (this.error) {
      throw this.error;
    }
    return this.result;
  }
}

export class FakeEditor implements Editor {
  public readonly operations: ApplyPatchOperation[] = [];
  public result: ApplyPatchResult | void = { status: 'completed' };
  public errors: Partial<Record<ApplyPatchOperation['type'], Error>> = {};

  async createFile(
    operation: Extract<ApplyPatchOperation, { type: 'create_file' }>,
  ): Promise<ApplyPatchResult | void> {
    return this.handle(operation);
  }

  async updateFile(
    operation: Extract<ApplyPatchOperation, { type: 'update_file' }>,
  ): Promise<ApplyPatchResult | void> {
    return this.handle(operation);
  }

  async deleteFile(
    operation: Extract<ApplyPatchOperation, { type: 'delete_file' }>,
  ): Promise<ApplyPatchResult | void> {
    return this.handle(operation);
  }

  private async handle(
    operation: ApplyPatchOperation,
  ): Promise<ApplyPatchResult | void> {
    this.operations.push(operation);
    const error = this.errors[operation.type];
    if (error) {
      throw error;
    }
    return this.result;
  }
}
