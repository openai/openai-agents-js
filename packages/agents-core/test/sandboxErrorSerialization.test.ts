import { afterEach, describe, expect, it } from 'vitest';
import {
  addSandboxEventSink,
  clearSandboxEventSinks,
  type SandboxEvent,
  withSandboxSpan,
} from '../src/sandbox';

describe('sandbox error serialization', () => {
  afterEach(() => {
    clearSandboxEventSinks();
  });

  it('preserves the original failure when a thrown value cannot be stringified', async () => {
    const events: SandboxEvent[] = [];
    addSandboxEventSink((event) => {
      events.push(event);
    });
    const operationError = {
      toString() {
        throw new Error('serialization failed');
      },
    };

    await expect(
      withSandboxSpan('sandbox.exec', { cmd: 'false' }, async () => {
        throw operationError;
      }),
    ).rejects.toBe(operationError);

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: 'sandbox_operation',
      name: 'sandbox.exec',
      phase: 'error',
      error: {
        message: 'Sandbox operation failed with an unserializable error.',
      },
    });
  });

  it('preserves Error failures when optional metadata access throws', async () => {
    const events: SandboxEvent[] = [];
    addSandboxEventSink((event) => {
      events.push(event);
    });
    const operationError = new Error('provider failed');
    Object.defineProperty(operationError, 'code', {
      get() {
        throw new Error('metadata access failed');
      },
    });

    await expect(
      withSandboxSpan('sandbox.start', {}, async () => {
        throw operationError;
      }),
    ).rejects.toBe(operationError);

    expect(events[1]?.error).toEqual({
      message: 'Sandbox operation failed with an unserializable error.',
    });
  });
});
