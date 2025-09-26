/**
 * Practical Streaming Patterns
 *
 * This file demonstrates real-world streaming patterns
 * for building responsive applications with OpenAI Agents.
 */

import { Agent, run } from '@openai/agents';
import { EventEmitter } from 'events';

// Example 1: Real-time Chat Interface
export class RealTimeChatInterface extends EventEmitter {
  private agent: Agent;
  private isStreaming = false;
  private currentStreamId: string | null = null;

  constructor() {
    super();
    this.agent = new Agent({
      name: 'chat-agent',
      instructions:
        'You are a helpful chat assistant. Provide engaging, conversational responses.',
    });
  }

  async sendMessage(message: string, userId: string): Promise<string> {
    if (this.isStreaming) {
      throw new Error('Another message is currently being processed');
    }

    this.isStreaming = true;
    this.currentStreamId = `${userId}-${Date.now()}`;

    try {
      this.emit('messageStart', { userId, streamId: this.currentStreamId });

      const stream = await run(this.agent, message, { stream: true });

      // Process streaming events
      for await (const event of stream) {
        if (
          event.type === 'raw_model_stream_event' &&
          event.data.type === 'model' &&
          event.data.event.type === 'response.output_text.delta'
        ) {
          const chunk = event.data.event.delta || '';

          // Emit each chunk for real-time UI updates
          this.emit('messageChunk', {
            userId,
            streamId: this.currentStreamId,
            content: chunk,
          });
        }
      }

      this.emit('messageComplete', {
        userId,
        streamId: this.currentStreamId,
        fullContent: stream.finalOutput,
      });

      return stream.finalOutput || '';
    } catch (error) {
      this.emit('messageError', {
        userId,
        streamId: this.currentStreamId,
        error: (error as Error).message,
      });
      throw error;
    } finally {
      this.isStreaming = false;
      this.currentStreamId = null;
    }
  }

  cancelCurrentStream(): boolean {
    if (this.isStreaming && this.currentStreamId) {
      this.emit('messageCancelled', { streamId: this.currentStreamId });
      this.isStreaming = false;
      this.currentStreamId = null;
      return true;
    }
    return false;
  }
}

// Example 2: Progressive Content Generation with Text Stream
export class ProgressiveContentGenerator {
  private agent: Agent;

  constructor() {
    this.agent = new Agent({
      name: 'content-generator',
      instructions:
        'Generate high-quality content progressively. Structure your responses with clear sections.',
    });
  }

  async generateArticle(
    topic: string,
    onProgress?: (content: string) => void,
  ): Promise<string> {
    const stream = await run(
      this.agent,
      `Write a comprehensive article about "${topic}". Structure it with clear sections like Introduction, Main Content, and Conclusion.`,
      { stream: true },
    );

    // Use text stream for progressive updates
    const textStream = stream.toTextStream({ compatibleWithNodeStreams: true });
    let fullContent = '';

    // Create a readable stream handler
    textStream.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      fullContent += text;
      onProgress?.(text);
    });

    // Wait for completion
    await new Promise((resolve, reject) => {
      textStream.on('end', resolve);
      textStream.on('error', reject);
    });

    return stream.finalOutput || '';
  }
}

// Example 3: Multi-Agent Coordination (Sequential Processing)
export class MultiAgentStreamCoordinator {
  private agents: Map<string, Agent> = new Map();

  constructor() {
    this.setupAgents();
  }

  private setupAgents() {
    this.agents.set(
      'researcher',
      new Agent({
        name: 'researcher',
        instructions:
          'Research topics thoroughly and provide detailed information.',
      }),
    );

    this.agents.set(
      'analyst',
      new Agent({
        name: 'analyst',
        instructions: 'Analyze information and provide insights.',
      }),
    );

    this.agents.set(
      'writer',
      new Agent({
        name: 'writer',
        instructions:
          'Write clear, engaging content based on research and analysis.',
      }),
    );
  }

  async coordinatedResearch(
    topic: string,
    onAgentUpdate?: (agentName: string, isComplete: boolean) => void,
  ): Promise<{ research: string; analysis: string; article: string }> {
    // Step 1: Research
    onAgentUpdate?.('researcher', false);
    const researchResult = await run(
      this.agents.get('researcher')!,
      `Research the topic: ${topic}`,
    );
    onAgentUpdate?.('researcher', true);

    // Step 2: Analysis
    onAgentUpdate?.('analyst', false);
    const analysisResult = await run(
      this.agents.get('analyst')!,
      `Analyze this research: ${researchResult.finalOutput}`,
    );
    onAgentUpdate?.('analyst', true);

    // Step 3: Writing
    onAgentUpdate?.('writer', false);
    const articleResult = await run(
      this.agents.get('writer')!,
      `Write an article based on this research: ${researchResult.finalOutput} and analysis: ${analysisResult.finalOutput}`,
    );
    onAgentUpdate?.('writer', true);

    return {
      research: researchResult.finalOutput || '',
      analysis: analysisResult.finalOutput || '',
      article: articleResult.finalOutput || '',
    };
  }
}

// Example 4: Streaming with Progress Tracking
export class StreamProgressTracker {
  async trackStreamProgress(
    agent: Agent,
    input: string,
    onProgress?: (progress: { completed: boolean; output?: string }) => void,
  ): Promise<string> {
    onProgress?.({ completed: false });

    const stream = await run(agent, input, { stream: true });

    // Use text stream for progress updates
    const textStream = stream.toTextStream({ compatibleWithNodeStreams: true });

    textStream.on('data', (chunk: Buffer) => {
      onProgress?.({ completed: false, output: chunk.toString() });
    });

    // Wait for completion
    await new Promise((resolve, reject) => {
      textStream.on('end', resolve);
      textStream.on('error', reject);
    });

    onProgress?.({ completed: true, output: stream.finalOutput || '' });
    return stream.finalOutput || '';
  }
}

// Example 5: Response Caching (Non-streaming)
export class CachedAgent {
  private cache = new Map<string, string>();
  private activeRequests = new Map<string, Promise<string>>();

  constructor(private agent: Agent) {}

  async getCachedResponse(input: string): Promise<string> {
    const cacheKey = this.generateCacheKey(input);

    // Check cache first
    if (this.cache.has(cacheKey)) {
      console.log('📦 Cache hit');
      return this.cache.get(cacheKey)!;
    }

    // Check if same request is already in progress
    if (this.activeRequests.has(cacheKey)) {
      console.log('⏳ Request in progress, waiting...');
      return await this.activeRequests.get(cacheKey)!;
    }

    // Start new request
    console.log('🔄 Cache miss, executing agent');
    const requestPromise = this.executeRequest(input);
    this.activeRequests.set(cacheKey, requestPromise);

    try {
      const result = await requestPromise;
      this.cache.set(cacheKey, result);
      return result;
    } finally {
      this.activeRequests.delete(cacheKey);
    }
  }

  private async executeRequest(input: string): Promise<string> {
    const result = await run(this.agent, input);
    return result.finalOutput || '';
  }

  private generateCacheKey(input: string): string {
    // Simple hash function for caching
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString();
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

// Usage Examples
export async function demonstrateStreamingPatterns() {
  console.log('=== Streaming Pattern Examples ===\n');

  // 1. Real-time chat interface
  console.log('1. Testing real-time chat interface...');
  const chatInterface = new RealTimeChatInterface();

  chatInterface.on('messageChunk', (data) => {
    process.stdout.write(data.content); // Real-time output
  });

  chatInterface.on('messageComplete', () => {
    console.log('\n✅ Message complete\n');
  });

  try {
    await chatInterface.sendMessage('Tell me a short story about AI', 'user1');
  } catch (error) {
    console.error('Chat error:', (error as Error).message);
  }

  // 2. Progressive content generation
  console.log('2. Testing progressive content generation...');
  const contentGenerator = new ProgressiveContentGenerator();

  await contentGenerator.generateArticle('machine learning', (content) => {
    process.stdout.write(content); // Stream content as it arrives
  });

  console.log('\n✅ Article generation complete\n');

  // 3. Multi-agent coordination
  console.log('3. Testing multi-agent coordination...');
  const coordinator = new MultiAgentStreamCoordinator();

  await coordinator.coordinatedResearch(
    'blockchain technology',
    (agentName, isComplete) => {
      if (isComplete) {
        console.log(`✅ ${agentName} completed`);
      } else {
        console.log(`🔄 ${agentName} working...`);
      }
    },
  );

  console.log('\n✅ Coordinated research complete\n');

  // 4. Cached responses
  console.log('4. Testing cached responses...');
  const agent = new Agent({
    name: 'test-agent',
    instructions: 'Provide helpful responses.',
  });

  const cachedAgent = new CachedAgent(agent);

  // First request (will execute)
  console.log('First request:');
  await cachedAgent.getCachedResponse('What is TypeScript?');

  console.log('\nSecond request (cached):');
  // Second request (will use cache)
  await cachedAgent.getCachedResponse('What is TypeScript?');

  console.log('\nCache stats:', cachedAgent.getCacheStats());
}

// Run examples if this file is executed directly
if (require.main === module) {
  demonstrateStreamingPatterns().catch(console.error);
}
