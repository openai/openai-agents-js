# Performance Monitoring

The OpenAI Agents SDK includes comprehensive performance monitoring capabilities to help you track and optimize your agent workflows.

## Features

- **Execution Time Tracking**: Monitor total execution time, turn duration, and tool call performance
- **Memory Usage Monitoring**: Track memory consumption during agent execution
- **Token Usage Statistics**: Monitor input/output token consumption
- **Tool Call Analytics**: Detailed metrics for individual tool executions
- **Handoff Tracking**: Monitor agent handoff frequency and performance
- **Simple Metrics Collection**: Easy-to-use utilities for debugging performance issues

## Quick Start

### Basic Usage with PerformanceEnhancedRunner

```typescript
import { Agent, tool } from '@openai/agents-core';
import {
  PerformanceEnhancedRunner,
  createSimplePerformanceMonitor,
} from '@openai/agents-core/performance';

// Create your agent
const agent = new Agent({
  name: 'My Agent',
  instructions: 'You are a helpful assistant.',
  tools: [
    /* your tools */
  ],
});

// Create a performance-enhanced runner
const monitor = createSimplePerformanceMonitor();
const runner = new PerformanceEnhancedRunner({}, monitor);

// Run your agent
const result = await runner.run(agent, 'Hello, world!');

// Get performance reports
const reports = monitor.getReports();
console.log('Performance Report:', reports[0]);
```

### Manual Performance Tracking

```typescript
import { PerformanceMonitor } from '@openai/agents-core/performance';

const monitor = new PerformanceMonitor();

// Start tracking
const session = monitor.startTracking('my-agent');

if (session) {
  // Record metrics manually
  session.recordMetric('tool_call_time', 150, {
    toolName: 'calculator',
    success: true,
  });

  // End tracking and get report
  const report = monitor.endTracking(session);
  console.log('Execution time:', report?.execution.totalTime);
}
```

### Simple Performance Logging

```typescript
import {
  SimplePerformanceLogger,
  measureExecutionTime,
} from '@openai/agents-core/performance';

// Method 1: Using SimplePerformanceLogger
const logger = new SimplePerformanceLogger();
logger.start('agent-execution');
// ... your code ...
logger.end('agent-execution'); // Logs: [Performance] agent-execution: 123ms

// Method 2: Using measureExecutionTime
const { result, executionTime } = await measureExecutionTime(async () => {
  return await runner.run(agent, input);
}, 'Agent Run');
```

## API Reference

### PerformanceMonitor

The main class for performance monitoring.

```typescript
class PerformanceMonitor {
  startTracking(agentName: string): TrackingSession | null;
  endTracking(session: TrackingSession): PerformanceReport | null;
  recordMetric(
    session: TrackingSession,
    type: MetricType,
    value: number,
    metadata?: Record<string, any>,
  ): void;
  getReports(): PerformanceReport[];
  getReportsForAgent(agentName: string): PerformanceReport[];
  getStatistics(): Statistics;
  setEnabled(enabled: boolean): void;
}
```

### PerformanceReport

Contains comprehensive performance data for an agent run.

```typescript
interface PerformanceReport {
  agentName: string;
  execution: ExecutionMetrics;
  toolCalls: ToolCallMetrics[];
  memoryUsage: { start: number; peak: number; end: number };
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  handoffCount: number;
  timestamp: number;
}
```

### MetricType

Available metric types for tracking:

- `'agent_execution_time'`: Total agent execution time
- `'tool_call_time'`: Individual tool call duration
- `'turn_time'`: Time per conversation turn
- `'handoff_time'`: Handoff execution time
- `'memory_usage'`: Memory consumption
- `'token_usage'`: Token consumption

## Configuration

### PerformanceConfig

```typescript
interface PerformanceConfig {
  enabled: boolean; // Enable/disable monitoring
  collectDetailedMetrics: boolean; // Collect detailed metrics
  maxReports: number; // Maximum reports to keep in memory
  emitEvents: boolean; // Emit performance events
}
```

### Creating a Custom Monitor

```typescript
const monitor = new PerformanceMonitor({
  enabled: true,
  collectDetailedMetrics: true,
  maxReports: 50,
  emitEvents: false,
});
```

## Events

The PerformanceMonitor emits events that you can listen to:

```typescript
monitor.on('tracking-started', ({ agentName, sessionId }) => {
  console.log(`Started tracking ${agentName}`);
});

monitor.on('tracking-completed', (report) => {
  console.log(`Completed tracking for ${report.agentName}`);
});

monitor.on('metric-recorded', ({ sessionId, type, value, metadata }) => {
  console.log(`Recorded ${type}: ${value}`);
});
```

## Best Practices

1. **Use PerformanceEnhancedRunner** for automatic integration with existing workflows
2. **Monitor in Development** to identify performance bottlenecks early
3. **Set Reasonable Limits** on the number of reports kept in memory
4. **Disable in Production** if not needed to avoid overhead
5. **Use Simple Logging** for quick debugging during development

## Performance Overhead

The performance monitoring system is designed to have minimal overhead:

- Tracking adds approximately 1-5ms per agent run
- Memory usage is proportional to the number of reports stored
- Can be completely disabled with zero overhead when not needed

## Integration with Existing Code

The performance monitoring system integrates seamlessly with existing agent workflows:

```typescript
// Convert existing runner to performance-enhanced
import { withPerformanceMonitoring } from '@openai/agents-core/performance';

const existingRunner = new Runner(config);
const enhancedRunner = withPerformanceMonitoring(existingRunner);
```
