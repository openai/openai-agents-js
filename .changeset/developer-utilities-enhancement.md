---
'@openai/agents-core': minor
'@openai/agents-extensions': patch
---

Add comprehensive developer utilities and enhancements

This release introduces a comprehensive set of developer utilities and enhancements to improve the development experience with OpenAI Agents:

## Enhanced Error Handling and Debugging

- Added contextual error information including agent name, turn number, and operation details
- Improved error messages for tool calls, guardrails, and streaming interruptions
- Enhanced MCP server connection error reporting with troubleshooting guidance

## Performance Monitoring Framework

- New `PerformanceMonitor` class for tracking agent execution metrics
- `PerformanceEnhancedRunner` for automatic performance tracking
- Execution time tracking for agent runs and tool calls
- Memory usage monitoring and reporting
- Simple performance logging utilities with `SimplePerformanceLogger`
- Utility functions like `measureExecutionTime` for manual performance tracking

## Testing Utilities

- `MockAgentFactory` for creating test agents with predefined responses
- Tool testing helpers for mocking execution and simulating failures
- Streaming test utilities for testing interruptions and events
- Enhanced test patterns for agent workflows

## MCP Reliability Improvements

- Enhanced error messages for MCP connection and tool failures
- Improved retry logic for MCP operations with configurable delays
- Better connection health monitoring and automatic reconnection
- Detailed MCP troubleshooting documentation

## Advanced Examples and Patterns

- Retry pattern examples with exponential backoff and circuit breaker implementations
- Streaming patterns for real-time applications including progressive content generation
- Multi-agent coordination examples with sequential processing
- Performance monitoring examples demonstrating practical usage

## Documentation and Troubleshooting

- Comprehensive troubleshooting guides for MCP and streaming issues
- Practical examples integrated into existing API documentation
- Best practices for error handling, performance optimization, and testing
- Quick diagnostic checklists for common issues

## New Exports

- `@openai/agents/performance`: Performance monitoring utilities including PerformanceMonitor, SimplePerformanceLogger, and measureExecutionTime
- `@openai/agents/testing`: Testing utilities and mock factories (when implemented)
- Enhanced error classes with contextual information
- Utility functions for debugging and diagnostics

These enhancements maintain full backward compatibility while providing powerful new tools for developers to build, test, and monitor their agent applications more effectively.
