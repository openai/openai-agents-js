/**
 * Middleware for integrating performance monitoring with agent execution
 */

import { PerformanceMonitor } from './performanceMonitor';
import { TrackingSession } from './performanceTracker';

/**
 * Creates performance monitoring middleware that can be integrated with agent runs
 */
export function createPerformanceMiddleware(monitor: PerformanceMonitor) {
  const activeSessions = new WeakMap<any, TrackingSession>();

  return {
    /**
     * Start performance tracking for an agent run
     */
    onAgentStart: (agentName: string, context: any) => {
      const session = monitor.startTracking(agentName);
      if (session) {
        activeSessions.set(context, session);
      }
    },

    /**
     * End performance tracking for an agent run
     */
    onAgentEnd: (context: any) => {
      const session = activeSessions.get(context);
      if (session) {
        monitor.endTracking(session);
        activeSessions.delete(context);
      }
    },

    /**
     * Record a turn completion
     */
    onTurnComplete: (context: any) => {
      const session = activeSessions.get(context);
      if (session) {
        monitor.recordMetric(session, 'turn_time', Date.now());
      }
    },

    /**
     * Record a tool call
     */
    onToolCall: (
      context: any,
      toolName: string,
      startTime: number,
      endTime: number,
      success: boolean,
      error?: string,
    ) => {
      const session = activeSessions.get(context);
      if (session) {
        monitor.recordMetric(session, 'tool_call_time', endTime - startTime, {
          toolName,
          success,
          error,
        });
      }
    },

    /**
     * Record a handoff
     */
    onHandoff: (context: any) => {
      const session = activeSessions.get(context);
      if (session) {
        monitor.recordMetric(session, 'handoff_time', Date.now());
      }
    },

    /**
     * Record token usage
     */
    onTokenUsage: (context: any, inputTokens: number, outputTokens: number) => {
      const session = activeSessions.get(context);
      if (session) {
        monitor.recordMetric(
          session,
          'token_usage',
          inputTokens + outputTokens,
          {
            inputTokens,
            outputTokens,
          },
        );
      }
    },

    /**
     * Get the active session for a context
     */
    getSession: (context: any): TrackingSession | undefined => {
      return activeSessions.get(context);
    },
  };
}
