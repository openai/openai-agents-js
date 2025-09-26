/**
 * Utility functions for integrating performance monitoring
 */

import { Runner } from '../run';
import { PerformanceMonitor } from './performanceMonitor';
import { PerformanceEnhancedRunner } from './performanceEnhancedRunner';

/**
 * Create a performance-enhanced version of an existing runner
 */
export function withPerformanceMonitoring(
  runner: Runner,
  monitor?: PerformanceMonitor,
): PerformanceEnhancedRunner {
  return new PerformanceEnhancedRunner(runner.config, monitor);
}

/**
 * Create a simple performance monitor with default configuration
 */
export function createSimplePerformanceMonitor(): PerformanceMonitor {
  return new PerformanceMonitor({
    enabled: true,
    collectDetailedMetrics: true,
    maxReports: 50,
    emitEvents: false, // Disable events for simple usage
  });
}

/**
 * Measure execution time of a function
 */
export async function measureExecutionTime<T>(
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

/**
 * Simple performance logger for debugging
 */
export class SimplePerformanceLogger {
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
