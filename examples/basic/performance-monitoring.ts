/**
 * Example demonstrating performance monitoring capabilities
 */

import { Agent, Runner, tool, run } from '@openai/agents';
import { z } from 'zod';

// Simple performance monitoring utilities
class SimplePerformanceLogger {
  private startTimes = new Map<string, number>();

  start(label: string): void {
    this.startTimes.set(label, Date.now());
  }

  end(label: string): number {
    const startTime = this.startTimes.get(label);
    if (!startTime) {
      console.warn(`[Performance] No start time found for label: ${label}`);
      return 0;
    }

    const executionTime = Date.now() - startTime;
    console.log(`[Performance] ${label}: ${executionTime}ms`);
    this.startTimes.delete(label);
    return executionTime;
  }

  clear(): void {
    this.startTimes.clear();
  }
}

// Measure execution time of a function
async function measureExecutionTime<T>(
  fn: () => Promise<T> | T,
  label?: string,
): Promise<{ result: T; executionTime: number }> {
  const startTime = Date.now();
  const result = await fn();
  const executionTime = Date.now() - startTime;

  if (label) {
    console.log(`[Performance] ${label}: ${executionTime}ms`);
  }

  return { result, executionTime };
}

// Create a simple tool for demonstration
const calculatorTool = tool({
  name: 'calculator',
  description: 'Performs basic arithmetic operations',
  parameters: z.object({
    operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
    a: z.number(),
    b: z.number(),
  }),
  execute: async ({ operation, a, b }) => {
    // Simulate some processing time
    await new Promise((resolve) => setTimeout(resolve, 100));

    switch (operation) {
      case 'add':
        return a + b;
      case 'subtract':
        return a - b;
      case 'multiply':
        return a * b;
      case 'divide':
        return b !== 0 ? a / b : 'Error: Division by zero';
      default:
        return 'Error: Unknown operation';
    }
  },
});

// Create an agent with tools
const mathAgent = new Agent({
  name: 'Math Assistant',
  instructions:
    'You are a helpful math assistant. Use the calculator tool to perform calculations.',
  tools: [calculatorTool],
});

async function _basicPerformanceMonitoring() {
  console.log('=== Basic Performance Monitoring ===');

  // Create a simple performance logger
  const logger = new SimplePerformanceLogger();

  // Track overall execution time
  logger.start('agent-execution');

  // Run the agent
  const result = await run(
    mathAgent,
    'Calculate 15 * 7 and then add 23 to the result',
  );

  logger.end('agent-execution');

  console.log('Agent response:', result.finalOutput);
  console.log('✅ Basic performance monitoring complete\n');
}

async function manualPerformanceTracking() {
  console.log('=== Manual Performance Tracking ===');

  const logger = new SimplePerformanceLogger();

  // Track different operations manually
  logger.start('agent-initialization');
  await new Promise((resolve) => setTimeout(resolve, 50));
  logger.end('agent-initialization');

  // Simulate tool calls
  const { executionTime } = await measureExecutionTime(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return 'calculation result';
  }, 'Manual calculation');

  console.log(`Manual calculation completed in ${executionTime}ms`);
  console.log('✅ Manual performance tracking complete\n');
}

async function simplePerformanceLogging() {
  console.log('=== Simple Performance Logging ===');

  const logger = new SimplePerformanceLogger();

  // Track different operations
  logger.start('agent-initialization');
  await new Promise((resolve) => setTimeout(resolve, 50));
  logger.end('agent-initialization');

  logger.start('tool-execution');
  await new Promise((resolve) => setTimeout(resolve, 200));
  logger.end('tool-execution');

  logger.start('response-generation');
  await new Promise((resolve) => setTimeout(resolve, 100));
  logger.end('response-generation');

  console.log('✅ Simple performance logging complete\n');
}

async function _performanceComparison() {
  console.log('=== Performance Comparison ===');

  // Compare different approaches to running agents
  const runner = new Runner();

  console.log('Running with regular runner...');
  const { executionTime: regularTime } = await measureExecutionTime(
    async () => {
      return await runner.run(mathAgent, 'What is 10 + 5?');
    },
  );

  console.log('Running with direct run function...');
  const { executionTime: directTime } = await measureExecutionTime(async () => {
    return await run(mathAgent, 'What is 10 + 5?');
  });

  console.log(`\nComparison:`);
  console.log(`- Regular runner: ${regularTime}ms`);
  console.log(`- Direct run: ${directTime}ms`);
  console.log(`- Difference: ${Math.abs(regularTime - directTime)}ms`);
  console.log('✅ Performance comparison complete\n');
}

// Run all examples
async function main() {
  try {
    // Only run examples that don't require API calls
    await manualPerformanceTracking();
    await simplePerformanceLogging();

    // Note: Agent examples require OpenAI API key
    console.log(
      'Note: Agent examples require OPENAI_API_KEY environment variable',
    );
    console.log(
      'To run agent examples, set your API key and uncomment the following lines:',
    );
    console.log('// await _basicPerformanceMonitoring();');
    console.log('// await _performanceComparison();');
  } catch (error) {
    console.error('Error running performance monitoring examples:', error);
  }
}

if (require.main === module) {
  main();
}
