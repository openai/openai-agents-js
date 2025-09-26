/**
 * Simple example showing basic performance monitoring integration
 */

import { Agent, Runner, tool } from '@openai/agents-core';
import {
  PerformanceEnhancedRunner,
  createSimplePerformanceMonitor,
  measureExecutionTime,
} from '@openai/agents-core/performance';

// Create a simple tool that simulates some work
const delayTool = tool({
  name: 'delay',
  description:
    'Simulates work by waiting for a specified number of milliseconds',
  parameters: {
    type: 'object',
    properties: {
      ms: { type: 'number', description: 'Milliseconds to wait' },
    },
    required: ['ms'],
  },
  execute: async ({ ms }) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return `Waited for ${ms}ms`;
  },
});

// Create an agent
const testAgent = new Agent({
  name: 'Performance Test Agent',
  instructions: 'You are a test agent. Use the delay tool when asked to wait.',
  tools: [delayTool],
});

async function runBasicExample() {
  console.log('=== Basic Performance Monitoring Example ===\n');

  // Create performance monitor
  const monitor = createSimplePerformanceMonitor();

  // Create performance-enhanced runner
  const runner = new PerformanceEnhancedRunner({}, monitor);

  // Run the agent with performance tracking
  console.log('Running agent with performance monitoring...');
  const result = await runner.run(
    testAgent,
    'Please wait for 100 milliseconds using the delay tool',
  );

  console.log('Agent response:', result.output);

  // Get and display performance report
  const reports = monitor.getReports();
  if (reports.length > 0) {
    const report = reports[0];
    console.log('\n--- Performance Report ---');
    console.log(`Agent: ${report.agentName}`);
    console.log(`Total execution time: ${report.execution.totalTime}ms`);
    console.log(`Number of turns: ${report.execution.turnCount}`);
    console.log(`Tool calls: ${report.toolCalls.length}`);

    if (report.toolCalls.length > 0) {
      console.log('\nTool call details:');
      report.toolCalls.forEach((toolCall, index) => {
        console.log(
          `  ${index + 1}. ${toolCall.toolName}: ${toolCall.executionTime}ms (${toolCall.success ? 'success' : 'failed'})`,
        );
      });
    }

    console.log(`Peak memory usage: ${report.memoryUsage.peak.toFixed(2)}MB`);
    console.log(`Token usage: ${report.tokenUsage.totalTokens} total tokens`);
  }
}

async function runComparisonExample() {
  console.log('\n=== Performance Comparison Example ===\n');

  // Compare regular runner vs performance-enhanced runner
  const regularRunner = new Runner();
  const enhancedRunner = new PerformanceEnhancedRunner();

  const testInput = 'Wait for 50ms using the delay tool';

  // Test regular runner
  console.log('Testing regular runner...');
  const { executionTime: regularTime } = await measureExecutionTime(
    async () => {
      return await regularRunner.run(testAgent, testInput);
    },
  );

  // Test enhanced runner
  console.log('Testing performance-enhanced runner...');
  const { executionTime: enhancedTime } = await measureExecutionTime(
    async () => {
      return await enhancedRunner.run(testAgent, testInput);
    },
  );

  console.log('\n--- Comparison Results ---');
  console.log(`Regular runner: ${regularTime}ms`);
  console.log(`Enhanced runner: ${enhancedTime}ms`);
  console.log(`Monitoring overhead: ${enhancedTime - regularTime}ms`);

  // Show detailed metrics from enhanced runner
  const reports = enhancedRunner.getPerformanceMonitor().getReports();
  if (reports.length > 0) {
    const report = reports[reports.length - 1];
    console.log('\nDetailed metrics from enhanced runner:');
    console.log(
      `- Average turn time: ${report.execution.averageTurnTime.toFixed(2)}ms`,
    );
    console.log(`- Tool calls: ${report.toolCalls.length}`);
    console.log(
      `- Memory efficiency: ${((report.memoryUsage.end / report.memoryUsage.peak) * 100).toFixed(1)}% memory retained`,
    );
  }
}

async function runStatisticsExample() {
  console.log('\n=== Statistics Example ===\n');

  const monitor = createSimplePerformanceMonitor();
  const runner = new PerformanceEnhancedRunner({}, monitor);

  // Run multiple agent executions
  console.log('Running multiple agent executions...');
  const inputs = ['Wait for 50ms', 'Wait for 100ms', 'Wait for 75ms'];

  for (const input of inputs) {
    await runner.run(testAgent, input);
  }

  // Get overall statistics
  const stats = monitor.getStatistics();
  console.log('\n--- Overall Statistics ---');
  console.log(`Total runs: ${stats.totalRuns}`);
  console.log(
    `Average execution time: ${stats.averageExecutionTime.toFixed(2)}ms`,
  );
  console.log(`Total tool calls: ${stats.totalToolCalls}`);
  console.log(
    `Average tool call time: ${stats.averageToolCallTime.toFixed(2)}ms`,
  );
  console.log(`Total handoffs: ${stats.totalHandoffs}`);

  // Show individual reports
  const reports = monitor.getReports();
  console.log('\n--- Individual Run Times ---');
  reports.forEach((report, index) => {
    console.log(`Run ${index + 1}: ${report.execution.totalTime}ms`);
  });
}

// Run all examples
async function main() {
  try {
    await runBasicExample();
    await runComparisonExample();
    await runStatisticsExample();
  } catch (error) {
    console.error('Error running performance examples:', error);
  }
}

if (require.main === module) {
  main();
}
