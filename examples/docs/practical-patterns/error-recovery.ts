/**
 * Practical Error Recovery Patterns
 *
 * This file demonstrates real-world error recovery patterns
 * that can be used in production OpenAI Agent applications.
 */

import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';

// Example 1: Customer Service Agent with Graceful Degradation
export async function createCustomerServiceAgent() {
  const primaryAgent = new Agent({
    name: 'customer-service-primary',
    instructions:
      'You are a helpful customer service agent. Provide detailed, accurate responses.',
    model: 'gpt-4',
  });

  const fallbackAgent = new Agent({
    name: 'customer-service-fallback',
    instructions:
      'You are a basic customer service agent. Provide simple, helpful responses.',
    model: 'gpt-3.5-turbo',
  });

  const handleCustomerQuery = async (query: string) => {
    try {
      // Try primary agent first
      const result = await run(primaryAgent, query);
      return {
        response: result.finalOutput,
        agent: 'primary',
        confidence: 'high',
      };
    } catch (error) {
      console.warn(
        'Primary agent failed, falling back to secondary:',
        (error as Error).message,
      );

      try {
        // Fallback to simpler agent
        const result = await run(fallbackAgent, query);
        return {
          response: result.finalOutput,
          agent: 'fallback',
          confidence: 'medium',
        };
      } catch (fallbackError) {
        // Final fallback - return helpful error message
        return {
          response:
            "I'm experiencing technical difficulties right now. Please try again in a few minutes or contact support directly.",
          agent: 'error-handler',
          confidence: 'low',
          error: (fallbackError as Error).message,
        };
      }
    }
  };

  return { handleCustomerQuery };
}

// Example 2: Multi-Step Workflow with Checkpointing
export class WorkflowManager {
  private checkpoints = new Map<string, any>();

  async executeResearchWorkflow(topic: string, workflowId: string) {
    const steps = [
      { name: 'research', agent: this.createResearchAgent() },
      { name: 'analyze', agent: this.createAnalysisAgent() },
      { name: 'summarize', agent: this.createSummaryAgent() },
    ];

    let results: any = {};
    let currentStep = 0;

    // Check for existing checkpoint
    const checkpoint = this.checkpoints.get(workflowId);
    if (checkpoint) {
      results = checkpoint.results;
      currentStep = checkpoint.currentStep;
      console.log(`Resuming workflow from step ${currentStep}`);
    }

    for (let i = currentStep; i < steps.length; i++) {
      const step = steps[i];

      try {
        console.log(`Executing step: ${step.name}`);

        const input =
          i === 0 ? topic : this.prepareStepInput(step.name, results);
        const result = await this.executeStepWithRetry(step.agent, input);

        results[step.name] = result;

        // Create checkpoint after each successful step
        this.checkpoints.set(workflowId, {
          results,
          currentStep: i + 1,
          timestamp: new Date(),
        });
      } catch (error) {
        console.error(`Step ${step.name} failed:`, error);

        // Try to recover or provide partial results
        if (i > 0) {
          console.log('Returning partial results from completed steps');
          return {
            success: false,
            partialResults: results,
            failedStep: step.name,
            error: (error as Error).message,
          };
        } else {
          throw new Error(
            `Workflow failed at first step: ${(error as Error).message}`,
          );
        }
      }
    }

    // Clean up checkpoint on success
    this.checkpoints.delete(workflowId);

    return {
      success: true,
      results,
      completedSteps: steps.length,
    };
  }

  private async executeStepWithRetry(
    agent: Agent,
    input: string,
    maxRetries = 2,
  ) {
    let lastError: Error;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        const result = await run(agent, input);
        return result.finalOutput;
      } catch (error) {
        lastError = error as Error;

        if (attempt <= maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
          console.log(
            `Step attempt ${attempt} failed, retrying in ${delay}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError!;
  }

  private prepareStepInput(stepName: string, previousResults: any): string {
    switch (stepName) {
      case 'analyze':
        return `Please analyze this research data: ${previousResults.research}`;
      case 'summarize':
        return `Please create a summary based on this research: ${previousResults.research} and analysis: ${previousResults.analyze}`;
      default:
        return '';
    }
  }

  private createResearchAgent() {
    return new Agent({
      name: 'researcher',
      instructions:
        'Research the given topic thoroughly and provide detailed information.',
      model: 'gpt-4',
    });
  }

  private createAnalysisAgent() {
    return new Agent({
      name: 'analyzer',
      instructions:
        'Analyze the provided research data and identify key insights.',
      model: 'gpt-4',
    });
  }

  private createSummaryAgent() {
    return new Agent({
      name: 'summarizer',
      instructions: 'Create a concise summary of the research and analysis.',
      model: 'gpt-3.5-turbo',
    });
  }
}

// Example 3: Tool Failure Recovery
export function createRobustToolAgent() {
  const robustWeatherTool = tool({
    name: 'get_weather',
    description: 'Get current weather for a location with fallback handling',
    parameters: z.object({
      location: z.string().describe('City name'),
    }),
    execute: async ({ location }) => {
      const maxRetries = 3;
      const fallbackSources = [
        async () => {
          // Simulate API failures
          if (Math.random() < 0.3) {
            throw new Error('Weather API temporarily unavailable');
          }
          return `Weather in ${location}: Sunny, 72°F`;
        },
        async () =>
          `Weather in ${location}: Unable to get current data, but typically mild climate`, // Fallback response
        async () =>
          `I'm unable to get weather data for ${location} right now. Please check a weather website.`, // Final fallback
      ];

      for (let i = 0; i < fallbackSources.length; i++) {
        try {
          return await fallbackSources[i]();
        } catch (error) {
          if (i === fallbackSources.length - 1) {
            throw error; // Re-throw if all sources failed
          }

          console.warn(
            `Weather source ${i + 1} failed, trying next source:`,
            (error as Error).message,
          );

          // Add delay before trying next source
          if (i < fallbackSources.length - 2) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      }
    },
  });

  return new Agent({
    name: 'weather-agent',
    instructions:
      'Help users get weather information. If weather data is unavailable, provide helpful alternatives.',
    tools: [robustWeatherTool],
  });
}

// Example 4: Context-Aware Error Handling
export class ContextAwareErrorHandler {
  private errorPatterns = new Map<
    string,
    (error: Error, context: any) => string
  >();

  constructor() {
    this.setupErrorPatterns();
  }

  private setupErrorPatterns() {
    // Rate limit errors
    this.errorPatterns.set('rate_limit', (error, context) => {
      const waitTime = this.extractWaitTime(error.message) || 60;
      return `I'm currently experiencing high demand. Please wait ${waitTime} seconds and try again. Your request about "${context.userInput}" is important to me.`;
    });

    // Model unavailable errors
    this.errorPatterns.set('model_unavailable', (error, context) => {
      return `The AI model is temporarily unavailable. I'll try to help you with "${context.userInput}" using an alternative approach.`;
    });

    // Tool errors
    this.errorPatterns.set('tool_error', (error, context) => {
      return `I encountered an issue with the ${context.toolName} tool. Let me try to help you with "${context.userInput}" in a different way.`;
    });

    // Generic errors
    this.errorPatterns.set('generic', (error, context) => {
      return `I encountered an unexpected issue while processing your request about "${context.userInput}". Let me try a different approach.`;
    });
  }

  handleError(error: Error, context: any): string {
    const errorType = this.classifyError(error);
    const handler =
      this.errorPatterns.get(errorType) || this.errorPatterns.get('generic')!;

    return handler(error, context);
  }

  private classifyError(error: Error): string {
    const message = error.message.toLowerCase();

    if (message.includes('rate limit') || message.includes('quota')) {
      return 'rate_limit';
    } else if (message.includes('model') && message.includes('unavailable')) {
      return 'model_unavailable';
    } else if (message.includes('tool')) {
      return 'tool_error';
    } else {
      return 'generic';
    }
  }

  private extractWaitTime(message: string): number | null {
    const match = message.match(/wait (\d+) seconds?/i);
    return match ? parseInt(match[1]) : null;
  }
}

// Example 5: Production-Ready Agent with Comprehensive Error Handling
export function createProductionAgent() {
  const errorHandler = new ContextAwareErrorHandler();

  const agent = new Agent({
    name: 'production-agent',
    instructions:
      'You are a helpful assistant. Always try to provide value even when facing technical difficulties.',
    model: 'gpt-4',
  });

  const productionRun = async (input: string, options: any = {}) => {
    const context = {
      userInput: input,
      timestamp: new Date(),
      sessionId: options.sessionId || 'unknown',
    };

    try {
      // Add request logging
      console.log(
        `[${context.sessionId}] Processing request: ${input.substring(0, 100)}...`,
      );

      const result = await run(agent, input, options);

      // Add response logging
      console.log(`[${context.sessionId}] Request completed successfully`);

      return {
        success: true,
        response: result.finalOutput,
        metadata: {
          model: 'gpt-4',
          timestamp: context.timestamp,
          sessionId: context.sessionId,
        },
      };
    } catch (error) {
      // Log error with context
      console.error(`[${context.sessionId}] Request failed:`, {
        error: (error as Error).message,
        input: input.substring(0, 100),
        timestamp: context.timestamp,
      });

      // Generate user-friendly error message
      const userMessage = errorHandler.handleError(error as Error, context);

      return {
        success: false,
        response: userMessage,
        error: (error as Error).message,
        metadata: {
          errorType: 'agent_error',
          timestamp: context.timestamp,
          sessionId: context.sessionId,
        },
      };
    }
  };

  return { agent, run: productionRun };
}

// Usage examples
export async function demonstrateErrorRecovery() {
  console.log('=== Error Recovery Pattern Examples ===\n');

  // 1. Customer service with fallback
  console.log('1. Testing customer service with fallback...');
  const { handleCustomerQuery } = await createCustomerServiceAgent();
  const customerResult = await handleCustomerQuery(
    'How do I return a product?',
  );
  console.log('Customer service result:', customerResult);
  console.log();

  // 2. Multi-step workflow
  console.log('2. Testing multi-step workflow...');
  const workflowManager = new WorkflowManager();
  const workflowResult = await workflowManager.executeResearchWorkflow(
    'artificial intelligence',
    'workflow-1',
  );
  console.log(
    'Workflow result:',
    workflowResult.success ? 'Success' : 'Partial success',
  );
  console.log();

  // 3. Robust tool usage
  console.log('3. Testing robust tool agent...');
  const weatherAgent = createRobustToolAgent();
  const weatherResult = await run(
    weatherAgent,
    "What's the weather like in San Francisco?",
  );
  console.log('Weather result:', weatherResult.finalOutput);
  console.log();

  // 4. Production agent
  console.log('4. Testing production agent...');
  const { run: productionRun } = createProductionAgent();
  const prodResult = await productionRun('Tell me about machine learning', {
    sessionId: 'demo-session',
  });
  console.log(
    'Production result:',
    prodResult.success ? 'Success' : 'Handled error',
  );
  console.log();
}

// Run examples if this file is executed directly
if (require.main === module) {
  demonstrateErrorRecovery().catch(console.error);
}
