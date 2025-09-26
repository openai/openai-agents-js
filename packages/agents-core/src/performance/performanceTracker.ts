/**
 * Performance tracking utilities for monitoring agent execution
 */

import { AgentMetrics, MetricType } from './metrics';

export interface TrackingSession {
  /** Session ID */
  id: string;
  /** Agent name being tracked */
  agentName: string;
  /** Start tracking */
  start(): void;
  /** End tracking */
  end(): void;
  /** Record a metric */
  recordMetric(
    type: MetricType,
    value: number,
    metadata?: Record<string, any>,
  ): void;
  /** Get the metrics instance */
  getMetrics(): AgentMetrics;
}

/**
 * Tracks performance metrics during agent execution
 */
export class PerformanceTracker {
  private activeSessions = new Map<string, TrackingSession>();
  private sessionCounter = 0;

  /**
   * Start tracking performance for an agent
   */
  startTracking(agentName: string): TrackingSession {
    const sessionId = `session_${++this.sessionCounter}_${Date.now()}`;
    const metrics = new AgentMetrics(agentName);

    const session: TrackingSession = {
      id: sessionId,
      agentName,
      start: () => {
        metrics.startExecution();
      },
      end: () => {
        metrics.endExecution();
        this.activeSessions.delete(sessionId);
      },
      recordMetric: (
        type: MetricType,
        value: number,
        metadata?: Record<string, any>,
      ) => {
        this.recordMetric(metrics, type, value, metadata);
      },
      getMetrics: () => metrics,
    };

    this.activeSessions.set(sessionId, session);
    return session;
  }

  /**
   * Get an active tracking session by ID
   */
  getSession(sessionId: string): TrackingSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): TrackingSession[] {
    return Array.from(this.activeSessions.values());
  }

  /**
   * Record a metric for a specific metrics instance
   */
  private recordMetric(
    metrics: AgentMetrics,
    type: MetricType,
    value: number,
    metadata?: Record<string, any>,
  ): void {
    switch (type) {
      case 'agent_execution_time':
        // This is handled by start/end execution
        break;
      case 'tool_call_time':
        if (metadata?.toolName) {
          metrics.recordToolCall({
            toolName: metadata.toolName,
            executionTime: value,
            success: metadata.success ?? true,
            error: metadata.error,
          });
        }
        break;
      case 'turn_time':
        metrics.recordTurn();
        break;
      case 'handoff_time':
        metrics.recordHandoff();
        break;
      case 'token_usage':
        if (
          metadata?.inputTokens !== undefined &&
          metadata?.outputTokens !== undefined
        ) {
          metrics.updateTokenUsage(metadata.inputTokens, metadata.outputTokens);
        }
        break;
      case 'memory_usage':
        // Memory usage is automatically tracked
        break;
    }
  }
}
