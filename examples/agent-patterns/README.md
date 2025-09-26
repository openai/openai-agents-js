# Agent Patterns Examples

This directory contains practical examples demonstrating common patterns and best practices for building robust OpenAI Agent applications.

## Files

### `retry-patterns.ts`

Demonstrates various retry and resilience patterns:

- **Exponential Backoff Retry**: Basic retry with exponential backoff
- **Circuit Breaker Pattern**: Prevents cascading failures
- **Resilient Agent**: Agent with built-in retry logic
- **Tool Retry**: Retry logic for tool calls
- **Multi-Agent Workflow**: Retry patterns in complex workflows

**Key Features:**

- Configurable retry attempts and delays
- Circuit breaker with automatic recovery
- Error classification and handling
- Production-ready implementations

**Usage:**

```bash
cd examples/agent-patterns
npm install
npx tsx retry-patterns.ts
```

## Pattern Categories

### 1. Retry Patterns

- **Basic Retry**: Simple retry with fixed or exponential backoff
- **Circuit Breaker**: Fail-fast pattern to prevent system overload
- **Bulkhead**: Isolate failures to prevent system-wide issues

### 2. Error Recovery

- **Graceful Degradation**: Provide reduced functionality when errors occur
- **Fallback Strategies**: Alternative approaches when primary methods fail
- **Context-Aware Recovery**: Tailor recovery based on error context

### 3. Resilience Patterns

- **Timeout Handling**: Prevent hanging operations
- **Resource Management**: Proper cleanup and resource allocation
- **Health Monitoring**: Continuous system health checks

## Best Practices Demonstrated

1. **Always implement retry logic** for production agents
2. **Use exponential backoff** to avoid overwhelming services
3. **Implement circuit breakers** for external dependencies
4. **Provide meaningful error messages** to users
5. **Log errors with context** for debugging
6. **Test failure scenarios** thoroughly
7. **Monitor system health** continuously

## Integration with OpenAI Agents

These patterns work seamlessly with:

- Basic agent operations (`agent.run()`)
- Tool execution and chaining
- Multi-agent handoffs
- Streaming responses
- MCP integrations

## Production Considerations

- **Monitoring**: Implement comprehensive logging and metrics
- **Configuration**: Make retry parameters configurable
- **Testing**: Test with various failure scenarios
- **Documentation**: Document retry behavior for users
- **Alerting**: Set up alerts for high failure rates

## Related Documentation

- [Troubleshooting Guide](../../docs/troubleshooting/)
- [API Examples](../../docs/api-examples/)
- [Streaming Patterns](../docs/practical-patterns/streaming-patterns.ts)
- [Error Recovery](../docs/practical-patterns/error-recovery.ts)
