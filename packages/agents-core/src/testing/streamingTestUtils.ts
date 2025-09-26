import {
  RunStreamEvent,
  RunItemStreamEvent,
  RunRawModelStreamEvent,
  RunAgentUpdatedStreamEvent,
} from '../events';
import { StreamedRunResult } from '../result';

/**
 * Configuration for stream interruption simulation
 */
export interface StreamInterruption {
  /**
   * After how many events to interrupt
   */
  afterEvents: number;
  /**
   * Type of interruption
   */
  type: 'error' | 'cancel' | 'timeout';
  /**
   * Error message for error interruptions
   */
  errorMessage?: string;
  /**
   * Timeout duration for timeout interruptions
   */
  timeoutMs?: number;
}

/**
 * Matcher function for stream events
 */
export type StreamEventMatcher = (event: RunStreamEvent) => boolean;

/**
 * Configuration for stream testing
 */
export interface StreamTestConfig {
  /**
   * Maximum time to wait for events (in milliseconds)
   */
  timeout?: number;
  /**
   * Whether to collect all events for later inspection
   */
  collectEvents?: boolean;
  /**
   * Interruption to simulate during streaming
   */
  interruption?: StreamInterruption;
  /**
   * Filter function to only collect certain events
   */
  eventFilter?: StreamEventMatcher;
}

/**
 * Result of stream testing
 */
export interface StreamTestResult {
  /**
   * All events that were collected
   */
  events: RunStreamEvent[];
  /**
   * Whether the stream completed successfully
   */
  completed: boolean;
  /**
   * Error that occurred during streaming (if any)
   */
  error?: Error;
  /**
   * Duration of the stream in milliseconds
   */
  duration: number;
  /**
   * Whether the stream was interrupted
   */
  interrupted: boolean;
  /**
   * Type of interruption that occurred
   */
  interruptionType?: string;
}

/**
 * Utilities for testing streaming functionality
 */
export class StreamingTestUtils {
  /**
   * Consume a stream and collect events for testing
   */
  static async consumeStream(
    streamResult: StreamedRunResult<any, any>,
    config: StreamTestConfig = {},
  ): Promise<StreamTestResult> {
    const startTime = Date.now();
    const events: RunStreamEvent[] = [];
    let completed = false;
    let error: Error | undefined;
    let interrupted = false;
    let interruptionType: string | undefined;
    let eventCount = 0;

    const timeout = config.timeout || 30000; // 30 second default timeout

    try {
      // Set up timeout if specified
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Stream test timeout after ${timeout}ms`));
        }, timeout);
      });

      // Set up interruption if specified
      let interruptionPromise: Promise<never> | undefined;
      if (config.interruption) {
        interruptionPromise = new Promise<never>((_, _reject) => {
          // We'll trigger this from within the stream consumption
        });
      }

      // Consume the stream
      const streamPromise = (async () => {
        try {
          for await (const event of streamResult.toStream()) {
            eventCount++;

            // Check for interruption
            if (
              config.interruption &&
              eventCount > config.interruption.afterEvents
            ) {
              interrupted = true;
              interruptionType = config.interruption.type;

              switch (config.interruption.type) {
                case 'error':
                  throw new Error(
                    config.interruption.errorMessage ||
                      'Stream interrupted by test',
                  );
                case 'cancel':
                  // Simulate cancellation by breaking out of the loop
                  break;
                case 'timeout':
                  if (config.interruption?.timeoutMs) {
                    await new Promise((resolve) =>
                      setTimeout(resolve, config.interruption!.timeoutMs!),
                    );
                    throw new Error('Stream timeout simulation');
                  }
                  break;
              }
            }

            // Filter events if specified
            if (!config.eventFilter || config.eventFilter(event)) {
              if (config.collectEvents !== false) {
                events.push(event);
              }
            }

            // Break if we hit cancellation interruption
            if (interrupted && config.interruption?.type === 'cancel') {
              break;
            }
          }

          // Stream iteration completed successfully
          if (!interrupted) {
            completed = true;
          }
        } catch (err) {
          error = err as Error;
          throw err;
        }
      })();

      // Race between stream consumption, timeout, and interruption
      const promises = [streamPromise, timeoutPromise];
      if (interruptionPromise) {
        promises.push(interruptionPromise);
      }

      await Promise.race(promises);
    } catch (err) {
      error = err as Error;
    }

    const duration = Date.now() - startTime;

    return {
      events,
      completed,
      error,
      duration,
      interrupted,
      interruptionType,
    };
  }

  /**
   * Wait for a specific event to occur in the stream
   */
  static async waitForEvent(
    streamResult: StreamedRunResult<any, any>,
    matcher: StreamEventMatcher,
    timeoutMs: number = 10000,
  ): Promise<RunStreamEvent | null> {
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeoutMs);
    });

    const eventPromise = (async (): Promise<RunStreamEvent | null> => {
      try {
        for await (const event of streamResult.toStream()) {
          if (matcher(event)) {
            return event;
          }
        }
        return null;
      } catch {
        return null;
      }
    })();

    return Promise.race([eventPromise, timeoutPromise]);
  }

  /**
   * Count events of a specific type in the stream
   */
  static async countEvents(
    streamResult: StreamedRunResult<any, any>,
    matcher: StreamEventMatcher,
    timeoutMs: number = 10000,
  ): Promise<number> {
    let count = 0;
    const startTime = Date.now();

    try {
      for await (const event of streamResult.toStream()) {
        if (Date.now() - startTime > timeoutMs) {
          break;
        }

        if (matcher(event)) {
          count++;
        }
      }
    } catch {
      // Ignore errors for counting
    }

    return count;
  }

  /**
   * Collect all events from a stream with a timeout
   */
  static async collectAllEvents(
    streamResult: StreamedRunResult<any, any>,
    timeoutMs: number = 10000,
  ): Promise<RunStreamEvent[]> {
    const result = await this.consumeStream(streamResult, {
      timeout: timeoutMs,
      collectEvents: true,
    });
    return result.events;
  }

  /**
   * Simulate stream interruption at a specific point
   */
  static async simulateInterruption(
    streamResult: StreamedRunResult<any, any>,
    interruption: StreamInterruption,
  ): Promise<StreamTestResult> {
    return this.consumeStream(streamResult, { interruption });
  }

  /**
   * Test stream recovery after interruption
   */
  static async testStreamRecovery(
    createStream: () => StreamedRunResult<any, any>,
    interruption: StreamInterruption,
    maxRetries: number = 3,
  ): Promise<{
    success: boolean;
    attempts: number;
    finalResult?: StreamTestResult;
  }> {
    let attempts = 0;
    let finalResult: StreamTestResult | undefined;

    while (attempts < maxRetries) {
      attempts++;

      try {
        const stream = createStream();
        finalResult = await this.consumeStream(stream, { interruption });

        if (finalResult.completed) {
          return { success: true, attempts, finalResult };
        }
      } catch (_error) {
        // Continue to next attempt
      }
    }

    return { success: false, attempts, finalResult };
  }

  // Event matcher helpers

  /**
   * Create a matcher for message output events
   */
  static messageOutputMatcher(): StreamEventMatcher {
    return (event: RunStreamEvent) =>
      event.type === 'run_item_stream_event' &&
      (event as RunItemStreamEvent).name === 'message_output_created';
  }

  /**
   * Create a matcher for tool call events
   */
  static toolCallMatcher(toolName?: string): StreamEventMatcher {
    return (event: RunStreamEvent) => {
      if (event.type !== 'run_item_stream_event') return false;
      const itemEvent = event as RunItemStreamEvent;
      if (itemEvent.name !== 'tool_called') return false;

      if (toolName) {
        const item = itemEvent.item as any;
        return item.name === toolName;
      }

      return true;
    };
  }

  /**
   * Create a matcher for handoff events
   */
  static handoffMatcher(agentName?: string): StreamEventMatcher {
    return (event: RunStreamEvent) => {
      if (event.type === 'run_item_stream_event') {
        const itemEvent = event as RunItemStreamEvent;
        return (
          itemEvent.name === 'handoff_requested' ||
          itemEvent.name === 'handoff_occurred'
        );
      }

      if (event.type === 'agent_updated_stream_event' && agentName) {
        const agentEvent = event as RunAgentUpdatedStreamEvent;
        return agentEvent.agent.name === agentName;
      }

      return false;
    };
  }

  /**
   * Create a matcher for tool approval events
   */
  static toolApprovalMatcher(): StreamEventMatcher {
    return (event: RunStreamEvent) =>
      event.type === 'run_item_stream_event' &&
      (event as RunItemStreamEvent).name === 'tool_approval_requested';
  }

  /**
   * Create a matcher for raw model events
   */
  static rawModelEventMatcher(eventType?: string): StreamEventMatcher {
    return (event: RunStreamEvent) => {
      if (event.type !== 'raw_model_stream_event') return false;

      if (eventType) {
        const rawEvent = event as RunRawModelStreamEvent;
        return rawEvent.data.type === eventType;
      }

      return true;
    };
  }

  /**
   * Create a matcher for agent update events
   */
  static agentUpdateMatcher(agentName?: string): StreamEventMatcher {
    return (event: RunStreamEvent) => {
      if (event.type !== 'agent_updated_stream_event') return false;

      if (agentName) {
        const agentEvent = event as RunAgentUpdatedStreamEvent;
        return agentEvent.agent.name === agentName;
      }

      return true;
    };
  }

  /**
   * Create a composite matcher that matches any of the provided matchers
   */
  static anyOf(...matchers: StreamEventMatcher[]): StreamEventMatcher {
    return (event: RunStreamEvent) =>
      matchers.some((matcher) => matcher(event));
  }

  /**
   * Create a composite matcher that matches all of the provided matchers
   */
  static allOf(...matchers: StreamEventMatcher[]): StreamEventMatcher {
    return (event: RunStreamEvent) =>
      matchers.every((matcher) => matcher(event));
  }

  /**
   * Create a matcher that negates another matcher
   */
  static not(matcher: StreamEventMatcher): StreamEventMatcher {
    return (event: RunStreamEvent) => !matcher(event);
  }
}
