import { describe, expect, it } from 'vitest';
import { ResponsesWebSocketConnection } from '../src/responsesWebSocketConnection';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

const createSocketStub = (): WebSocket =>
  ({
    addEventListener: () => {},
    removeEventListener: () => {},
  }) as unknown as WebSocket;

describe('ResponsesWebSocketConnection keepalive timer bounds', () => {
  it.each(['pingIntervalMs', 'pingTimeoutMs'] as const)(
    'accepts %s at the maximum Node timer delay',
    (fieldName) => {
      expect(
        () =>
          new ResponsesWebSocketConnection(createSocketStub(), {
            [fieldName]: MAX_TIMER_DELAY_MS,
          }),
      ).not.toThrow();
    },
  );

  it.each(['pingIntervalMs', 'pingTimeoutMs'] as const)(
    'rejects %s above the maximum Node timer delay',
    (fieldName) => {
      expect(
        () =>
          new ResponsesWebSocketConnection(createSocketStub(), {
            [fieldName]: MAX_TIMER_DELAY_MS + 1,
          }),
      ).toThrow(
        `Responses websocket ${fieldName} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}, or null.`,
      );
    },
  );
});
