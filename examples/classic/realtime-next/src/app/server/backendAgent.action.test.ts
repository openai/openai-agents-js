import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RealtimeItem } from '@openai/agents/realtime';

const run = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    output: [],
    finalOutput: {
      refundApproved: true,
      refundReason: 'Eligible',
      fraud: false,
    },
  }),
);

vi.mock('@openai/agents/classic', () => ({
  Agent: class {},
  Runner: class {
    run = run;
  },
  user: (content: string) => ({ role: 'user', content }),
}));

async function action() {
  vi.resetModules();
  return import('./backendAgent.action');
}

describe('refund demo action', () => {
  beforeEach(() => {
    run.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('rejects production calls before using the model', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { handleRefundRequest } = await action();

    await expect(handleRefundRequest('Refund this order')).rejects.toThrow(
      'only in local development',
    );
    await expect(handleRefundRequest('Refund this order', [])).rejects.toThrow(
      'only in local development',
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects oversized request and history before using the model', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { handleRefundRequest } = await action();

    await expect(handleRefundRequest('x'.repeat(2001))).rejects.toThrow(
      'at most 2000 characters',
    );
    await expect(
      handleRefundRequest(
        'Refund this order',
        Array(31).fill({}) as RealtimeItem[],
      ),
    ).rejects.toThrow('at most 30 items');
    await expect(
      handleRefundRequest('Refund this order', [
        { text: 'x'.repeat(12000) },
      ] as unknown as RealtimeItem[]),
    ).rejects.toThrow('at most 12000 characters');
    expect(run).not.toHaveBeenCalled();
  });

  it('caps calls and preserves the refund response in local development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { handleRefundRequest } = await action();
    const history: RealtimeItem[] = [
      {
        itemId: 'prior_request',
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [{ type: 'input_text', text: 'My order arrived damaged.' }],
      },
    ];

    await expect(
      handleRefundRequest('Refund this order', history),
    ).resolves.toBe(
      '{"refundApproved":true,"refundReason":"Eligible","fraud":false}',
    );
    expect(log).toHaveBeenCalledWith([]);

    for (let i = 1; i < 20; i++) {
      await expect(handleRefundRequest('Refund this order')).resolves.toBe(
        '{"refundApproved":true,"refundReason":"Eligible","fraud":false}',
      );
    }
    await expect(handleRefundRequest('One more refund')).rejects.toThrow(
      'request limit reached',
    );
    expect(run).toHaveBeenCalledTimes(20);
  });
});
