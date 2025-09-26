# OpenAI Agents - Comprehensive API Guide with Practical Examples

This guide provides practical examples for all major OpenAI Agents features, demonstrating real-world usage patterns and best practices.

## Table of Contents

1. [Basic Agent Creation and Usage](#basic-agent-creation-and-usage)
2. [Tool Integration](#tool-integration)
3. [Multi-Agent Handoffs](#multi-agent-handoffs)
4. [Streaming Responses](#streaming-responses)
5. [Error Handling and Recovery](#error-handling-and-recovery)
6. [MCP Integration](#mcp-integration)
7. [Performance Optimization](#performance-optimization)
8. [Production Patterns](#production-patterns)

## Basic Agent Creation and Usage

### Simple Agent

```typescript
import { Agent, run } from '@openai/agents';

// Create a basic agent
const agent = new Agent({
  name: 'helpful-assistant',
  instructions:
    'You are a helpful assistant that provides clear, concise answers.',
});

// Run the agent
const result = await run(agent, 'What is machine learning?');
console.log(result.finalOutput);
```

### Agent with Custom Configuration

```typescript
const customAgent = new Agent({
  name: 'technical-writer',
  instructions: `You are a technical writer specializing in software documentation. 
                 Always provide examples and explain complex concepts clearly.
                 Context: The user is a junior developer learning web development.`,
});

// Use the agent
const conversation = await run(customAgent, 'Explain REST APIs');
```

### Agent with Memory and Context

```typescript
class ConversationalAgent {
  private agent: Agent;
  private conversationHistory: string[] = [];

  constructor() {
    this.agent = new Agent({
      name: 'conversational-assistant',
      instructions:
        'You are a conversational assistant that remembers context from previous messages.',
      model: 'gpt-4',
    });
  }

  async chat(message: string): Promise<string> {
    // Build context from history
    const context =
      this.conversationHistory.length > 0
        ? `Previous conversation:\n${this.conversationHistory.join('\n')}\n\nCurrent message: ${message}`
        : message;

    const result = await run(this.agent, context);
    const response = result.finalOutput;

    // Update history
    this.conversationHistory.push(`User: ${message}`);
    this.conversationHistory.push(`Assistant: ${response}`);

    // Keep only last 10 exchanges
    if (this.conversationHistory.length > 20) {
      this.conversationHistory = this.conversationHistory.slice(-20);
    }

    return response;
  }
}

// Usage
const chatAgent = new ConversationalAgent();
await chatAgent.chat("Hello, I'm learning JavaScript");
await chatAgent.chat('Can you explain closures?'); // Agent remembers context
```

## Tool Integration

### Basic Tool Usage

```typescript
import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';

const weatherTool = tool({
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: z.object({
    location: z.string().describe('City name'),
    units: z
      .enum(['celsius', 'fahrenheit'])
      .default('celsius')
      .describe('Temperature units'),
  }),
  execute: async ({ location, units }) => {
    // Simulate API call
    const temp = units === 'fahrenheit' ? '72°F' : '22°C';
    return `Weather in ${location}: Sunny, ${temp}`;
  },
});

const weatherAgent = new Agent({
  name: 'weather-assistant',
  instructions: 'Help users get weather information using the available tools.',
  tools: [weatherTool],
});

const result = await run(weatherAgent, "What's the weather like in London?");
```

### Advanced Tool with Validation

```typescript
const databaseTool = {
  name: 'query_database',
  description: 'Query the user database',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'SQL query to execute' },
      limit: { type: 'number', default: 10, maximum: 100 },
    },
    required: ['query'],
  },
  execute: async (args: { query: string; limit?: number }) => {
    // Validate query for safety
    const dangerousKeywords = ['DROP', 'DELETE', 'UPDATE', 'INSERT'];
    const upperQuery = args.query.toUpperCase();

    if (dangerousKeywords.some((keyword) => upperQuery.includes(keyword))) {
      throw new Error('Only SELECT queries are allowed');
    }

    // Simulate database query
    return {
      results: [
        { id: 1, name: 'John Doe', email: 'john@example.com' },
        { id: 2, name: 'Jane Smith', email: 'jane@example.com' },
      ],
      count: 2,
      query: args.query,
    };
  },
};

const dbAgent = new Agent({
  name: 'database-assistant',
  instructions:
    'Help users query the database safely. Only allow SELECT operations.',
  model: 'gpt-4',
  tools: [databaseTool],
});
```

### Tool Composition and Chaining

```typescript
const fileReadTool = {
  name: 'read_file',
  description: 'Read contents of a file',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to read' },
    },
    required: ['path'],
  },
  execute: async (args: { path: string }) => {
    // Simulate file reading
    return `Contents of ${args.path}: Sample file content...`;
  },
};

const fileAnalyzeTool = {
  name: 'analyze_file',
  description: 'Analyze file content for patterns',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'File content to analyze' },
      analysisType: {
        type: 'string',
        enum: ['syntax', 'security', 'performance'],
      },
    },
    required: ['content', 'analysisType'],
  },
  execute: async (args: { content: string; analysisType: string }) => {
    return `${args.analysisType} analysis of content: No issues found.`;
  },
};

const fileAgent = new Agent({
  name: 'file-analyzer',
  instructions:
    'Help users read and analyze files. First read the file, then analyze it.',
  model: 'gpt-4',
  tools: [fileReadTool, fileAnalyzeTool],
});

// Agent will automatically chain tools: read_file -> analyze_file
const result = await fileAgent.run(
  'Please analyze the security of config.json',
);
```

## Multi-Agent Handoffs

### Basic Handoff Pattern

```typescript
const researchAgent = new Agent({
  name: 'researcher',
  instructions:
    'Research topics thoroughly and hand off to the writer when done.',
  model: 'gpt-4',
});

const writerAgent = new Agent({
  name: 'writer',
  instructions: 'Write articles based on research provided by the researcher.',
  model: 'gpt-4',
});

// Configure handoffs
researchAgent.handoff('writer', writerAgent, {
  description: 'Hand off research to writer for article creation',
});

// Start with research agent
const result = await researchAgent.run(
  'Research and write an article about renewable energy',
);
// Agent will automatically hand off to writer when research is complete
```

### Conditional Handoffs

```typescript
const triageAgent = new Agent({
  name: 'triage',
  instructions: `You are a triage agent. Analyze user requests and hand off to appropriate specialists:
                 - Technical questions -> technical-support
                 - Billing questions -> billing-support
                 - General questions -> general-support`,
  model: 'gpt-4',
});

const technicalAgent = new Agent({
  name: 'technical-support',
  instructions: 'Provide technical support and solutions.',
  model: 'gpt-4',
});

const billingAgent = new Agent({
  name: 'billing-support',
  instructions: 'Handle billing and payment related questions.',
  model: 'gpt-4',
});

const generalAgent = new Agent({
  name: 'general-support',
  instructions: 'Provide general customer support.',
  model: 'gpt-3.5-turbo',
});

// Set up handoffs
triageAgent.handoff('technical-support', technicalAgent);
triageAgent.handoff('billing-support', billingAgent);
triageAgent.handoff('general-support', generalAgent);

// Triage will automatically route to appropriate agent
const result = await triageAgent.run('My API is returning 500 errors');
```

### Multi-Step Workflow with Handoffs

```typescript
class WorkflowOrchestrator {
  private agents: Map<string, Agent> = new Map();

  constructor() {
    this.setupAgents();
    this.configureHandoffs();
  }

  private setupAgents() {
    this.agents.set(
      'planner',
      new Agent({
        name: 'planner',
        instructions:
          'Create detailed project plans and hand off to implementer.',
        model: 'gpt-4',
      }),
    );

    this.agents.set(
      'implementer',
      new Agent({
        name: 'implementer',
        instructions: 'Implement plans and hand off to reviewer when complete.',
        model: 'gpt-4',
      }),
    );

    this.agents.set(
      'reviewer',
      new Agent({
        name: 'reviewer',
        instructions:
          'Review implementations and provide feedback or approval.',
        model: 'gpt-4',
      }),
    );
  }

  private configureHandoffs() {
    const planner = this.agents.get('planner')!;
    const implementer = this.agents.get('implementer')!;
    const reviewer = this.agents.get('reviewer')!;

    planner.handoff('implementer', implementer, {
      description: 'Hand off plan to implementer',
    });

    implementer.handoff('reviewer', reviewer, {
      description: 'Hand off implementation to reviewer',
    });

    // Reviewer can hand back to implementer if changes needed
    reviewer.handoff('implementer', implementer, {
      description: 'Hand back to implementer for revisions',
      condition: 'if changes are needed',
    });
  }

  async executeWorkflow(projectDescription: string) {
    const planner = this.agents.get('planner')!;
    return await planner.run(
      `Plan and execute this project: ${projectDescription}`,
    );
  }
}

const orchestrator = new WorkflowOrchestrator();
const result = await orchestrator.executeWorkflow(
  'Build a REST API for user management',
);
```

## Streaming Responses

### Basic Streaming

```typescript
const streamingAgent = new Agent({
  name: 'streaming-assistant',
  instructions: 'Provide detailed, helpful responses.',
  model: 'gpt-4',
});

const stream = await streamingAgent.run('Explain quantum computing', {
  stream: true,
});

for await (const chunk of stream) {
  if (chunk.type === 'text') {
    process.stdout.write(chunk.content);
  }
}
```

### Streaming with Event Handling

```typescript
class StreamingChatBot {
  private agent: Agent;

  constructor() {
    this.agent = new Agent({
      name: 'chat-bot',
      instructions: 'You are a friendly chat bot.',
      model: 'gpt-4',
    });
  }

  async chat(
    message: string,
    callbacks: {
      onStart?: () => void;
      onChunk?: (content: string) => void;
      onComplete?: (fullResponse: string) => void;
      onError?: (error: Error) => void;
    } = {},
  ) {
    let fullResponse = '';

    try {
      callbacks.onStart?.();

      const stream = await this.agent.run(message, { stream: true });

      for await (const chunk of stream) {
        if (chunk.type === 'text') {
          fullResponse += chunk.content;
          callbacks.onChunk?.(chunk.content);
        } else if (chunk.type === 'error') {
          throw new Error(chunk.error);
        }
      }

      callbacks.onComplete?.(fullResponse);
      return fullResponse;
    } catch (error) {
      callbacks.onError?.(error as Error);
      throw error;
    }
  }
}

// Usage
const chatBot = new StreamingChatBot();
await chatBot.chat('Tell me about space exploration', {
  onStart: () => console.log('🤖 Bot is thinking...'),
  onChunk: (content) => process.stdout.write(content),
  onComplete: (response) => console.log('\n✅ Response complete'),
  onError: (error) => console.error('❌ Error:', error.message),
});
```

### Streaming with Interruption Support

```typescript
class InterruptibleStream {
  private currentController: AbortController | null = null;

  async streamWithInterruption(agent: Agent, message: string) {
    // Create abort controller for this stream
    this.currentController = new AbortController();

    try {
      const stream = await agent.run(message, {
        stream: true,
        signal: this.currentController.signal,
      });

      for await (const chunk of stream) {
        // Check if interrupted
        if (this.currentController.signal.aborted) {
          console.log('\n🛑 Stream interrupted');
          break;
        }

        if (chunk.type === 'text') {
          process.stdout.write(chunk.content);
        }
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('\n🛑 Stream was cancelled');
      } else {
        throw error;
      }
    } finally {
      this.currentController = null;
    }
  }

  interrupt() {
    if (this.currentController) {
      this.currentController.abort();
      return true;
    }
    return false;
  }
}

// Usage
const interruptibleStream = new InterruptibleStream();

// Start streaming
interruptibleStream.streamWithInterruption(
  agent,
  'Write a long essay about AI',
);

// Interrupt after 5 seconds
setTimeout(() => {
  interruptibleStream.interrupt();
}, 5000);
```

## Error Handling and Recovery

### Comprehensive Error Handling

```typescript
class RobustAgent {
  private agent: Agent;
  private retryConfig = {
    maxAttempts: 3,
    baseDelay: 1000,
    maxDelay: 10000,
  };

  constructor(config: any) {
    this.agent = new Agent(config);
  }

  async runWithRetry(input: string, options: any = {}): Promise<any> {
    let lastError: Error;

    for (let attempt = 1; attempt <= this.retryConfig.maxAttempts; attempt++) {
      try {
        return await this.agent.run(input, options);
      } catch (error) {
        lastError = error as Error;

        // Log attempt
        console.warn(`Attempt ${attempt} failed: ${error.message}`);

        // Don't retry on certain errors
        if (this.isNonRetryableError(error)) {
          throw error;
        }

        // Calculate delay with exponential backoff
        if (attempt < this.retryConfig.maxAttempts) {
          const delay = Math.min(
            this.retryConfig.baseDelay * Math.pow(2, attempt - 1),
            this.retryConfig.maxDelay,
          );

          console.log(`Retrying in ${delay}ms...`);
          await this.sleep(delay);
        }
      }
    }

    throw new Error(
      `Operation failed after ${this.retryConfig.maxAttempts} attempts: ${lastError.message}`,
    );
  }

  private isNonRetryableError(error: any): boolean {
    // Don't retry on authentication or validation errors
    const nonRetryablePatterns = [
      'authentication',
      'authorization',
      'invalid_request',
      'bad_request',
    ];

    const errorMessage = error.message.toLowerCase();
    return nonRetryablePatterns.some((pattern) =>
      errorMessage.includes(pattern),
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Usage
const robustAgent = new RobustAgent({
  name: 'robust-assistant',
  instructions: 'You are a reliable assistant.',
  model: 'gpt-4',
});

try {
  const result = await robustAgent.runWithRetry('What is the meaning of life?');
  console.log(result.messages[result.messages.length - 1].content);
} catch (error) {
  console.error('Final error:', error.message);
}
```

### Circuit Breaker Pattern

```typescript
class CircuitBreakerAgent {
  private agent: Agent;
  private failures = 0;
  private lastFailureTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    agentConfig: any,
    private failureThreshold = 5,
    private recoveryTimeout = 60000,
  ) {
    this.agent = new Agent(agentConfig);
  }

  async run(input: string, options: any = {}): Promise<any> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.recoveryTimeout) {
        this.state = 'half-open';
        console.log('Circuit breaker moving to half-open state');
      } else {
        throw new Error(
          'Circuit breaker is open - requests are being rejected',
        );
      }
    }

    try {
      const result = await this.agent.run(input, options);
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      console.log(`Circuit breaker opened after ${this.failures} failures`);
    }
  }

  getState() {
    return {
      state: this.state,
      failures: this.failures,
      lastFailureTime: this.lastFailureTime,
    };
  }
}
```

## MCP Integration

### Basic MCP Setup

```typescript
import { Agent, MCPServerStdio } from '@openai/agents';

// Set up MCP server connection
const server = new MCPServerStdio({
  command: 'uvx',
  args: ['mcp-server-filesystem'],
  env: {
    // Add any environment variables needed
  },
});

// Create agent with MCP tools
const mcpAgent = new Agent({
  name: 'mcp-agent',
  instructions:
    'Use the available MCP tools to help users with file operations.',
  model: 'gpt-4',
  tools: [server], // MCP server provides tools automatically
});

// Use the agent
const result = await mcpAgent.run('List the files in the current directory');
```

### MCP with Health Monitoring

```typescript
import { Agent, MCPServerStdio } from '@openai/agents';

class HealthMonitoredMCPServer {
  private server: MCPServerStdio;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private isHealthy = false;

  constructor(config: any) {
    this.server = new MCPServerStdio(config);
  }

  async initialize() {
    // MCP servers are initialized automatically when used
    this.startHealthMonitoring();
  }

  async cleanup() {
    this.stopHealthMonitoring();
    // MCP servers are cleaned up automatically
  }

  private startHealthMonitoring() {
    this.healthCheckInterval = setInterval(async () => {
      try {
        // Test server health by attempting to list tools
        const agent = new Agent({
          name: 'health-check',
          model: 'gpt-4',
          tools: [this.server],
        });

        // Simple health check - this will fail if server is down
        await agent.run('test', { maxTurns: 1 });

        if (!this.isHealthy) {
          console.log('✅ MCP server is healthy');
          this.isHealthy = true;
        }
      } catch (error) {
        if (this.isHealthy) {
          console.error('❌ MCP server health check failed:', error.message);
          this.isHealthy = false;
        }
      }
    }, 30000); // Check every 30 seconds
  }

  private stopHealthMonitoring() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  getServer() {
    if (!this.isHealthy) {
      console.warn('⚠️ MCP server may not be healthy');
    }
    return this.server;
  }

  getHealthStatus() {
    return this.isHealthy;
  }
}

// Usage
const healthMonitor = new HealthMonitoredMCPServer({
  command: 'uvx',
  args: ['mcp-server-filesystem'],
});

await healthMonitor.initialize();

const agent = new Agent({
  name: 'monitored-mcp-agent',
  instructions: 'Use MCP tools to help users.',
  model: 'gpt-4',
  tools: [healthMonitor.getServer()],
});
```

## Performance Optimization

### Connection Pooling

```typescript
class AgentPool {
  private agents: Agent[] = [];
  private available: Agent[] = [];
  private busy: Set<Agent> = new Set();

  constructor(
    private agentConfig: any,
    private poolSize: number = 5,
  ) {
    this.initializePool();
  }

  private initializePool() {
    for (let i = 0; i < this.poolSize; i++) {
      const agent = new Agent({
        ...this.agentConfig,
        name: `${this.agentConfig.name}-${i}`,
      });
      this.agents.push(agent);
      this.available.push(agent);
    }
  }

  async execute(input: string, options: any = {}): Promise<any> {
    const agent = await this.acquireAgent();

    try {
      return await agent.run(input, options);
    } finally {
      this.releaseAgent(agent);
    }
  }

  private async acquireAgent(): Promise<Agent> {
    if (this.available.length > 0) {
      const agent = this.available.pop()!;
      this.busy.add(agent);
      return agent;
    }

    // Wait for an agent to become available
    return new Promise((resolve) => {
      const checkAvailable = () => {
        if (this.available.length > 0) {
          const agent = this.available.pop()!;
          this.busy.add(agent);
          resolve(agent);
        } else {
          setTimeout(checkAvailable, 100);
        }
      };
      checkAvailable();
    });
  }

  private releaseAgent(agent: Agent) {
    this.busy.delete(agent);
    this.available.push(agent);
  }

  getStats() {
    return {
      total: this.agents.length,
      available: this.available.length,
      busy: this.busy.size,
    };
  }
}

// Usage
const agentPool = new AgentPool(
  {
    name: 'pooled-agent',
    instructions: 'You are a helpful assistant.',
    model: 'gpt-4',
  },
  3,
);

// Execute multiple requests concurrently
const promises = [
  agentPool.execute('What is AI?'),
  agentPool.execute('Explain machine learning'),
  agentPool.execute('What is deep learning?'),
];

const results = await Promise.all(promises);
console.log('Pool stats:', agentPool.getStats());
```

### Response Caching

```typescript
class CachedAgent {
  private agent: Agent;
  private cache = new Map<string, { response: any; timestamp: number }>();
  private cacheTimeout = 5 * 60 * 1000; // 5 minutes

  constructor(agentConfig: any) {
    this.agent = new Agent(agentConfig);
  }

  async run(input: string, options: any = {}): Promise<any> {
    const cacheKey = this.generateCacheKey(input, options);

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      console.log('📦 Cache hit');
      return cached.response;
    }

    // Execute and cache
    console.log('🔄 Cache miss - executing agent');
    const response = await this.agent.run(input, options);

    this.cache.set(cacheKey, {
      response,
      timestamp: Date.now(),
    });

    // Clean up old cache entries
    this.cleanupCache();

    return response;
  }

  private generateCacheKey(input: string, options: any): string {
    return JSON.stringify({ input, options });
  }

  private cleanupCache() {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > this.cacheTimeout) {
        this.cache.delete(key);
      }
    }
  }

  clearCache() {
    this.cache.clear();
  }

  getCacheStats() {
    return {
      size: this.cache.size,
      entries: Array.from(this.cache.keys()),
    };
  }
}
```

## Production Patterns

### Complete Production Setup

```typescript
import { Agent } from '@openai/agents';
import { EventEmitter } from 'events';

class ProductionAgentService extends EventEmitter {
  private agent: Agent;
  private metrics = {
    requests: 0,
    successes: 0,
    failures: 0,
    totalResponseTime: 0,
  };

  constructor(config: any) {
    super();
    this.agent = new Agent(config);
    this.setupMetrics();
  }

  async processRequest(
    input: string,
    userId: string,
    sessionId: string,
    options: any = {},
  ): Promise<any> {
    const startTime = Date.now();
    const requestId = `${sessionId}-${Date.now()}`;

    this.metrics.requests++;

    // Emit request start event
    this.emit('requestStart', {
      requestId,
      userId,
      sessionId,
      input: input.substring(0, 100) + '...',
      timestamp: new Date(),
    });

    try {
      // Add request context
      const contextualInput = this.addContext(input, userId, sessionId);

      // Execute with timeout
      const response = await Promise.race([
        this.agent.run(contextualInput, options),
        this.createTimeout(60000), // 60 second timeout
      ]);

      const responseTime = Date.now() - startTime;
      this.metrics.successes++;
      this.metrics.totalResponseTime += responseTime;

      // Emit success event
      this.emit('requestSuccess', {
        requestId,
        userId,
        sessionId,
        responseTime,
        timestamp: new Date(),
      });

      return {
        success: true,
        response: response.messages[response.messages.length - 1].content,
        metadata: {
          requestId,
          responseTime,
          model: this.agent.model,
          timestamp: new Date(),
        },
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      this.metrics.failures++;

      // Emit error event
      this.emit('requestError', {
        requestId,
        userId,
        sessionId,
        error: error.message,
        responseTime,
        timestamp: new Date(),
      });

      // Return user-friendly error
      return {
        success: false,
        error: this.sanitizeError(error as Error),
        metadata: {
          requestId,
          responseTime,
          timestamp: new Date(),
        },
      };
    }
  }

  private addContext(input: string, userId: string, sessionId: string): string {
    return `[User: ${userId}, Session: ${sessionId}] ${input}`;
  }

  private createTimeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timeout')), ms);
    });
  }

  private sanitizeError(error: Error): string {
    // Don't expose internal errors to users
    const userFriendlyErrors = {
      timeout: 'The request took too long to process. Please try again.',
      rate_limit: 'Too many requests. Please wait a moment and try again.',
      model_unavailable:
        'The AI service is temporarily unavailable. Please try again later.',
    };

    const errorType = this.classifyError(error);
    return (
      userFriendlyErrors[errorType] ||
      'An unexpected error occurred. Please try again.'
    );
  }

  private classifyError(error: Error): string {
    const message = error.message.toLowerCase();

    if (message.includes('timeout')) return 'timeout';
    if (message.includes('rate limit')) return 'rate_limit';
    if (message.includes('model') && message.includes('unavailable'))
      return 'model_unavailable';

    return 'generic';
  }

  private setupMetrics() {
    // Log metrics every minute
    setInterval(() => {
      const avgResponseTime =
        this.metrics.successes > 0
          ? this.metrics.totalResponseTime / this.metrics.successes
          : 0;

      console.log('📊 Agent Metrics:', {
        requests: this.metrics.requests,
        successRate: `${((this.metrics.successes / this.metrics.requests) * 100).toFixed(2)}%`,
        avgResponseTime: `${avgResponseTime.toFixed(2)}ms`,
        timestamp: new Date().toISOString(),
      });
    }, 60000);
  }

  getMetrics() {
    return { ...this.metrics };
  }

  resetMetrics() {
    this.metrics = {
      requests: 0,
      successes: 0,
      failures: 0,
      totalResponseTime: 0,
    };
  }
}

// Usage
const productionService = new ProductionAgentService({
  name: 'production-assistant',
  instructions: 'You are a production-ready assistant.',
  model: 'gpt-4',
});

// Set up event listeners
productionService.on('requestStart', (data) => {
  console.log(`🚀 Request started: ${data.requestId}`);
});

productionService.on('requestSuccess', (data) => {
  console.log(
    `✅ Request completed: ${data.requestId} (${data.responseTime}ms)`,
  );
});

productionService.on('requestError', (data) => {
  console.error(`❌ Request failed: ${data.requestId} - ${data.error}`);
});

// Process requests
const result = await productionService.processRequest(
  'Help me understand machine learning',
  'user123',
  'session456',
);

console.log('Result:', result);
console.log('Service metrics:', productionService.getMetrics());
```

This comprehensive guide provides practical examples for all major OpenAI Agents features. Each example is designed to be production-ready and demonstrates best practices for real-world usage.
