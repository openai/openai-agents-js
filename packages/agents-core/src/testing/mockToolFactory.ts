import { tool, FunctionTool, ToolOptions } from '../tool';
import { RunContext } from '../runContext';
import { UnknownContext } from '../types';
import { z } from 'zod';

/**
 * Configuration for a mock tool execution
 */
export interface MockToolExecution {
  /**
   * The input that should trigger this execution
   */
  input?: any;
  /**
   * The result to return for this execution
   */
  result: any;
  /**
   * Optional delay in milliseconds before returning the result
   */
  delay?: number;
  /**
   * Whether this execution should be called (for verification)
   */
  shouldBeCalled?: boolean;
}

/**
 * Configuration for a mock tool failure
 */
export interface MockToolFailure {
  /**
   * The input that should trigger this failure
   */
  input?: any;
  /**
   * The error message to throw
   */
  errorMessage: string;
  /**
   * The type of error to throw
   */
  errorType?: 'Error' | 'TypeError' | 'RangeError';
  /**
   * Optional delay before throwing the error
   */
  delay?: number;
}

/**
 * Configuration for creating a mock tool
 */
export interface MockToolConfig<_TContext = UnknownContext> {
  /**
   * Name of the tool
   */
  name: string;
  /**
   * Description of the tool
   */
  description: string;
  /**
   * Parameters schema for the tool
   */
  parameters?: any;
  /**
   * Predefined executions for different inputs
   */
  executions?: MockToolExecution[];
  /**
   * Predefined failures for different inputs
   */
  failures?: MockToolFailure[];
  /**
   * Default result if no specific execution matches
   */
  defaultResult?: any;
  /**
   * Default error if no specific failure matches but tool should fail
   */
  defaultError?: string;
  /**
   * Whether the tool requires approval
   */
  needsApproval?: boolean;
  /**
   * Whether to track all calls made to this tool
   */
  trackCalls?: boolean;
}

/**
 * Information about a tool call that was made
 */
export interface ToolCallInfo {
  /**
   * The input passed to the tool
   */
  input: any;
  /**
   * The context passed to the tool
   */
  context: RunContext;
  /**
   * The result returned by the tool
   */
  result?: any;
  /**
   * The error thrown by the tool (if any)
   */
  error?: Error;
  /**
   * Timestamp when the call was made
   */
  timestamp: Date;
  /**
   * Duration of the call in milliseconds
   */
  duration?: number;
}

/**
 * Mock tool implementation that can simulate various behaviors
 */
class MockTool<TContext = UnknownContext> {
  private calls: ToolCallInfo[] = [];

  constructor(private config: MockToolConfig<TContext>) {}

  /**
   * Execute the mock tool with the given input
   */
  async execute(input: any, context: RunContext<TContext>): Promise<any> {
    const startTime = Date.now();
    const callInfo: ToolCallInfo = {
      input,
      context,
      timestamp: new Date(),
    };

    if (this.config.trackCalls) {
      this.calls.push(callInfo);
    }

    try {
      // Check for specific failures first
      const failure = this.findMatchingFailure(input);
      if (failure) {
        if (failure.delay) {
          await new Promise((resolve) => setTimeout(resolve, failure.delay));
        }

        const ErrorClass = this.getErrorClass(failure.errorType);
        const error = new ErrorClass(failure.errorMessage);
        callInfo.error = error;
        callInfo.duration = Date.now() - startTime;
        throw error;
      }

      // Check for specific executions
      const execution = this.findMatchingExecution(input);
      let result: any;

      if (execution) {
        if (execution.delay) {
          await new Promise((resolve) => setTimeout(resolve, execution.delay));
        }
        result = execution.result;
      } else if (this.config.defaultResult !== undefined) {
        result = this.config.defaultResult;
      } else if (this.config.defaultError) {
        const error = new Error(this.config.defaultError);
        callInfo.error = error;
        callInfo.duration = Date.now() - startTime;
        throw error;
      } else {
        result = `Mock result for ${this.config.name}`;
      }

      callInfo.result = result;
      callInfo.duration = Date.now() - startTime;
      return result;
    } catch (error) {
      callInfo.error = error as Error;
      callInfo.duration = Date.now() - startTime;
      throw error;
    }
  }

  /**
   * Get all calls made to this tool
   */
  getCalls(): ToolCallInfo[] {
    return [...this.calls];
  }

  /**
   * Get the number of calls made to this tool
   */
  getCallCount(): number {
    return this.calls.length;
  }

  /**
   * Check if the tool was called with specific input
   */
  wasCalledWith(input: any): boolean {
    return this.calls.some(
      (call) => JSON.stringify(call.input) === JSON.stringify(input),
    );
  }

  /**
   * Reset the call history
   */
  resetCalls(): void {
    this.calls = [];
  }

  /**
   * Verify that expected calls were made
   */
  verifyExpectedCalls(): void {
    if (this.config.executions) {
      for (const execution of this.config.executions) {
        if (execution.shouldBeCalled && !this.wasCalledWith(execution.input)) {
          throw new Error(
            `Expected tool ${this.config.name} to be called with ${JSON.stringify(execution.input)}, but it was not`,
          );
        }
      }
    }
  }

  private findMatchingExecution(input: any): MockToolExecution | undefined {
    if (!this.config.executions) return undefined;

    // First try to find exact match
    const exactMatch = this.config.executions.find(
      (exec) =>
        exec.input !== undefined &&
        JSON.stringify(exec.input) === JSON.stringify(input),
    );
    if (exactMatch) return exactMatch;

    // Then try to find execution without specific input (matches any)
    return this.config.executions.find((exec) => exec.input === undefined);
  }

  private findMatchingFailure(input: any): MockToolFailure | undefined {
    if (!this.config.failures) return undefined;

    // First try to find exact match
    const exactMatch = this.config.failures.find(
      (failure) =>
        failure.input !== undefined &&
        JSON.stringify(failure.input) === JSON.stringify(input),
    );
    if (exactMatch) return exactMatch;

    // Then try to find failure without specific input (matches any)
    return this.config.failures.find((failure) => failure.input === undefined);
  }

  private getErrorClass(errorType?: string): new (message: string) => Error {
    switch (errorType) {
      case 'TypeError':
        return TypeError;
      case 'RangeError':
        return RangeError;
      default:
        return Error;
    }
  }
}

/**
 * Factory for creating mock tools for testing
 */
export class MockToolFactory {
  /**
   * Create a mock tool with the specified configuration
   */
  static createTool<TContext = UnknownContext>(
    config: MockToolConfig<TContext>,
  ): FunctionTool<TContext> & { mock: MockTool<TContext> } {
    const mockTool = new MockTool(config);

    const parameters = config.parameters || z.object({}).passthrough();

    const toolOptions: ToolOptions<any, TContext> = {
      name: config.name,
      description: config.description,
      parameters,
      needsApproval: config.needsApproval || false,
      errorFunction: null, // Disable default error handling to let our errors through
      execute: async (input: any, context?: RunContext<TContext>) => {
        return mockTool.execute(
          input,
          context || new RunContext({} as TContext),
        );
      },
    };

    const functionTool = tool(toolOptions);

    // Attach the mock instance for testing utilities
    (functionTool as any).mock = mockTool;

    return functionTool as FunctionTool<TContext> & {
      mock: MockTool<TContext>;
    };
  }

  /**
   * Create a simple mock tool that always returns the same result
   */
  static createSimpleTool<TContext = UnknownContext>(
    name: string,
    description: string,
    result: any,
  ): FunctionTool<TContext> & { mock: MockTool<TContext> } {
    return this.createTool({
      name,
      description,
      defaultResult: result,
      trackCalls: true,
    });
  }

  /**
   * Create a mock tool that always fails
   */
  static createFailingTool<TContext = UnknownContext>(
    name: string,
    description: string,
    errorMessage: string = 'Mock tool failure',
  ): FunctionTool<TContext> & { mock: MockTool<TContext> } {
    return this.createTool({
      name,
      description,
      defaultError: errorMessage,
      trackCalls: true,
    });
  }

  /**
   * Create a mock tool with conditional behavior based on input
   */
  static createConditionalTool<TContext = UnknownContext>(
    name: string,
    description: string,
    executions: MockToolExecution[],
  ): FunctionTool<TContext> & { mock: MockTool<TContext> } {
    return this.createTool({
      name,
      description,
      executions,
      trackCalls: true,
    });
  }

  /**
   * Create a mock tool that simulates network latency
   */
  static createSlowTool<TContext = UnknownContext>(
    name: string,
    description: string,
    result: any,
    delayMs: number,
  ): FunctionTool<TContext> & { mock: MockTool<TContext> } {
    return this.createTool({
      name,
      description,
      executions: [{ result, delay: delayMs }],
      trackCalls: true,
    });
  }

  /**
   * Create a mock tool that requires approval
   */
  static createApprovalTool<TContext = UnknownContext>(
    name: string,
    description: string,
    result: any,
  ): FunctionTool<TContext> & { mock: MockTool<TContext> } {
    return this.createTool({
      name,
      description,
      defaultResult: result,
      needsApproval: true,
      trackCalls: true,
    });
  }

  /**
   * Create a mock tool with typed parameters
   */
  static createTypedTool<TContext = UnknownContext>(
    name: string,
    description: string,
    parameters: z.ZodObject<any>,
    result: any,
  ): FunctionTool<TContext> & { mock: MockTool<TContext> } {
    return this.createTool({
      name,
      description,
      parameters,
      defaultResult: result,
      trackCalls: true,
    });
  }
}
