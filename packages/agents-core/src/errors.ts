import { Agent, AgentOutputType } from './agent';
import {
  InputGuardrailResult,
  OutputGuardrailMetadata,
  OutputGuardrailResult,
} from './guardrail';
import { RunState } from './runState';
import { TextOutput } from './types';

/**
 * Enhanced error context providing detailed information about the agent state when an error occurred.
 */
export interface EnhancedErrorContext {
  /** Name of the agent that was active when the error occurred */
  agentName: string;
  /** Current turn number in the conversation */
  turnNumber: number;
  /** Description of the last successful operation before the error */
  lastSuccessfulOperation: string;
  /** Stack trace of operations leading to the error */
  operationStack: string[];
  /** Timestamp when the error occurred */
  timestamp: Date;
  /** Partial run state for debugging (excludes sensitive data) */
  runStateSnapshot?: {
    maxTurns: number;
    generatedItemsCount: number;
    modelResponsesCount: number;
    toolUseTrackerSummary: Record<string, string[]>;
  };
}

/**
 * Recovery action that can be suggested to resolve an error.
 */
export interface RecoveryAction {
  /** Type of recovery action */
  type: 'retry' | 'fallback' | 'skip' | 'restart' | 'manual';
  /** Human-readable description of the recovery action */
  description: string;
  /** Optional function to execute the recovery action automatically */
  execute?: () => Promise<void>;
}

/**
 * Base class for all errors thrown by the library.
 */
export abstract class AgentsError extends Error {
  state?: RunState<any, Agent<any, any>>;
  /** Enhanced context providing detailed debugging information */
  context?: EnhancedErrorContext;
  /** Suggested recovery actions for this error */
  suggestions: RecoveryAction[];

  constructor(
    message: string,
    state?: RunState<any, Agent<any, any>>,
    context?: Partial<EnhancedErrorContext>,
  ) {
    super(message);
    this.state = state;
    this.suggestions = [];

    if (state || context) {
      this.context = this.buildEnhancedContext(state, context);
      // Enhance the error message with context
      this.message = this.buildEnhancedMessage(message);
    }
  }

  /**
   * Builds enhanced error context from the run state and additional context.
   */
  private buildEnhancedContext(
    state?: RunState<any, Agent<any, any>>,
    additionalContext?: Partial<EnhancedErrorContext>,
  ): EnhancedErrorContext {
    const baseContext: EnhancedErrorContext = {
      agentName: state?._currentAgent?.name || 'unknown',
      turnNumber: state?._currentTurn || 0,
      lastSuccessfulOperation: 'unknown',
      operationStack: [],
      timestamp: new Date(),
    };

    // Only build snapshot if we have a valid state with required properties
    if (
      state &&
      typeof state._maxTurns === 'number' &&
      Array.isArray(state._generatedItems) &&
      Array.isArray(state._modelResponses) &&
      state._toolUseTracker &&
      typeof state._toolUseTracker.toJSON === 'function'
    ) {
      try {
        baseContext.runStateSnapshot = {
          maxTurns: state._maxTurns,
          generatedItemsCount: state._generatedItems.length,
          modelResponsesCount: state._modelResponses.length,
          toolUseTrackerSummary: state._toolUseTracker.toJSON(),
        };
      } catch (_error) {
        // If we can't build the snapshot, just skip it
      }
    }

    return { ...baseContext, ...additionalContext };
  }

  /**
   * Builds an enhanced error message that includes contextual information.
   */
  private buildEnhancedMessage(originalMessage: string): string {
    if (!this.context) return originalMessage;

    const contextParts = [
      `Agent: ${this.context.agentName}`,
      `Turn: ${this.context.turnNumber}`,
    ];

    if (this.context.lastSuccessfulOperation !== 'unknown') {
      contextParts.push(
        `Last operation: ${this.context.lastSuccessfulOperation}`,
      );
    }

    return `${originalMessage} [${contextParts.join(', ')}]`;
  }

  /**
   * Adds a recovery suggestion to this error.
   */
  addSuggestion(suggestion: RecoveryAction): void {
    this.suggestions.push(suggestion);
  }

  /**
   * Gets a formatted string with error details and suggestions for debugging.
   */
  getDebugInfo(): string {
    const parts = [`Error: ${this.message}`, `Type: ${this.constructor.name}`];

    if (this.context) {
      parts.push(
        `Context:`,
        `  Agent: ${this.context.agentName}`,
        `  Turn: ${this.context.turnNumber}`,
        `  Timestamp: ${this.context.timestamp.toISOString()}`,
      );

      if (this.context.lastSuccessfulOperation !== 'unknown') {
        parts.push(
          `  Last successful operation: ${this.context.lastSuccessfulOperation}`,
        );
      }

      if (this.context.operationStack.length > 0) {
        parts.push(
          `  Operation stack: ${this.context.operationStack.join(' -> ')}`,
        );
      }

      if (this.context.runStateSnapshot) {
        const snapshot = this.context.runStateSnapshot;
        parts.push(
          `  Run state:`,
          `    Turn ${this.context.turnNumber}/${snapshot.maxTurns}`,
          `    Generated items: ${snapshot.generatedItemsCount}`,
          `    Model responses: ${snapshot.modelResponsesCount}`,
        );
      }
    }

    if (this.suggestions.length > 0) {
      parts.push(`Suggestions:`);
      this.suggestions.forEach((suggestion, index) => {
        parts.push(
          `  ${index + 1}. ${suggestion.description} (${suggestion.type})`,
        );
      });
    }

    return parts.join('\n');
  }
}

/**
 * System error thrown when the library encounters an error that is not caused by the user's
 * misconfiguration.
 */
export class SystemError extends AgentsError {
  constructor(
    message: string,
    state?: RunState<any, Agent<any, any>>,
    context?: Partial<EnhancedErrorContext>,
  ) {
    super(message, state, context);
    this.addSuggestion({
      type: 'manual',
      description: 'Check system logs and report this issue if it persists',
    });
  }
}

/**
 * Error thrown when the maximum number of turns is exceeded.
 */
export class MaxTurnsExceededError extends AgentsError {
  constructor(
    message: string,
    state?: RunState<any, Agent<any, any>>,
    context?: Partial<EnhancedErrorContext>,
  ) {
    super(message, state, context);
    this.addSuggestion({
      type: 'manual',
      description:
        'Increase maxTurns in run options or optimize agent logic to reduce turns',
    });
  }
}

/**
 * Error thrown when a model behavior is unexpected.
 */
export class ModelBehaviorError extends AgentsError {
  constructor(
    message: string,
    state?: RunState<any, Agent<any, any>>,
    context?: Partial<EnhancedErrorContext>,
  ) {
    super(message, state, context);
    this.addSuggestion({
      type: 'retry',
      description:
        'Retry the operation as model behavior can be non-deterministic',
    });
    this.addSuggestion({
      type: 'manual',
      description: 'Review agent instructions and model settings for clarity',
    });
  }
}

/**
 * Error thrown when the error is caused by the library user's misconfiguration.
 */
export class UserError extends AgentsError {
  constructor(
    message: string,
    state?: RunState<any, Agent<any, any>>,
    context?: Partial<EnhancedErrorContext>,
  ) {
    super(message, state, context);
    this.addSuggestion({
      type: 'manual',
      description: 'Review the configuration and fix the reported issue',
    });
  }
}

/**
 * Error thrown when a guardrail execution fails.
 */
export class GuardrailExecutionError extends AgentsError {
  error: Error;
  guardrailName?: string;
  guardrailType?: 'input' | 'output';

  constructor(
    message: string,
    error: Error,
    state?: RunState<any, Agent<any, any>>,
    context?: Partial<EnhancedErrorContext> & {
      guardrailName?: string;
      guardrailType?: 'input' | 'output';
    },
  ) {
    const { guardrailName, guardrailType, ...enhancedContext } = context || {};
    super(message, state, {
      ...enhancedContext,
      lastSuccessfulOperation:
        enhancedContext?.lastSuccessfulOperation || 'guardrail_execution',
    });
    this.error = error;
    this.guardrailName = guardrailName;
    this.guardrailType = guardrailType;

    this.addSuggestion({
      type: 'manual',
      description: `Review ${this.guardrailType || 'guardrail'} configuration${this.guardrailName ? ` for "${this.guardrailName}"` : ''}`,
    });
    this.addSuggestion({
      type: 'retry',
      description: 'Retry with different input or modify guardrail conditions',
    });
  }
}

/**
 * Error thrown when a tool call fails.
 */
export class ToolCallError extends AgentsError {
  error: Error;
  toolName?: string;
  toolArguments?: Record<string, any>;

  constructor(
    message: string,
    error: Error,
    state?: RunState<any, Agent<any, any>>,
    context?: Partial<EnhancedErrorContext> & {
      toolName?: string;
      toolArguments?: Record<string, any>;
    },
  ) {
    const { toolName, toolArguments, ...enhancedContext } = context || {};
    super(message, state, {
      ...enhancedContext,
      lastSuccessfulOperation:
        enhancedContext?.lastSuccessfulOperation || 'tool_call',
    });
    this.error = error;
    this.toolName = toolName;
    this.toolArguments = toolArguments;

    this.addSuggestion({
      type: 'retry',
      description: `Retry the tool call${this.toolName ? ` for "${this.toolName}"` : ''} with different arguments`,
    });
    this.addSuggestion({
      type: 'manual',
      description: `Check tool implementation${this.toolName ? ` for "${this.toolName}"` : ''} and ensure it handles the provided arguments correctly`,
    });
  }
}

/**
 * Error thrown when an input guardrail tripwire is triggered.
 */
export class InputGuardrailTripwireTriggered extends AgentsError {
  result: InputGuardrailResult;

  constructor(
    message: string,
    result: InputGuardrailResult,
    state?: RunState<any, any>,
    context?: Partial<EnhancedErrorContext>,
  ) {
    super(message, state, {
      ...context,
      lastSuccessfulOperation:
        context?.lastSuccessfulOperation || 'input_guardrail_check',
    });
    this.result = result;

    // Only add suggestions if we have a valid result object
    if (result && result.guardrail && result.guardrail.name) {
      this.addSuggestion({
        type: 'manual',
        description: `Input guardrail "${result.guardrail.name}" was triggered - review and modify the input`,
      });
    } else {
      this.addSuggestion({
        type: 'manual',
        description:
          'Input guardrail was triggered - review and modify the input',
      });
    }
    this.addSuggestion({
      type: 'fallback',
      description:
        'Use alternative input that complies with guardrail requirements',
    });
  }
}

/**
 * Error thrown when an output guardrail tripwire is triggered.
 */
export class OutputGuardrailTripwireTriggered<
  TMeta extends OutputGuardrailMetadata,
  TOutputType extends AgentOutputType = TextOutput,
> extends AgentsError {
  result: OutputGuardrailResult<TMeta, TOutputType>;

  constructor(
    message: string,
    result: OutputGuardrailResult<TMeta, TOutputType>,
    state?: RunState<any, any>,
    context?: Partial<EnhancedErrorContext>,
  ) {
    super(message, state, {
      ...context,
      lastSuccessfulOperation:
        context?.lastSuccessfulOperation || 'output_guardrail_check',
    });
    this.result = result;

    // Only add suggestions if we have a valid result object
    if (result && result.guardrail && result.guardrail.name) {
      this.addSuggestion({
        type: 'retry',
        description: `Output guardrail "${result.guardrail.name}" was triggered - retry with different agent instructions`,
      });
    } else {
      this.addSuggestion({
        type: 'retry',
        description:
          'Output guardrail was triggered - retry with different agent instructions',
      });
    }
    this.addSuggestion({
      type: 'manual',
      description:
        'Review agent output and adjust instructions or guardrail configuration',
    });
  }
}

/**
 * Debugging utilities for inspecting agent state during errors.
 */
export class AgentDebugger {
  /**
   * Creates a detailed debug report from an AgentsError.
   */
  static createDebugReport(error: AgentsError): string {
    const report = [
      '=== AGENT ERROR DEBUG REPORT ===',
      `Timestamp: ${new Date().toISOString()}`,
      `Error Type: ${error.constructor.name}`,
      `Message: ${error.message}`,
      '',
    ];

    if (error.context) {
      report.push(
        '--- CONTEXT ---',
        `Agent: ${error.context.agentName}`,
        `Turn: ${error.context.turnNumber}`,
        `Last Operation: ${error.context.lastSuccessfulOperation}`,
        `Error Time: ${error.context.timestamp.toISOString()}`,
      );

      if (error.context.operationStack.length > 0) {
        report.push(
          `Operation Stack: ${error.context.operationStack.join(' -> ')}`,
        );
      }

      if (error.context.runStateSnapshot) {
        const snapshot = error.context.runStateSnapshot;
        report.push(
          '',
          '--- RUN STATE SNAPSHOT ---',
          `Progress: Turn ${error.context.turnNumber}/${snapshot.maxTurns}`,
          `Generated Items: ${snapshot.generatedItemsCount}`,
          `Model Responses: ${snapshot.modelResponsesCount}`,
          `Tool Usage: ${JSON.stringify(snapshot.toolUseTrackerSummary, null, 2)}`,
        );
      }

      report.push('');
    }

    if (error.state) {
      report.push(
        '--- AGENT STATE ---',
        `Agent Name: ${error.state._currentAgent?.name || 'unknown'}`,
        `Current Turn: ${error.state._currentTurn}`,
        `Max Turns: ${error.state._maxTurns}`,
        `Active Agent Run: ${!error.state._noActiveAgentRun}`,
        `Generated Items Count: ${error.state._generatedItems.length}`,
        `Model Responses Count: ${error.state._modelResponses.length}`,
      );

      if (error.state._inputGuardrailResults.length > 0) {
        report.push(
          `Input Guardrail Results: ${error.state._inputGuardrailResults.length}`,
        );
      }

      if (error.state._outputGuardrailResults.length > 0) {
        report.push(
          `Output Guardrail Results: ${error.state._outputGuardrailResults.length}`,
        );
      }

      report.push('');
    }

    if (error.suggestions.length > 0) {
      report.push('--- RECOVERY SUGGESTIONS ---');
      error.suggestions.forEach((suggestion, index) => {
        report.push(
          `${index + 1}. [${suggestion.type.toUpperCase()}] ${suggestion.description}`,
        );
      });
      report.push('');
    }

    if (error.stack) {
      report.push('--- STACK TRACE ---', error.stack);
    }

    report.push('=== END DEBUG REPORT ===');
    return report.join('\n');
  }

  /**
   * Extracts key debugging information from a RunState.
   */
  static extractStateInfo(
    state: RunState<any, Agent<any, any>>,
  ): Record<string, any> {
    return {
      agentName: state._currentAgent?.name || 'unknown',
      currentTurn: state._currentTurn,
      maxTurns: state._maxTurns,
      generatedItemsCount: state._generatedItems.length,
      modelResponsesCount: state._modelResponses.length,
      hasActiveRun: !state._noActiveAgentRun,
      toolUseTracker: state._toolUseTracker.toJSON(),
      inputGuardrailResults: state._inputGuardrailResults.length,
      outputGuardrailResults: state._outputGuardrailResults.length,
      currentStep: state._currentStep?.type || null,
      hasTrace: !!state._trace,
      lastTurnResponse: !!state._lastTurnResponse,
      lastProcessedResponse: !!state._lastProcessedResponse,
    };
  }

  /**
   * Creates a sanitized version of agent state for logging (removes sensitive data).
   */
  static sanitizeStateForLogging(
    state: RunState<any, Agent<any, any>>,
  ): Record<string, any> {
    const info = this.extractStateInfo(state);

    // Remove potentially sensitive information
    delete info.toolUseTracker;

    return {
      ...info,
      // Add summary information instead of detailed data
      hasToolUsage: Object.keys(state._toolUseTracker.toJSON()).length > 0,
      recentItems: state._generatedItems.slice(-3).map((item) => ({
        type: item.type,
        // RunItem has different agent property access patterns depending on the item type
        agent:
          'agent' in item ? (item as any).agent?.name || 'unknown' : 'unknown',
      })),
    };
  }

  /**
   * Validates the consistency of a RunState and returns any issues found.
   */
  static validateRunState(state: RunState<any, Agent<any, any>>): string[] {
    const issues: string[] = [];

    if (!state._currentAgent) {
      issues.push('No current agent set');
    }

    if (state._currentTurn < 0) {
      issues.push('Current turn is negative');
    }

    if (state._currentTurn >= state._maxTurns) {
      issues.push('Current turn exceeds max turns');
    }

    if (state._modelResponses.length > state._maxTurns) {
      issues.push('More model responses than max turns');
    }

    if (state._generatedItems.length === 0 && state._currentTurn > 0) {
      issues.push('No generated items despite having turns');
    }

    return issues;
  }
}

/**
 * Helper function to create enhanced error context with operation tracking.
 */
export function createErrorContext(
  operation: string,
  _state?: RunState<any, Agent<any, any>>,
  additionalContext?: Partial<EnhancedErrorContext>,
): Partial<EnhancedErrorContext> {
  const baseContext = {
    lastSuccessfulOperation: operation,
    operationStack: [operation],
    timestamp: new Date(),
  };

  if (additionalContext) {
    // If operationStack is provided in additionalContext, append the new operation
    if (additionalContext.operationStack) {
      baseContext.operationStack = [
        ...additionalContext.operationStack,
        operation,
      ];
    }
  }

  return {
    ...baseContext,
    ...additionalContext,
    // Ensure these are not overridden
    lastSuccessfulOperation: operation,
    operationStack: baseContext.operationStack,
  };
}

/**
 * Helper function to add operation to existing error context.
 */
export function addOperationToContext(
  context: Partial<EnhancedErrorContext>,
  operation: string,
): Partial<EnhancedErrorContext> {
  return {
    ...context,
    operationStack: [...(context.operationStack || []), operation],
    lastSuccessfulOperation: operation,
  };
}

/**
 * Configuration for retry behavior in MCP operations.
 */
export interface MCPRetryConfig {
  /** Maximum number of retry attempts */
  maxAttempts: number;
  /** Base delay between retries in milliseconds */
  baseDelay: number;
  /** Maximum delay between retries in milliseconds */
  maxDelay: number;
  /** Backoff strategy for retry delays */
  backoffStrategy: 'exponential' | 'linear' | 'fixed';
  /** Multiplier for exponential backoff */
  backoffMultiplier: number;
  /** Whether to add jitter to retry delays */
  jitter: boolean;
  /** Whether to suppress retry logging (useful for tests) */
  quiet?: boolean;
}

/**
 * Default retry configuration for MCP operations.
 */
export const DEFAULT_MCP_RETRY_CONFIG: MCPRetryConfig = {
  maxAttempts: 3,
  baseDelay: 1000,
  maxDelay: 10000,
  backoffStrategy: 'exponential',
  backoffMultiplier: 2,
  jitter: true,
};

/**
 * Error thrown when MCP server connection fails.
 */
export class MCPConnectionError extends AgentsError {
  serverName: string;
  serverType: 'stdio' | 'sse' | 'streamable-http';
  connectionDetails: Record<string, any>;
  underlyingError?: Error;

  constructor(
    message: string,
    serverName: string,
    serverType: 'stdio' | 'sse' | 'streamable-http',
    connectionDetails: Record<string, any>,
    underlyingError?: Error,
    state?: RunState<any, Agent<any, any>>,
    context?: Partial<EnhancedErrorContext>,
  ) {
    super(message, state, {
      ...context,
      lastSuccessfulOperation:
        context?.lastSuccessfulOperation || 'mcp_connection',
    });
    this.serverName = serverName;
    this.serverType = serverType;
    this.connectionDetails = connectionDetails;
    this.underlyingError = underlyingError;

    // Add specific troubleshooting suggestions based on server type
    this.addConnectionTroubleshootingSuggestions();
  }

  private addConnectionTroubleshootingSuggestions(): void {
    this.addSuggestion({
      type: 'retry',
      description: `Retry connection to MCP server "${this.serverName}" after a brief delay`,
    });

    switch (this.serverType) {
      case 'stdio':
        this.addSuggestion({
          type: 'manual',
          description:
            'Verify the command and arguments are correct and the executable is available in PATH',
        });
        if (this.connectionDetails.command) {
          this.addSuggestion({
            type: 'manual',
            description: `Check if command "${this.connectionDetails.command}" exists and is executable`,
          });
        }
        if (this.connectionDetails.cwd) {
          this.addSuggestion({
            type: 'manual',
            description: `Verify working directory "${this.connectionDetails.cwd}" exists and is accessible`,
          });
        }
        break;

      case 'sse':
      case 'streamable-http':
        this.addSuggestion({
          type: 'manual',
          description:
            'Check network connectivity and verify the server URL is correct',
        });
        if (this.connectionDetails.url) {
          this.addSuggestion({
            type: 'manual',
            description: `Verify URL "${this.connectionDetails.url}" is accessible and the server is running`,
          });
        }
        this.addSuggestion({
          type: 'manual',
          description: 'Check authentication credentials if required',
        });
        break;
    }

    this.addSuggestion({
      type: 'manual',
      description: 'Check server logs for additional error details',
    });
  }

  /**
   * Gets detailed connection troubleshooting information.
   */
  getConnectionTroubleshootingInfo(): string {
    const info = [
      `MCP Connection Error Details:`,
      `  Server: ${this.serverName}`,
      `  Type: ${this.serverType}`,
      `  Error: ${this.message}`,
    ];

    if (this.underlyingError) {
      info.push(`  Underlying Error: ${this.underlyingError.message}`);
    }

    info.push(`  Connection Details:`);
    Object.entries(this.connectionDetails).forEach(([key, value]) => {
      info.push(`    ${key}: ${JSON.stringify(value)}`);
    });

    info.push(`  Troubleshooting Steps:`);
    switch (this.serverType) {
      case 'stdio':
        info.push(
          `    1. Verify command exists: which ${this.connectionDetails.command || 'COMMAND'}`,
          `    2. Test command manually: ${this.connectionDetails.command || 'COMMAND'} ${(this.connectionDetails.args || []).join(' ')}`,
          `    3. Check working directory permissions: ls -la ${this.connectionDetails.cwd || process.cwd()}`,
          `    4. Verify environment variables are set correctly`,
        );
        break;

      case 'sse':
      case 'streamable-http':
        info.push(
          `    1. Test URL accessibility: curl -I ${this.connectionDetails.url || 'URL'}`,
          `    2. Check network connectivity and firewall settings`,
          `    3. Verify server is running and accepting connections`,
          `    4. Check authentication credentials and headers`,
        );
        break;
    }

    return info.join('\n');
  }
}

/**
 * Error thrown when MCP tool operations fail.
 */
export class MCPToolError extends AgentsError {
  serverName: string;
  toolName: string;
  operation: 'list' | 'call';
  toolArguments?: Record<string, any>;
  underlyingError?: Error;
  retryAttempt?: number;

  constructor(
    message: string,
    serverName: string,
    toolName: string,
    operation: 'list' | 'call',
    underlyingError?: Error,
    toolArguments?: Record<string, any>,
    retryAttempt?: number,
    state?: RunState<any, Agent<any, any>>,
    context?: Partial<EnhancedErrorContext>,
  ) {
    super(message, state, {
      ...context,
      lastSuccessfulOperation:
        context?.lastSuccessfulOperation || `mcp_tool_${operation}`,
    });
    this.serverName = serverName;
    this.toolName = toolName;
    this.operation = operation;
    this.toolArguments = toolArguments;
    this.underlyingError = underlyingError;
    this.retryAttempt = retryAttempt;

    this.addToolTroubleshootingSuggestions();
  }

  private addToolTroubleshootingSuggestions(): void {
    if (this.operation === 'call') {
      this.addSuggestion({
        type: 'retry',
        description: `Retry tool call "${this.toolName}" on server "${this.serverName}"`,
      });

      if (this.toolArguments) {
        this.addSuggestion({
          type: 'manual',
          description:
            'Verify tool arguments match the expected schema and types',
        });
      }

      this.addSuggestion({
        type: 'manual',
        description: `Check if tool "${this.toolName}" is available and properly implemented on server "${this.serverName}"`,
      });
    } else {
      this.addSuggestion({
        type: 'retry',
        description: `Retry listing tools from server "${this.serverName}"`,
      });

      this.addSuggestion({
        type: 'manual',
        description: `Verify server "${this.serverName}" is properly initialized and connected`,
      });
    }

    this.addSuggestion({
      type: 'manual',
      description: 'Check server logs for detailed error information',
    });

    if (this.retryAttempt && this.retryAttempt > 1) {
      this.addSuggestion({
        type: 'fallback',
        description: `Consider using alternative tools or adjusting retry configuration (attempt ${this.retryAttempt})`,
      });
    }
  }

  /**
   * Gets detailed tool error information for debugging.
   */
  getToolErrorInfo(): string {
    const info = [
      `MCP Tool Error Details:`,
      `  Server: ${this.serverName}`,
      `  Tool: ${this.toolName}`,
      `  Operation: ${this.operation}`,
      `  Error: ${this.message}`,
    ];

    if (this.retryAttempt) {
      info.push(`  Retry Attempt: ${this.retryAttempt}`);
    }

    if (this.underlyingError) {
      info.push(`  Underlying Error: ${this.underlyingError.message}`);
      if (this.underlyingError.stack) {
        info.push(`  Underlying Stack: ${this.underlyingError.stack}`);
      }
    }

    if (this.toolArguments) {
      info.push(
        `  Tool Arguments: ${JSON.stringify(this.toolArguments, null, 2)}`,
      );
    }

    return info.join('\n');
  }
}

/**
 * Utility class for implementing retry logic with configurable delays.
 */
export class MCPRetryManager {
  private config: MCPRetryConfig;

  constructor(config: Partial<MCPRetryConfig> = {}) {
    this.config = { ...DEFAULT_MCP_RETRY_CONFIG, ...config };
  }

  /**
   * Executes an operation with retry logic.
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    context?: {
      serverName?: string;
      toolName?: string;
      state?: RunState<any, Agent<any, any>>;
      errorContext?: Partial<EnhancedErrorContext>;
    },
  ): Promise<T> {
    let lastError: Error | undefined;
    let attempt = 0;

    while (attempt < this.config.maxAttempts) {
      attempt++;

      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on the last attempt
        if (attempt >= this.config.maxAttempts) {
          break;
        }

        // Calculate delay for next attempt
        const delay = this.calculateDelay(attempt);

        // Log retry attempt (unless quiet mode is enabled)
        if (!this.config.quiet) {
          console.warn(
            `MCP operation "${operationName}" failed (attempt ${attempt}/${this.config.maxAttempts}), retrying in ${delay}ms: ${lastError.message}`,
          );
        }

        // Wait before retrying
        await this.sleep(delay);
      }
    }

    // All retries exhausted, throw enhanced error
    const errorMessage = `MCP operation "${operationName}" failed after ${this.config.maxAttempts} attempts: ${lastError?.message}`;

    if (context?.serverName && context?.toolName) {
      throw new MCPToolError(
        errorMessage,
        context.serverName,
        context.toolName,
        operationName.includes('list') ? 'list' : 'call',
        lastError,
        undefined,
        attempt,
        context.state,
        context.errorContext,
      );
    } else if (context?.serverName) {
      throw new MCPConnectionError(
        errorMessage,
        context.serverName,
        'stdio', // Default, should be passed in context
        {},
        lastError,
        context.state,
        context.errorContext,
      );
    } else {
      throw new SystemError(
        errorMessage,
        context?.state,
        context?.errorContext,
      );
    }
  }

  /**
   * Calculates the delay for the next retry attempt.
   */
  private calculateDelay(attempt: number): number {
    let delay: number;

    switch (this.config.backoffStrategy) {
      case 'exponential':
        delay = Math.min(
          this.config.baseDelay *
            Math.pow(this.config.backoffMultiplier, attempt - 1),
          this.config.maxDelay,
        );
        break;

      case 'linear':
        delay = Math.min(this.config.baseDelay * attempt, this.config.maxDelay);
        break;

      case 'fixed':
      default:
        delay = this.config.baseDelay;
        break;
    }

    // Add jitter if enabled
    if (this.config.jitter) {
      delay = delay * (0.5 + Math.random() * 0.5);
    }

    return Math.floor(delay);
  }

  /**
   * Sleep for the specified number of milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Updates the retry configuration.
   */
  updateConfig(config: Partial<MCPRetryConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Gets the current retry configuration.
   */
  getConfig(): MCPRetryConfig {
    return { ...this.config };
  }
}
