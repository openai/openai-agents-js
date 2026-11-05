import { inspect } from 'node:util';
import { expect, it, vi } from 'vitest';
import { captureChatGPTAuth } from '../../src/runtime/chatgpt-auth';
import { NativeProvider } from '../../src/runtime/provider';

it('accepts a bounded UTF-8 account identity and keeps Model authentication separate', async () => {
  const provider = new NativeProvider({
    apiKey: 'synthetic-model-key',
    chatGPT: { accountId: 'account-帐号', accessToken: 'synthetic-apps-token' },
  });
  const lease = provider._acquire();
  try {
    expect(lease.apiKey).toBe('synthetic-model-key');
    expect(lease.chatGPT?.accountId).toBe('account-帐号');
    expect(lease.chatGPT?.accessToken).toBe('synthetic-apps-token');
    expect(JSON.stringify(lease.config)).not.toContain('synthetic-apps-token');
  } finally {
    await lease.release();
    await provider.close();
  }
});

it('captures explicit ChatGPT credentials independently of later caller changes', () => {
  const original = { accountId: 'account-one', accessToken: 'synthetic-token' };
  const captured = captureChatGPTAuth(original)!;
  original.accountId = 'account-two';
  original.accessToken = 'other-token';
  expect(captured.accountId).toBe('account-one');
  expect(captured.accessToken).toBe('synthetic-token');
  expect(Object.isFrozen(captured)).toBe(true);
  expect(JSON.stringify(captured)).toBe('{}');
  expect(inspect(captured)).not.toContain('synthetic-token');
});

it('reads each supplied credential once and does not discover missing credentials', () => {
  const accountId = vi.fn(() => 'account-one');
  const accessToken = vi.fn(() => 'synthetic-token');
  const captured = captureChatGPTAuth({
    get accountId() {
      return accountId();
    },
    get accessToken() {
      return accessToken();
    },
  });
  expect(captured?.accessToken).toBe('synthetic-token');
  expect(accountId).toHaveBeenCalledTimes(1);
  expect(accessToken).toHaveBeenCalledTimes(1);
  expect(captureChatGPTAuth(undefined)).toBeUndefined();
});

it.each([
  {},
  null,
  { accountId: 'account-one' },
  { accessToken: 'synthetic-token' },
  { accountId: '', accessToken: 'synthetic-token' },
  { accountId: 'account-one', accessToken: '' },
  { accountId: 'account-one', accessToken: 'token\r\nInjected: header' },
  { accountId: 'account\nInjected', accessToken: 'synthetic-token' },
])(
  'rejects missing or unsafe explicit credentials before opening resources: %j',
  (value) => {
    expect(() => captureChatGPTAuth(value as never)).toThrow(TypeError);
  },
);
