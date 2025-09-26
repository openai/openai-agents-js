/**
 * Example demonstrating enhanced error handling with context and debugging utilities.
 */

import {
  Agent,
  run,
  tool,
  AgentDebugger,
  SystemError,
  ToolCallError,
  createErrorContext,
} from '@openai/agents';

// Create a simple agent that might encounter errors
const errorProneAgent = new Agent({
  name: 'error-prone-agent',
  instructions:
    'You are an agent that demonstrates error handling capabilities.',
  tools: [
    tool({
      name: 'failing_tool',
      description: 'A tool that always fails to demonstrate error handling',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string' },
        },
        required: ['message'],
        additionalProperties: true,
      },
      strict: false,
      needsApproval: false,
      execute: async (input) => {
        // Parse the input since we're using strict: false
        const args = typeof input === 'string' ? JSON.parse(input) : input;

        // Simulate a tool failure with enhanced error context
        throw new ToolCallError(
          'Tool execution failed',
          new Error('Simulated failure'),
          undefined,
          {
            ...createErrorContext('tool_execution'),
            toolName: 'failing_tool',
            toolArguments: args,
          },
        );
      },
    }),
  ],
});

async function demonstrateEnhancedErrorHandling() {
  console.log('=== Enhanced Error Handling Demo ===\n');

  try {
    // This will fail and demonstrate enhanced error reporting
    await run(
      errorProneAgent,
      'Please use the failing_tool with message "test"',
    );
  } catch (error) {
    if (error instanceof ToolCallError) {
      console.log('Caught enhanced ToolCallError:');
      console.log('- Tool Name:', error.toolName);
      console.log('- Tool Arguments:', error.toolArguments);
      console.log('- Enhanced Message:', error.message);
      console.log('- Suggestions:', error.suggestions.length);

      console.log('\n--- Debug Report ---');
      console.log(AgentDebugger.createDebugReport(error));

      console.log('\n--- Debug Info ---');
      console.log(error.getDebugInfo());
    }
  }

  // Demonstrate creating errors with context
  console.log('\n=== Creating Errors with Context ===\n');

  try {
    // Simulate a system error with context
    throw new SystemError('Database connection failed', undefined, {
      ...createErrorContext('database_connection'),
      operationStack: ['app_startup', 'database_init'],
    });
  } catch (error) {
    if (error instanceof SystemError) {
      console.log('System Error with Context:');
      console.log('- Message:', error.message);
      console.log('- Context:', error.context);
      console.log(
        '- Suggestions:',
        error.suggestions.map((s) => s.description),
      );
    }
  }
}

// Run the demo if this file is executed directly
if (require.main === module) {
  demonstrateEnhancedErrorHandling().catch(console.error);
}

export { demonstrateEnhancedErrorHandling };
