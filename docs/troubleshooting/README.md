# Troubleshooting Guide

This directory contains comprehensive troubleshooting guides for common issues when working with OpenAI Agents.

## Guides Available

### [MCP Issues](./mcp-issues.md)

Complete guide for diagnosing and resolving Model Context Protocol (MCP) related problems:

- **Connection Issues**: Server connectivity, timeouts, network problems
- **Tool Discovery**: Missing tools, registration problems
- **Tool Execution**: Failures, timeouts, argument validation
- **Health Monitoring**: Server monitoring and automatic recovery
- **Best Practices**: Connection pooling, error recovery, logging

**Common Issues Covered:**

- `MCPConnectionError: Failed to connect to server`
- `Error: ECONNREFUSED` connection errors
- `Tool not found` errors
- Tool execution timeouts
- Server health monitoring

### [Streaming Issues](./streaming-issues.md)

Comprehensive guide for streaming response problems:

- **Connection Problems**: Stream setup, proxy issues, timeouts
- **Stream Interruption**: Recovery, partial responses, reconnection
- **Memory Issues**: Backpressure control, large response handling
- **Event Handling**: Missing events, out-of-order processing
- **Performance**: Optimization, metrics, monitoring

**Common Issues Covered:**

- Stream connection failures
- `Stream ended unexpectedly` errors
- Memory leaks with long streams
- Event handler problems
- Concurrent stream management

## Quick Reference

### MCP Troubleshooting Checklist

1. ✅ Server process is running
2. ✅ Correct port and URL configuration
3. ✅ Network connectivity (no firewall blocking)
4. ✅ Tools are properly registered
5. ✅ Timeout values are reasonable
6. ✅ Error handling is implemented

### Streaming Troubleshooting Checklist

1. ✅ Network connectivity is stable
2. ✅ Appropriate timeout values
3. ✅ Memory usage is reasonable
4. ✅ Stream error handling is implemented
5. ✅ Event handlers don't throw errors
6. ✅ Proper cleanup on stream end

## Getting Help

If these guides don't resolve your issue:

1. **Enable Debug Logging**: Turn on detailed logging to capture more context
2. **Create Minimal Reproduction**: Isolate the problem to the smallest possible case
3. **Check Server Logs**: Look at MCP server logs for additional context
4. **Test Network Connectivity**: Verify basic connectivity with curl/browser
5. **Review Configuration**: Double-check all configuration parameters

## Diagnostic Tools

### MCP Diagnostics

```typescript
import { Agent, MCPServerStdio } from '@openai/agents';

async function diagnoseMCP() {
  try {
    const server = new MCPServerStdio({
      command: 'uvx',
      args: ['mcp-server-filesystem'], // Replace with your server
    });

    const agent = new Agent({
      name: 'diagnostic-agent',
      instructions: 'Test MCP server functionality.',
      model: 'gpt-4',
      tools: [server],
    });

    const result = await agent.run('List your available tools');
    console.log('✅ MCP connection successful');
    console.log(
      'Agent response:',
      result.messages[result.messages.length - 1].content,
    );
  } catch (error) {
    console.error('❌ MCP diagnosis failed:', error);
  }
}
```

### Streaming Diagnostics

```typescript
import { Agent } from '@openai/agents';

async function diagnoseStreaming() {
  const agent = new Agent({
    name: 'test-agent',
    model: 'gpt-4',
  });

  try {
    const stream = await agent.run('Test message', { stream: true });

    let chunkCount = 0;
    for await (const chunk of stream) {
      chunkCount++;
      if (chunk.type === 'text') {
        process.stdout.write('.');
      }
    }

    console.log(`\n✅ Streaming successful (${chunkCount} chunks)`);
  } catch (error) {
    console.error('❌ Streaming diagnosis failed:', error);
  }
}
```

## Related Resources

- [API Examples](../api-examples/)
- [Practical Patterns](../docs/practical-patterns/)
- [Agent Patterns](../../examples/agent-patterns/)
- [MCP Examples](../../examples/mcp/)

## Contributing

Found a solution to a common problem not covered here? Please contribute by:

1. Adding to existing guides
2. Creating new troubleshooting sections
3. Providing diagnostic code examples
4. Sharing production experiences
