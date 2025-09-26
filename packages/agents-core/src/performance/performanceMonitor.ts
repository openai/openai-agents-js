/**
 * Main performance monitoring class
 */

import { RuntimeEventEmitter } from '@openai/agents-core/_shims';
import { PerformanceTracker, TrackingSession } from './performanceTracker';
import { PerformanceReport, MetricType } from './metrics';

export interface PerformanceConfig {
  /** Whether to enable performance monitoring */
  enabled: boolean;
  /** Whether to collect detailed metrics */
  collectDetailedMetrics: boolean;
  /** Maximum number of reports to keep in memory */
  maxReports: number;
  /** Whether to emit performance events */
  emitEvents: boolean;
}

/**
 * Main performance monitoring system for agents
 */
export class PerformanceMonitor extends RuntimeEventEmitter {
  private tracker: PerformanceTracker;
  private reports: PerformanceReport[] = [];
  private config: PerformanceConfig;

  constructor(config: Partial<PerformanceConfig> = {}) {
    super();
    this.config = {
      enabled: true,
      collectDetailedMetrics: true,
      maxReports: 100,
      emitEvents: true,
      ...config,
    };
    this.tracker = new PerformanceTracker();
  }

  /**
   * Start tracking performance for an agent
   */
  startTracking(agentName: string): TrackingSession | null {
    if (!this.config.enabled) {
      return null;
    }

    const session = this.tracker.startTracking(agentName);
    session.start();

    if (this.config.emitEvents) {
      this.emit('tracking-started', { agentName, sessionId: session.id });
    }

    return session;
  }

  /**
   * End tracking and generate a report
   */
  endTracking(session: TrackingSession): PerformanceReport | null {
    if (!this.config.enabled || !session) {
      return null;
    }

    session.end();
    const report = session.getMetrics().generateReport();

    // Store report
    this.reports.push(report);

    // Maintain max reports limit
    if (this.reports.length > this.config.maxReports) {
      this.reports.shift();
    }

    if (this.config.emitEvents) {
      this.emit('tracking-completed', report);
    }

    return report;
  }

  /**
   * Record a metric for a specific session
   */
  recordMetric(
    session: TrackingSession | null,
    type: MetricType,
    value: number,
    metadata?: Record<string, any>,
  ): void {
    if (!this.config.enabled || !session) {
      return;
    }

    session.recordMetric(type, value, metadata);

    if (this.config.emitEvents) {
      this.emit('metric-recorded', {
        sessionId: session.id,
        type,
        value,
        metadata,
      });
    }
  }

  /**
   * Get all performance reports
   */
  getReports(): PerformanceReport[] {
    return [...this.reports];
  }

  /**
   * Get reports for a specific agent
   */
  getReportsForAgent(agentName: string): PerformanceReport[] {
    return this.reports.filter((report) => report.agentName === agentName);
  }

  /**
   * Get the latest report
   */
  getLatestReport(): PerformanceReport | undefined {
    return this.reports[this.reports.length - 1];
  }

  /**
   * Clear all stored reports
   */
  clearReports(): void {
    this.reports = [];
  }

  /**
   * Get performance statistics across all reports
   */
  getStatistics(): {
    totalRuns: number;
    averageExecutionTime: number;
    totalToolCalls: number;
    averageToolCallTime: number;
    totalHandoffs: number;
  } {
    if (this.reports.length === 0) {
      return {
        totalRuns: 0,
        averageExecutionTime: 0,
        totalToolCalls: 0,
        averageToolCallTime: 0,
        totalHandoffs: 0,
      };
    }

    const totalExecutionTime = this.reports.reduce(
      (sum, report) => sum + report.execution.totalTime,
      0,
    );

    const allToolCalls = this.reports.flatMap((report) => report.toolCalls);
    const totalToolCallTime = allToolCalls.reduce(
      (sum, toolCall) => sum + toolCall.executionTime,
      0,
    );

    const totalHandoffs = this.reports.reduce(
      (sum, report) => sum + report.handoffCount,
      0,
    );

    return {
      totalRuns: this.reports.length,
      averageExecutionTime: totalExecutionTime / this.reports.length,
      totalToolCalls: allToolCalls.length,
      averageToolCallTime:
        allToolCalls.length > 0 ? totalToolCallTime / allToolCalls.length : 0,
      totalHandoffs,
    };
  }

  /**
   * Enable or disable performance monitoring
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  /**
   * Check if performance monitoring is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }
}
