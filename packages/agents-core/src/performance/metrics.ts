/**
 * Core metrics types and classes for performance monitoring
 */

export type MetricType =
  | 'agent_execution_time'
  | 'tool_call_time'
  | 'turn_time'
  | 'handoff_time'
  | 'memory_usage'
  | 'token_usage';

export interface ExecutionMetrics {
  /** Total execution time in milliseconds */
  totalTime: number;
  /** Start timestamp */
  startTime: number;
  /** End timestamp */
  endTime: number;
  /** Number of turns executed */
  turnCount: number;
  /** Average time per turn */
  averageTurnTime: number;
}

export interface ToolCallMetrics {
  /** Tool name */
  toolName: string;
  /** Execution time in milliseconds */
  executionTime: number;
  /** Whether the tool call was successful */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Timestamp when tool was called */
  timestamp: number;
}

export interface PerformanceReport {
  /** Agent name */
  agentName: string;
  /** Overall execution metrics */
  execution: ExecutionMetrics;
  /** Tool call metrics */
  toolCalls: ToolCallMetrics[];
  /** Memory usage at different points */
  memoryUsage: {
    start: number;
    peak: number;
    end: number;
  };
  /** Token usage statistics */
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  /** Number of handoffs performed */
  handoffCount: number;
  /** Report generation timestamp */
  timestamp: number;
}

/**
 * Tracks performance metrics for agent execution
 */
export class AgentMetrics {
  private startTime: number = 0;
  private endTime: number = 0;
  private turnCount: number = 0;
  private toolCalls: ToolCallMetrics[] = [];
  private handoffCount: number = 0;
  private memoryUsage: { start: number; peak: number; end: number } = {
    start: 0,
    peak: 0,
    end: 0,
  };
  private tokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  constructor(private agentName: string) {}

  /**
   * Mark the start of agent execution
   */
  startExecution(): void {
    this.startTime = Date.now();
    this.memoryUsage.start = this.getCurrentMemoryUsage();
  }

  /**
   * Mark the end of agent execution
   */
  endExecution(): void {
    this.endTime = Date.now();
    this.memoryUsage.end = this.getCurrentMemoryUsage();
  }

  /**
   * Record a turn completion
   */
  recordTurn(): void {
    this.turnCount++;
    this.updatePeakMemory();
  }

  /**
   * Record a tool call
   */
  recordToolCall(metrics: Omit<ToolCallMetrics, 'timestamp'>): void {
    this.toolCalls.push({
      ...metrics,
      timestamp: Date.now(),
    });
    this.updatePeakMemory();
  }

  /**
   * Record a handoff
   */
  recordHandoff(): void {
    this.handoffCount++;
  }

  /**
   * Update token usage
   */
  updateTokenUsage(inputTokens: number, outputTokens: number): void {
    this.tokenUsage.inputTokens += inputTokens;
    this.tokenUsage.outputTokens += outputTokens;
    this.tokenUsage.totalTokens += inputTokens + outputTokens;
  }

  /**
   * Generate a performance report
   */
  generateReport(): PerformanceReport {
    const totalTime = this.endTime - this.startTime;
    const averageTurnTime = this.turnCount > 0 ? totalTime / this.turnCount : 0;

    return {
      agentName: this.agentName,
      execution: {
        totalTime,
        startTime: this.startTime,
        endTime: this.endTime,
        turnCount: this.turnCount,
        averageTurnTime,
      },
      toolCalls: [...this.toolCalls],
      memoryUsage: { ...this.memoryUsage },
      tokenUsage: { ...this.tokenUsage },
      handoffCount: this.handoffCount,
      timestamp: Date.now(),
    };
  }

  /**
   * Get current memory usage in MB
   */
  private getCurrentMemoryUsage(): number {
    if (typeof process !== 'undefined' && process.memoryUsage) {
      return process.memoryUsage().heapUsed / 1024 / 1024;
    }
    return 0;
  }

  /**
   * Update peak memory usage
   */
  private updatePeakMemory(): void {
    const current = this.getCurrentMemoryUsage();
    if (current > this.memoryUsage.peak) {
      this.memoryUsage.peak = current;
    }
  }
}
