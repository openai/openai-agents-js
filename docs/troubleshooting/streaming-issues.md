# Streaming Troubleshooting Guide

This guide helps you diagnose and resolve common issues when working with streaming responses in OpenAI Agents.

## Common Streaming Issues

### 1. Stream Connection Problems

**Symptoms:**

- Stream never starts or immediately closes
- `Connection refused` errors
- `WebSocket connection failed` errors

**Causes & Solutions:**

#### Network/Proxy Issues

```typescript
// ❌ Basic configuration that might fail behind proxies
const agent = new Agent({
  name: 'streaming-agent',
  model: 'gpt-4',
});

// ✅ Configuration with proxy support
const agent = new Agent({
  name: 'streaming-agent',
  model: 'gpt-4',
  // Add proxy configuration if needed
  httpAgent: new HttpsProxyAgent('http://proxy.company.com:8080'),
});
```

#### Timeout Configuration

```typescript
// Configure appropriate timeouts for streaming
const streamConfig = {
  timeout: 60000, // 60 seconds
  keepAlive: true,
  maxRetries: 3,
  retryDelay: 1000,
};

const result = await agent.run('Tell me a long story', {
  stream: true,
  ...streamConfig,
});
```

### 2. Stream Interruption and Recovery

**Symptoms:**

- Streams stop mid-response
- Partial responses received
- `Stream ended unexpectedly` errors

**Diagnostic and Recovery Code:**

```typescript
import { Agent } from '@openai/agents';

class ResilientStreamHandler {
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private reconnectDelay = 1000;

  async handleStreamWithRecovery(agent: Agent, input: string) {
    let lastContent = '';
    let streamPosition = 0;

    while (this.reconnectAttempts <= this.maxReconnectAttempts) {
      try {
        const stream = await agent.run(input, {
          stream: true,
          // Resume from last position if recovering
          resumeFrom: streamPosition > 0 ? streamPosition : undefined,
        });

        for await (const chunk of stream) {
          if (chunk.type === 'text') {
            lastContent += chunk.content;
            streamPosition = lastContent.length;

            // Process chunk
            this.processChunk(chunk);
          }

          if (chunk.type === 'error') {
            throw new Error(`Stream error: ${chunk.error}`);
          }
        }

        // Stream completed successfully
        this.reconnectAttempts = 0;
        return lastContent;
      } catch (error) {
        console.error(
          `Stream attempt ${this.reconnectAttempts + 1} failed:`,
          error,
        );

        this.reconnectAttempts++;

        if (this.reconnectAttempts <= this.maxReconnectAttempts) {
          console.log(`Retrying stream in ${this.reconnectDelay}ms...`);
          await this.sleep(this.reconnectDelay);
          this.reconnectDelay *= 2; // Exponential backoff
        } else {
          throw new Error(
            `Stream failed after ${this.maxReconnectAttempts} attempts: ${error.message}`,
          );
        }
      }
    }
  }

  private processChunk(chunk: any) {
    // Handle chunk processing
    console.log('Received chunk:', chunk.content);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
```

### 3. Memory Issues with Long Streams

**Symptoms:**

- Memory usage grows continuously during streaming
- `Out of memory` errors with long responses
- Performance degradation over time

**Solutions:**

#### Implement Backpressure Control

```typescript
class StreamBufferManager {
  private buffer: string[] = [];
  private maxBufferSize = 1000; // Maximum chunks to buffer
  private processingQueue: Promise<void> = Promise.resolve();

  async processStreamWithBackpressure(stream: AsyncIterable<any>) {
    for await (const chunk of stream) {
      // Wait if buffer is full
      if (this.buffer.length >= this.maxBufferSize) {
        await this.processingQueue;
      }

      this.buffer.push(chunk.content);

      // Process buffer asynchronously
      this.processingQueue = this.processingQueue.then(() =>
        this.processBuffer(),
      );
    }

    // Process remaining buffer
    await this.processingQueue;
  }

  private async processBuffer() {
    const batch = this.buffer.splice(0, 100); // Process in batches

    for (const content of batch) {
      // Process individual chunk
      await this.processChunk(content);
    }
  }

  private async processChunk(content: string) {
    // Your chunk processing logic here
    // This could be saving to file, updating UI, etc.
  }
}
```

#### Stream to File for Large Responses

```typescript
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

async function streamToFile(agent: Agent, input: string, outputPath: string) {
  const writeStream = createWriteStream(outputPath);

  try {
    const stream = await agent.run(input, { stream: true });

    // Convert async iterable to readable stream
    const readableStream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            if (chunk.type === 'text') {
              controller.enqueue(chunk.content);
            }
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });

    // Pipe to file
    await pipeline(readableStream, writeStream);

    console.log(`Stream saved to ${outputPath}`);
  } catch (error) {
    writeStream.destroy();
    throw error;
  }
}
```

### 4. Event Handling Issues

**Symptoms:**

- Missing stream events
- Events received out of order
- Event handlers not being called

**Event Handler Debugging:**

```typescript
class StreamEventDebugger {
  private eventCounts = new Map<string, number>();
  private lastEventTime = Date.now();

  createDebugAgent(agent: Agent) {
    return {
      ...agent,
      run: async (input: string, options: any = {}) => {
        if (!options.stream) {
          return agent.run(input, options);
        }

        const stream = await agent.run(input, options);
        return this.wrapStreamWithDebugging(stream);
      }
    };
  }

  private async* wrapStreamWithDebugging(stream: AsyncIterable<any>) {
    try {
      for await (const event of stream) {
        // Track event timing
        const now = Date.now();
        const timeSinceLastEvent = now - this.lastEventTime;
        this.lastEventTime = now;

        // Count events by type
        const eventType = event.type || 'unknown';
        this.eventCounts.set(eventType, (this.eventCounts.get(eventType) || 0) + 1);

        // Log event details
        console.log(`[${new Date().toISOString()}] Event: ${eventType} (+${timeSinceLastEvent}ms)`);

        if (event.type === 'error') {
          console.error('Stream error event:', event);
        }

        // Check for potential issues
        if (timeSinceLastEvent > 30000) {
          console.warn(`⚠️ Long gap between events: ${timeSinceLastEvent}ms`);
        }

        yield event;
      }
    } catch (error) {
      console.error('Stream iteration error:', error);
      throw error;
    } finally {
      this.logEventSummary();
    }
  }

  private logEventSummary() {
    console.log('\n=== Stream Event Summary ===');
    for (const [eventType, count] of this.eventCounts) {
      console.log(`${eventType}: ${count} events`);
    }
    console.log('============================\n');
  }
}

// Usage
const debugger = new StreamEventDebugger();
const debugAgent = debugger.createDebugAgent(agent);

const result = await debugAgent.run('Tell me about AI', { stream: true });
for await (const chunk of result) {
  // Process chunks normally
}
```

### 5. Concurrent Stream Management

**Symptoms:**

- Multiple streams interfering with each other
- Resource exhaustion with many concurrent streams
- Inconsistent behavior across streams

**Stream Pool Management:**

```typescript
class StreamPool {
  private activeStreams = new Map<string, AsyncIterable<any>>();
  private maxConcurrentStreams = 5;
  private streamQueue: Array<() => Promise<any>> = [];

  async createManagedStream(
    streamId: string,
    streamFactory: () => Promise<AsyncIterable<any>>,
  ): Promise<AsyncIterable<any>> {
    // Check if we're at capacity
    if (this.activeStreams.size >= this.maxConcurrentStreams) {
      await this.waitForAvailableSlot();
    }

    try {
      const stream = await streamFactory();
      this.activeStreams.set(streamId, stream);

      // Wrap stream to handle cleanup
      return this.wrapStreamWithCleanup(streamId, stream);
    } catch (error) {
      console.error(`Failed to create stream ${streamId}:`, error);
      throw error;
    }
  }

  private async waitForAvailableSlot(): Promise<void> {
    return new Promise((resolve) => {
      const checkSlot = () => {
        if (this.activeStreams.size < this.maxConcurrentStreams) {
          resolve();
        } else {
          setTimeout(checkSlot, 100);
        }
      };
      checkSlot();
    });
  }

  private async *wrapStreamWithCleanup(
    streamId: string,
    stream: AsyncIterable<any>,
  ): AsyncIterable<any> {
    try {
      for await (const chunk of stream) {
        yield chunk;
      }
    } finally {
      // Clean up when stream ends
      this.activeStreams.delete(streamId);
      console.log(
        `Stream ${streamId} cleaned up. Active streams: ${this.activeStreams.size}`,
      );
    }
  }

  getActiveStreamCount(): number {
    return this.activeStreams.size;
  }

  async closeAllStreams(): Promise<void> {
    // Note: This is a simplified cleanup - in practice you'd need
    // to properly cancel/close each stream
    this.activeStreams.clear();
  }
}
```

## Performance Optimization

### 1. Efficient Chunk Processing

```typescript
// ❌ Inefficient - processing each chunk individually
for await (const chunk of stream) {
  await processChunk(chunk); // Blocks next chunk
}

// ✅ Efficient - batch processing with concurrency
const chunkBuffer: any[] = [];
const batchSize = 10;

for await (const chunk of stream) {
  chunkBuffer.push(chunk);

  if (chunkBuffer.length >= batchSize) {
    // Process batch concurrently
    await Promise.all(chunkBuffer.map((chunk) => processChunk(chunk)));
    chunkBuffer.length = 0; // Clear buffer
  }
}

// Process remaining chunks
if (chunkBuffer.length > 0) {
  await Promise.all(chunkBuffer.map((chunk) => processChunk(chunk)));
}
```

### 2. Stream Monitoring and Metrics

```typescript
class StreamMetrics {
  private metrics = {
    totalChunks: 0,
    totalBytes: 0,
    averageChunkSize: 0,
    streamDuration: 0,
    throughput: 0,
  };

  private startTime = Date.now();

  recordChunk(chunk: any) {
    this.metrics.totalChunks++;

    const chunkSize = JSON.stringify(chunk).length;
    this.metrics.totalBytes += chunkSize;
    this.metrics.averageChunkSize =
      this.metrics.totalBytes / this.metrics.totalChunks;

    this.metrics.streamDuration = Date.now() - this.startTime;
    this.metrics.throughput =
      this.metrics.totalBytes / (this.metrics.streamDuration / 1000);
  }

  getMetrics() {
    return { ...this.metrics };
  }

  logMetrics() {
    console.log('Stream Metrics:', {
      chunks: this.metrics.totalChunks,
      bytes: `${(this.metrics.totalBytes / 1024).toFixed(2)} KB`,
      avgChunkSize: `${this.metrics.averageChunkSize.toFixed(2)} bytes`,
      duration: `${(this.metrics.streamDuration / 1000).toFixed(2)}s`,
      throughput: `${(this.metrics.throughput / 1024).toFixed(2)} KB/s`,
    });
  }
}
```

## Quick Diagnostic Checklist

When experiencing streaming issues:

1. **Connection Health**
   - [ ] Network connectivity is stable
   - [ ] No proxy/firewall blocking streams
   - [ ] Appropriate timeout values set

2. **Resource Management**
   - [ ] Memory usage is reasonable
   - [ ] Not exceeding concurrent stream limits
   - [ ] Proper cleanup of completed streams

3. **Error Handling**
   - [ ] Stream errors are caught and handled
   - [ ] Retry logic is implemented
   - [ ] Graceful degradation on failures

4. **Performance**
   - [ ] Chunk processing is efficient
   - [ ] No blocking operations in stream handlers
   - [ ] Appropriate batching for large streams

5. **Event Handling**
   - [ ] All event types are handled
   - [ ] Event handlers don't throw unhandled errors
   - [ ] Proper event ordering is maintained

## Best Practices

1. **Always implement error recovery** for production streaming
2. **Monitor stream metrics** to identify performance issues
3. **Use backpressure control** for long-running streams
4. **Implement proper cleanup** to prevent memory leaks
5. **Test with various network conditions** including poor connectivity
6. **Log stream events** for debugging purposes
7. **Set reasonable timeouts** based on expected response times
