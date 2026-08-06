import { describe, test, expect } from 'vitest';
import {
  RealtimeAgent,
  RealtimeSession,
  setSensitiveDataLoggingEnabled,
} from '../src';

describe('RealtimeAgent', () => {
  test('should be available', () => {
    const ra = new RealtimeAgent({
      name: 'test',
      instructions: 'test',
    });
    expect(ra).toBeDefined();
  });
});

describe('RealtimeSession', () => {
  test('should be available', () => {
    const session = new RealtimeSession(
      new RealtimeAgent({
        name: 'test',
        instructions: 'test',
      }),
    );
    expect(session).toBeDefined();
  });
});

describe('Sensitive data logging', () => {
  test('exports the programmatic logging override', () => {
    expect(typeof setSensitiveDataLoggingEnabled).toBe('function');
  });
});
