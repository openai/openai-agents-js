# OpenAI Agents Documentation

This directory contains comprehensive documentation and guides for the OpenAI Agents SDK.

## Documentation Structure

### [API Examples](./api-examples/)

- **[Comprehensive Guide](./api-examples/comprehensive-guide.md)**: Complete API reference with practical examples covering all major features

### [Troubleshooting](./troubleshooting/)

- **[MCP Issues](./troubleshooting/mcp-issues.md)**: Complete guide for Model Context Protocol troubleshooting
- **[Streaming Issues](./troubleshooting/streaming-issues.md)**: Comprehensive streaming response troubleshooting

## Key Features Covered

### Agent Patterns

- Basic agent creation and configuration
- Conversational agents with memory
- Multi-agent workflows and handoffs
- Error handling and recovery strategies

### Tool Integration

- Basic tool usage with validation
- Advanced tool composition and chaining
- MCP server integration
- Tool error handling and fallbacks

### Streaming

- Real-time response streaming
- Progressive content generation
- Stream interruption and recovery
- Performance optimization

### Production Patterns

- Connection pooling and resource management
- Response caching and deduplication
- Comprehensive error handling
- Monitoring and metrics collection
- Security and compliance features

## Quick Start Examples

### Basic Agent

```typescript
import { Agent, run } from '@openai/agents';

const agent = new Agent({
  name: 'helpful-assistant',
  instructions: 'You are a helpful assistant.',
});

const result = await run(agent, 'What is machine learning?');
console.log(result.finalOutput);
```

### Agent with Tools

```typescript
import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';

const weatherTool = tool({
  name: 'get_weather',
  description: 'Get current weather',
  parameters: z.object({
    location: z.string().describe('City name'),
  }),
  execute: async ({ location }) => {
    return `Weather in ${location}: Sunny, 72°F`;
  },
});

const agent = new Agent({
  name: 'weather-assistant',
  instructions: 'Help users get weather information.',
  tools: [weatherTool],
});

const result = await run(agent, "What's the weather in San Francisco?");
```

### Streaming Response

```typescript
const stream = await run(agent, 'Tell me a story', { stream: true });

// Use text stream for real-time updates
const textStream = stream.toTextStream({ compatibleWithNodeStreams: true });
textStream.pipe(process.stdout);
```

### MCP Integration

```typescript
import { Agent, MCPServerStdio } from '@openai/agents';

const server = new MCPServerStdio({
  command: 'uvx',
  args: ['mcp-server-filesystem'],
});

const agent = new Agent({
  name: 'file-assistant',
  instructions: 'Help users with file operations.',
  tools: [server],
});
```

## Related Examples

- [Agent Patterns](../examples/agent-patterns/): Retry patterns and resilience strategies
- [Practical Patterns](../examples/docs/practical-patterns/): Real-world implementation patterns
- [Basic Examples](../examples/basic/): Simple getting started examples
- [MCP Examples](../examples/mcp/): Model Context Protocol integration examples

## Contributing

When adding new documentation:

1. **Follow the established structure** with clear sections and examples
2. **Include practical, runnable code** that demonstrates real-world usage
3. **Provide troubleshooting guidance** for common issues
4. **Test all code examples** to ensure they work with the current API
5. **Update this README** to reference new documentation

## Best Practices

1. **Always include error handling** in production code
2. **Use TypeScript** for better developer experience
3. **Implement retry logic** for resilient applications
4. **Monitor performance** and resource usage
5. **Follow security best practices** for production deployments
6. **Test with various scenarios** including failure cases
7. **Document configuration options** and their effects
