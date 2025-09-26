/**
 * Performance-enhanced runner that integrates performance monitoring with agent execution
 */

import {
  Runner,
  RunConfig,
  IndividualRunOptions,
  NonStreamRunOptions,
  StreamRunOptions,
} from '../run';
import { Agent } from '../agent';
import { RunResult, StreamedRunResult } from '../result';
import { RunState } from '../runState';
import { AgentInputItem } from '../types';
import { PerformanceMonitor } from './performanceMonitor';
import { createPerformanceMiddleware } from './middleware';
import { TrackingSession } from './performanceTracker';

/**
 * Enhanced runner with integrated performance monitoring
 */
export class PerformanceEnhancedRunner extends Runner {
  private performanceMonitor: PerformanceMonitor;
  private middleware: ReturnType<typeof createPerformanceMiddleware>;
  private activeSessions = new WeakMap<any, TrackingSession>();

  constructor(
    config: Partial<RunConfig> = {},
    performanceMonitor?: PerformanceMonitor,
  ) {
    super(config);
    this.performanceMonitor = performanceMonitor || new PerformanceMonitor();
    this.middleware = createPerformanceMiddleware(this.performanceMonitor);

    // Set up event listeners for performance tracking
    this.setupPerformanceTracking();
  }

  /**
   * Get the performance monitor instance
   */
  getPerformanceMonitor(): PerformanceMonitor {
    return this.performanceMonitor;
  }

  /**
   * Run an agent with performance monitoring (non-streaming)
   */
  async run<TAgent extends Agent<any, any>, TContext = undefined>(
    agent: TAgent,
    input: string | AgentInputItem[] | RunState<TContext, TAgent>,
    options?: NonStreamRunOptions<TContext>,
  ): Promise<RunResult<TContext, TAgent>>;

  /**
   * Run an agent with performance monitoring (streaming)
   */
  async run<TAgent extends Agent<any, any>, TContext = undefined>(
    agent: TAgent,
    input: string | AgentInputItem[] | RunState<TContext, TAgent>,
    options?: StreamRunOptions<TContext>,
  ): Promise<StreamedRunResult<TContext, TAgent>>;

  /**
   * Run an agent with performance monitoring (implementation)
   */
  async run<TAgent extends Agent<any, any>, TContext = undefined>(
    agent: TAgent,
    input: string | AgentInputItem[] | RunState<TContext, TAgent>,
    options?: IndividualRunOptions<TContext>,
  ): Promise<
    RunResult<TContext, TAgent> | StreamedRunResult<TContext, TAgent>
  > {
    // Start performance tracking
    const session = this.performanceMonitor.startTracking(agent.name);

    try {
      // Store session for middleware access
      if (session) {
        this.activeSessions.set(input, session);
      }

      // Call the parent run method with proper type handling
      let result:
        | RunResult<TContext, TAgent>
        | StreamedRunResult<TContext, TAgent>;

      if (options?.stream === true) {
        result = await super.run(
          agent,
          input,
          options as StreamRunOptions<TContext>,
        );
      } else {
        result = await super.run(
          agent,
          input,
          options as NonStreamRunOptions<TContext>,
        );
      }

      // End performance tracking and generate report
      if (session) {
        const report = this.performanceMonitor.endTracking(session);

        // Add performance data to result if it's a RunResult
        if (result instanceof RunResult && report) {
          (result as any).performanceReport = report;
        }
      }

      return result;
    } catch (error) {
      // End tracking even on error
      if (session) {
        this.performanceMonitor.endTracking(session);
      }
      throw error;
    } finally {
      // Clean up session reference
      if (session) {
        this.activeSessions.delete(input);
      }
    }
  }

  /**
   * Set up performance tracking event listeners
   */
  private setupPerformanceTracking(): void {
    // Track agent lifecycle
    this.on('agent_start', (context, agent) => {
      this.middleware.onAgentStart(agent.name, context);
    });

    this.on('agent_end', (context, _agent, _output) => {
      this.middleware.onAgentEnd(context);
    });

    // Track tool calls
    this.on('agent_tool_start', (context, agent, tool, details) => {
      const startTime = Date.now();
      // Store start time for later use
      (details as any)._performanceStartTime = startTime;
    });

    this.on('agent_tool_end', (context, agent, tool, output, details) => {
      const endTime = Date.now();
      const startTime = (details as any)?._performanceStartTime || endTime;

      this.middleware.onToolCall(
        context,
        tool.name,
        startTime,
        endTime,
        true, // success
      );
    });

    // Track token usage (this would need to be integrated with the model response handling)
    // For now, we'll add a method to manually record token usage
  }

  /**
   * Manually record token usage for performance tracking
   */
  recordTokenUsage(
    context: any,
    inputTokens: number,
    outputTokens: number,
  ): void {
    this.middleware.onTokenUsage(context, inputTokens, outputTokens);
  }

  /**
   * Manually record a turn completion
   */
  recordTurnComplete(context: any): void {
    this.middleware.onTurnComplete(context);
  }

  /**
   * Manually record a handoff
   */
  recordHandoff(context: any): void {
    this.middleware.onHandoff(context);
  }
}
