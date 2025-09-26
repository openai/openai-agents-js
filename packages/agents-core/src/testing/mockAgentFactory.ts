import { Agent, AgentOptions } from '../agent';
import { Model, ModelRequest, ModelResponse } from '../model';
import { Usage } from '../usage';
import { UnknownContext } from '../types';
import * as protocol from '../types/protocol';

/**
 * Configuration for a mock response from an agent
 */
export interface MockResponse {
  /**
   * The text content of the response
   */
  text: string;
  /**
   * Optional tool calls to include in the response
   */
  toolCalls?: MockToolCall[];
  /**
   * Optional handoff to trigger
   */
  handoff?: string;
  /**
   * Optional delay in milliseconds before responding
   */
  delay?: number;
  /**
   * Whether this response should trigger an error
   */
  shouldError?: boolean;
  /**
   * Error message if shouldError is true
   */
  errorMessage?: string;
}

/**
 * Configuration for a mock tool call
 */
export interface MockToolCall {
  /**
   * Name of the tool to call
   */
  name: string;
  /**
   * Arguments to pass to the tool
   */
  arguments: Record<string, any>;
  /**
   * Expected result from the tool call
   */
  result?: string;
}

/**
 * Configuration for creating a mock agent
 */
export interface MockAgentConfig<TContext = UnknownContext>
  extends Partial<AgentOptions<TContext>> {
  /**
   * Predefined responses the agent will give in order
   */
  responses: MockResponse[];
  /**
   * Whether to cycle through responses or stop after the last one
   */
  cycleResponses?: boolean;
  /**
   * Default latency for all responses (can be overridden per response)
   */
  defaultLatency?: number;
}

/**
 * Mock model implementation that returns predefined responses
 */
class MockModel implements Model {
  private responseIndex = 0;

  constructor(
    private responses: MockResponse[],
    private cycleResponses: boolean = false,
    private defaultLatency: number = 0,
  ) {}

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    const response = this.getNextResponse();

    if (response.delay || this.defaultLatency) {
      await new Promise((resolve) =>
        setTimeout(resolve, response.delay || this.defaultLatency),
      );
    }

    if (response.shouldError) {
      throw new Error(response.errorMessage || 'Mock agent error');
    }

    const output: any[] = [];

    // Add tool calls if specified
    if (response.toolCalls) {
      for (const toolCall of response.toolCalls) {
        output.push({
          id: `mock-tool-${Math.random().toString(36).substr(2, 9)}`,
          type: 'function_call',
          name: toolCall.name,
          callId: `call-${Math.random().toString(36).substr(2, 9)}`,
          status: 'completed',
          arguments: JSON.stringify(toolCall.arguments),
        });
      }
    }

    // Add handoff if specified
    if (response.handoff) {
      output.push({
        id: `mock-handoff-${Math.random().toString(36).substr(2, 9)}`,
        type: 'function_call',
        name: response.handoff,
        callId: `handoff-${Math.random().toString(36).substr(2, 9)}`,
        status: 'completed',
        arguments: '{}',
      });
    }

    // Add text message
    output.push({
      id: `mock-msg-${Math.random().toString(36).substr(2, 9)}`,
      status: 'completed',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: response.text,
          providerData: {
            annotations: [],
          },
        },
      ],
    });

    return {
      output,
      usage: new Usage(),
    };
  }

  async *getStreamedResponse(
    _request: ModelRequest,
  ): AsyncIterable<protocol.StreamEvent> {
    const response = this.getNextResponse();

    if (response.delay || this.defaultLatency) {
      await new Promise((resolve) =>
        setTimeout(resolve, response.delay || this.defaultLatency),
      );
    }

    if (response.shouldError) {
      throw new Error(response.errorMessage || 'Mock agent streaming error');
    }

    // Yield response started event
    yield {
      type: 'response_started',
      response: {
        id: `mock-response-${Math.random().toString(36).substr(2, 9)}`,
      },
    } as protocol.StreamEvent;

    // Yield tool calls if specified
    if (response.toolCalls) {
      for (const toolCall of response.toolCalls) {
        yield {
          type: 'model',
          event: {
            type: 'response_item_created',
            item: {
              id: `mock-tool-${Math.random().toString(36).substr(2, 9)}`,
              type: 'function_call',
              name: toolCall.name,
              callId: `call-${Math.random().toString(36).substr(2, 9)}`,
              status: 'in_progress',
              arguments: JSON.stringify(toolCall.arguments),
            },
          },
        } as protocol.StreamEvent;
      }
    }

    // Yield handoff if specified
    if (response.handoff) {
      yield {
        type: 'model',
        event: {
          type: 'response_item_created',
          item: {
            id: `mock-handoff-${Math.random().toString(36).substr(2, 9)}`,
            type: 'function_call',
            name: response.handoff,
            callId: `handoff-${Math.random().toString(36).substr(2, 9)}`,
            status: 'in_progress',
            arguments: '{}',
          },
        },
      } as protocol.StreamEvent;
    }

    // Yield text content in chunks
    const text = response.text;
    const chunkSize = Math.max(1, Math.floor(text.length / 5));
    for (let i = 0; i < text.length; i += chunkSize) {
      const chunk = text.slice(i, i + chunkSize);
      yield {
        type: 'output_text_delta',
        delta: chunk,
      } as protocol.StreamEvent;

      // Small delay between chunks to simulate streaming
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Yield response completed event
    yield {
      type: 'response_done',
      response: {
        id: `mock-response-${Math.random().toString(36).substr(2, 9)}`,
        usage: {
          requests: 1,
          inputTokens: 10,
          outputTokens: text.length,
          totalTokens: 10 + text.length,
        },
        output: [],
      },
    } as protocol.StreamEvent;
  }

  private getNextResponse(): MockResponse {
    if (this.responseIndex >= this.responses.length) {
      if (this.cycleResponses) {
        this.responseIndex = 0;
      } else {
        // Return the last response if we've run out
        return (
          this.responses[this.responses.length - 1] || {
            text: 'No more responses',
          }
        );
      }
    }

    return this.responses[this.responseIndex++];
  }

  /**
   * Reset the response index to start from the beginning
   */
  reset(): void {
    this.responseIndex = 0;
  }

  /**
   * Get the current response index
   */
  getCurrentIndex(): number {
    return this.responseIndex;
  }
}

/**
 * Factory for creating mock agents with predefined responses for testing
 */
export class MockAgentFactory {
  /**
   * Create a mock agent with predefined responses
   */
  static createAgent<TContext = UnknownContext>(
    config: MockAgentConfig<TContext>,
  ): Agent<TContext> {
    const mockModel = new MockModel(
      config.responses,
      config.cycleResponses,
      config.defaultLatency,
    );

    const agentConfig: AgentOptions<TContext> = {
      name: config.name || 'MockAgent',
      instructions: config.instructions || 'I am a mock agent for testing',
      handoffDescription: config.handoffDescription || 'Mock agent for testing',
      model: mockModel,
      modelSettings: config.modelSettings || {},
      tools: config.tools || [],
      mcpServers: config.mcpServers || [],
      inputGuardrails: config.inputGuardrails || [],
      outputGuardrails: config.outputGuardrails || [],
      outputType: config.outputType || 'text',
      toolUseBehavior: config.toolUseBehavior || 'run_llm_again',
      resetToolChoice: config.resetToolChoice ?? true,
      handoffs: config.handoffs || [],
    };

    return new Agent(agentConfig);
  }

  /**
   * Create a mock agent that always responds with the same text
   */
  static createSimpleAgent(name: string, response: string): Agent {
    return this.createAgent({
      name,
      responses: [{ text: response }],
      cycleResponses: true,
    });
  }

  /**
   * Create a mock agent that fails with an error
   */
  static createFailingAgent(name: string, errorMessage?: string): Agent {
    return this.createAgent({
      name,
      responses: [
        {
          text: 'This should not be seen',
          shouldError: true,
          errorMessage: errorMessage || 'Mock agent failure',
        },
      ],
    });
  }

  /**
   * Create a mock agent with tool calls
   */
  static createAgentWithTools(
    name: string,
    toolCalls: MockToolCall[],
    finalResponse: string = 'Tool calls completed',
  ): Agent {
    return this.createAgent({
      name,
      responses: [
        {
          text: 'I will use tools',
          toolCalls,
        },
        {
          text: finalResponse,
        },
      ],
    });
  }

  /**
   * Create a mock agent that triggers a handoff
   */
  static createAgentWithHandoff(
    name: string,
    handoffTarget: string,
    message: string = 'Handing off to another agent',
  ): Agent {
    return this.createAgent({
      name,
      responses: [
        {
          text: message,
          handoff: handoffTarget,
        },
      ],
    });
  }

  /**
   * Create a mock agent with multiple conversation turns
   */
  static createConversationalAgent(name: string, responses: string[]): Agent {
    return this.createAgent({
      name,
      responses: responses.map((text) => ({ text })),
    });
  }

  /**
   * Create a mock agent with latency simulation
   */
  static createSlowAgent(
    name: string,
    response: string,
    latencyMs: number,
  ): Agent {
    return this.createAgent({
      name,
      responses: [{ text: response, delay: latencyMs }],
    });
  }
}
