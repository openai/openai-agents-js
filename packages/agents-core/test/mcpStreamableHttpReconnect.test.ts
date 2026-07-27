import { describe, expect, it, vi } from 'vitest';

import { NodeMCPServerStreamableHttp } from '../src/shims/mcp-server/node';

function makeServer() {
  const server = new NodeMCPServerStreamableHttp({
    url: 'http://localhost:9/mcp',
    name: 'reconnect-test-server',
  });
  (server as any).session = { fake: true };
  return server;
}

describe('NodeMCPServerStreamableHttp reconnect recovery under cancellation', () => {
  it('skips reconnection when the call was already cancelled', async () => {
    const server = makeServer();
    const connError = Object.assign(new Error('connection closed'), {
      code: -32000,
    });
    const callToolWithClient = vi.fn(async () => {
      throw connError;
    });
    const shouldReconnect = vi.fn(async () => 'reconnect-and-retry');
    const reconnect = vi.fn(async () => ({ fake: true }));
    (server as any).callToolWithClient = callToolWithClient;
    (server as any).shouldReconnectClosedStreamableHttpClient = shouldReconnect;
    (server as any).reconnectClosedStreamableHttpClient = reconnect;

    const controller = new AbortController();
    controller.abort(new Error('user aborted'));

    await expect(
      server.callToolResult('slow_tool', {}, undefined, {
        signal: controller.signal,
      }),
    ).rejects.toBe(connError);
    expect(reconnect).not.toHaveBeenCalled();
    expect(callToolWithClient).toHaveBeenCalledTimes(1);
  });

  it('stops before the retry when cancellation arrives during reconnection', async () => {
    const server = makeServer();
    const connError = Object.assign(new Error('connection closed'), {
      code: -32000,
    });
    const callToolWithClient = vi.fn(async () => {
      throw connError;
    });
    const controller = new AbortController();
    const shouldReconnect = vi.fn(async () => 'reconnect-and-retry');
    const reconnect = vi.fn(async () => {
      controller.abort(new Error('user aborted'));
      return { fake: true };
    });
    (server as any).callToolWithClient = callToolWithClient;
    (server as any).shouldReconnectClosedStreamableHttpClient = shouldReconnect;
    (server as any).reconnectClosedStreamableHttpClient = reconnect;

    await expect(
      server.callToolResult('slow_tool', {}, undefined, {
        signal: controller.signal,
      }),
    ).rejects.toBe(connError);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(callToolWithClient).toHaveBeenCalledTimes(1);
  });

  it('unwinds immediately when cancellation arrives while reconnection is pending', async () => {
    const server = makeServer();
    const connError = Object.assign(new Error('connection closed'), {
      code: -32000,
    });
    const callToolWithClient = vi.fn(async () => {
      throw connError;
    });
    let releaseReconnect!: (client: unknown) => void;
    const reconnect = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseReconnect = resolve;
        }),
    );
    const shouldReconnect = vi.fn(async () => 'reconnect-and-retry');
    (server as any).callToolWithClient = callToolWithClient;
    (server as any).shouldReconnectClosedStreamableHttpClient = shouldReconnect;
    (server as any).reconnectClosedStreamableHttpClient = reconnect;

    const controller = new AbortController();
    const outcome = server
      .callToolResult('slow_tool', {}, undefined, {
        signal: controller.signal,
      })
      .then(
        () => ({ kind: 'resolved' as const }),
        (error) => ({ kind: 'rejected' as const, error }),
      );

    await Promise.resolve();
    controller.abort(new Error('user aborted'));

    expect(await outcome).toEqual({ kind: 'rejected', error: connError });
    expect(callToolWithClient).toHaveBeenCalledTimes(1);

    releaseReconnect({ fake: true });
  });

  it('still reconnects and retries when no signal is aborted', async () => {
    const server = makeServer();
    const connError = Object.assign(new Error('connection closed'), {
      code: -32000,
    });
    const successResult = { content: [{ type: 'text', text: 'ok' }] };
    const callToolWithClient = vi
      .fn()
      .mockRejectedValueOnce(connError)
      .mockResolvedValueOnce(successResult);
    const shouldReconnect = vi.fn(async () => 'reconnect-and-retry');
    const reconnect = vi.fn(async () => ({ fake: true }));
    (server as any).callToolWithClient = callToolWithClient;
    (server as any).shouldReconnectClosedStreamableHttpClient = shouldReconnect;
    (server as any).reconnectClosedStreamableHttpClient = reconnect;

    await expect(
      server.callToolResult('slow_tool', {}, undefined, {
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(successResult);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(callToolWithClient).toHaveBeenCalledTimes(2);
  });
});
