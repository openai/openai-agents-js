/**
 * Retry Pattern Examples for OpenAI Agents
 *
 * This file demonstrates various retry patterns that can be used
 * with OpenAI Agents to handle transient failures and improve
 * reliability in agent workflows.
 */

import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';

// Basic exponential backoff retry pattern
export class RetryPattern {
  constructor(
    private maxAttempts: number = 3,
    private baseDelay: number = 1000,
    private maxDelay: number = 10000,
    private backoffMultiplier: number = 2,
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        if (attempt === this.maxAttempts) {
          throw new Error(
            `Operation failed after ${this.maxAttempts} attempts. Last error: ${lastError.message}`,
          );
        }

        const delay = Math.min(
          this.baseDelay * Math.pow(this.backoffMultiplier, attempt - 1),
          this.maxDelay,
        );

        console.log(`Attempt ${attempt} failed, retrying in ${delay}ms...`);
        await this.sleep(delay);
      }
    }

    throw lastError!;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Circuit breaker pattern for agent operations
export class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private failureThreshold: number = 5,
    private recoveryTimeout: number = 60000,
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.recoveryTimeout) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open - operation not attempted');
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
    }
  }

  getState(): string {
    return this.state;
  }
}

// Example: Agent with retry logic
export async function createResilientAgent() {
  const retryPattern = new RetryPattern(3, 1000, 5000);
  const circuitBreaker = new CircuitBreaker(3, 30000);

  const agent = new Agent({
    name: 'resilient-agent',
    instructions: 'You are a resilient agent that handles failures gracefully.',
    model: 'gpt-4',
  });

  // Wrap agent run with retry logic
  const resilientRun = async (input: string) => {
    return await retryPattern.execute(async () => {
      return await circuitBreaker.execute(async () => {
        return await run(agent, input);
      });
    });
  };

  return { agent, resilientRun };
}

// Example: Tool call with retry
export async function toolCallWithRetry() {
  const retryPattern = new RetryPattern(2, 500, 2000);

  const resilientWeatherTool = tool({
    name: 'get_weather_resilient',
    description: 'Get current weather for a location with retry logic',
    parameters: z.object({
      location: z.string().describe('City name'),
    }),
    execute: async ({ location }) => {
      return await retryPattern.execute(async () => {
        // Simulate potential API failure
        if (Math.random() < 0.3) {
          throw new Error('Weather API temporarily unavailable');
        }
        return `Weather in ${location}: Sunny, 72°F`;
      });
    },
  });

  const agent = new Agent({
    name: 'weather-agent',
    instructions: 'Help users get weather information.',
    tools: [resilientWeatherTool],
  });

  return agent;
}

// Example: Multi-agent workflow with retry
export async function multiAgentWorkflowWithRetry() {
  const retryPattern = new RetryPattern(2, 1000, 3000);

  const researchAgent = new Agent({
    name: 'researcher',
    instructions: 'Research topics and gather information.',
    model: 'gpt-4',
  });

  const writerAgent = new Agent({
    name: 'writer',
    instructions: 'Write articles based on research.',
    model: 'gpt-4',
  });

  const workflow = async (topic: string) => {
    // Step 1: Research with retry
    const research = await retryPattern.execute(async () => {
      const result = await run(researchAgent, `Research the topic: ${topic}`);
      if (!result.finalOutput) {
        throw new Error('Research failed - no results');
      }
      return result;
    });

    // Step 2: Writing with retry
    const article = await retryPattern.execute(async () => {
      const researchContent = research.finalOutput;
      const result = await run(
        writerAgent,
        `Write an article based on this research: ${researchContent}`,
      );
      if (!result.finalOutput) {
        throw new Error('Writing failed - no content generated');
      }
      return result;
    });

    return {
      research: research.finalOutput || '',
      article: article.finalOutput || '',
    };
  };

  return workflow;
}

// Example usage
export async function demonstrateRetryPatterns() {
  console.log('=== Retry Pattern Examples ===\n');

  // 1. Basic retry pattern
  console.log('1. Testing basic retry pattern...');
  const retryPattern = new RetryPattern(3, 500, 2000);

  try {
    await retryPattern.execute(async () => {
      if (Math.random() < 0.7) {
        throw new Error('Simulated failure');
      }
      return 'Success!';
    });
    console.log('✅ Operation succeeded with retry\n');
  } catch (error) {
    console.log(`❌ Operation failed: ${error}\n`);
  }

  // 2. Circuit breaker pattern
  console.log('2. Testing circuit breaker pattern...');
  const circuitBreaker = new CircuitBreaker(2, 5000);

  for (let i = 0; i < 5; i++) {
    try {
      await circuitBreaker.execute(async () => {
        throw new Error('Simulated failure');
      });
    } catch (error) {
      console.log(
        `Attempt ${i + 1}: ${error} (Circuit state: ${circuitBreaker.getState()})`,
      );
    }
  }
  console.log();

  // 3. Resilient agent
  console.log('3. Testing resilient agent...');
  try {
    const { resilientRun } = await createResilientAgent();
    const result = await resilientRun('Hello, how are you?');
    console.log('✅ Resilient agent succeeded');
    console.log(`Response: ${result.finalOutput || 'No response'}\n`);
  } catch (error) {
    console.log(`❌ Resilient agent failed: ${error}\n`);
  }
}

// Run examples if this file is executed directly
if (require.main === module) {
  demonstrateRetryPatterns().catch(console.error);
}
