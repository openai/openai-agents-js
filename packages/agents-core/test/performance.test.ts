/**
 * Tests for performance monitoring functionality
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PerformanceMonitor,
  AgentMetrics,
  PerformanceTracker,
  createSimplePerformanceMonitor,
  measureExecutionTime,
  SimplePerformanceLogger,
} from '../src/performance';

describe('Performance Monitoring', () => {
  describe('AgentMetrics', () => {
    let metrics: AgentMetrics;

    beforeEach(() => {
      metrics = new AgentMetrics('test-agent');
    });

    it('should track execution time', () => {
      metrics.startExecution();
      // Simulate some execution time
      const _startTime = Date.now();
      metrics.endExecution();

      const report = metrics.generateReport();
      expect(report.agentName).toBe('test-agent');
      expect(report.execution.totalTime).toBeGreaterThanOrEqual(0);
      expect(report.execution.startTime).toBeGreaterThan(0);
      expect(report.execution.endTime).toBeGreaterThan(0);
    });

    it('should track turns', () => {
      metrics.startExecution();
      metrics.recordTurn();
      metrics.recordTurn();
      metrics.endExecution();

      const report = metrics.generateReport();
      expect(report.execution.turnCount).toBe(2);
      expect(report.execution.averageTurnTime).toBeGreaterThanOrEqual(0);
    });

    it('should track tool calls', () => {
      metrics.startExecution();
      metrics.recordToolCall({
        toolName: 'test-tool',
        executionTime: 100,
        success: true,
      });
      metrics.recordToolCall({
        toolName: 'failing-tool',
        executionTime: 50,
        success: false,
        error: 'Tool failed',
      });
      metrics.endExecution();

      const report = metrics.generateReport();
      expect(report.toolCalls).toHaveLength(2);
      expect(report.toolCalls[0].toolName).toBe('test-tool');
      expect(report.toolCalls[0].success).toBe(true);
      expect(report.toolCalls[1].success).toBe(false);
      expect(report.toolCalls[1].error).toBe('Tool failed');
    });

    it('should track handoffs', () => {
      metrics.startExecution();
      metrics.recordHandoff();
      metrics.recordHandoff();
      metrics.endExecution();

      const report = metrics.generateReport();
      expect(report.handoffCount).toBe(2);
    });

    it('should track token usage', () => {
      metrics.startExecution();
      metrics.updateTokenUsage(100, 50);
      metrics.updateTokenUsage(200, 75);
      metrics.endExecution();

      const report = metrics.generateReport();
      expect(report.tokenUsage.inputTokens).toBe(300);
      expect(report.tokenUsage.outputTokens).toBe(125);
      expect(report.tokenUsage.totalTokens).toBe(425);
    });
  });

  describe('PerformanceTracker', () => {
    let tracker: PerformanceTracker;

    beforeEach(() => {
      tracker = new PerformanceTracker();
    });

    it('should create and manage tracking sessions', () => {
      const session = tracker.startTracking('test-agent');

      expect(session.agentName).toBe('test-agent');
      expect(session.id).toBeDefined();
      expect(tracker.getActiveSessions()).toHaveLength(1);

      session.end();
      expect(tracker.getActiveSessions()).toHaveLength(0);
    });

    it('should record metrics through sessions', () => {
      const session = tracker.startTracking('test-agent');
      session.start();

      session.recordMetric('tool_call_time', 100, {
        toolName: 'test-tool',
        success: true,
      });

      session.end();

      const report = session.getMetrics().generateReport();
      expect(report.toolCalls).toHaveLength(1);
      expect(report.toolCalls[0].toolName).toBe('test-tool');
    });
  });

  describe('PerformanceMonitor', () => {
    let monitor: PerformanceMonitor;

    beforeEach(() => {
      monitor = new PerformanceMonitor();
    });

    it('should track agent execution and generate reports', () => {
      const session = monitor.startTracking('test-agent');
      expect(session).toBeDefined();

      if (session) {
        session.recordMetric('tool_call_time', 150, {
          toolName: 'test-tool',
          success: true,
        });

        const report = monitor.endTracking(session);
        expect(report).toBeDefined();
        expect(report?.agentName).toBe('test-agent');
        expect(monitor.getReports()).toHaveLength(1);
      }
    });

    it('should maintain report history', () => {
      const session1 = monitor.startTracking('agent-1');
      const session2 = monitor.startTracking('agent-2');

      if (session1 && session2) {
        monitor.endTracking(session1);
        monitor.endTracking(session2);

        expect(monitor.getReports()).toHaveLength(2);
        expect(monitor.getReportsForAgent('agent-1')).toHaveLength(1);
        expect(monitor.getReportsForAgent('agent-2')).toHaveLength(1);
      }
    });

    it('should generate statistics', () => {
      const session = monitor.startTracking('test-agent');
      if (session) {
        session.recordMetric('tool_call_time', 100, {
          toolName: 'tool-1',
          success: true,
        });
        session.recordMetric('tool_call_time', 200, {
          toolName: 'tool-2',
          success: true,
        });

        monitor.endTracking(session);

        const stats = monitor.getStatistics();
        expect(stats.totalRuns).toBe(1);
        expect(stats.totalToolCalls).toBe(2);
        expect(stats.averageToolCallTime).toBe(150);
      }
    });

    it('should respect enabled/disabled state', () => {
      monitor.setEnabled(false);
      const session = monitor.startTracking('test-agent');
      expect(session).toBeNull();

      monitor.setEnabled(true);
      const session2 = monitor.startTracking('test-agent');
      expect(session2).toBeDefined();
    });
  });

  describe('Utility Functions', () => {
    it('should create simple performance monitor', () => {
      const monitor = createSimplePerformanceMonitor();
      expect(monitor.isEnabled()).toBe(true);
    });

    it('should measure execution time', async () => {
      const result = await measureExecutionTime(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 'test-result';
      });

      expect(result.result).toBe('test-result');
      expect(result.executionTime).toBeGreaterThanOrEqual(10);
    });

    it('should work with SimplePerformanceLogger', () => {
      const logger = new SimplePerformanceLogger();

      logger.start('test-operation');
      // Simulate some work
      const executionTime = logger.end('test-operation');

      expect(executionTime).toBeGreaterThanOrEqual(0);
    });
  });
});
