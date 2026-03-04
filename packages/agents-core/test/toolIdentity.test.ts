import { describe, expect, it } from 'vitest';

import {
  FUNCTION_TOOL_NAMESPACE,
  resolveFunctionToolCallName,
} from '../src/toolIdentity';

function createToolLookup(
  tools: Array<{ key: string; value?: Record<string, any> }>,
): Map<string, Record<string, any>> {
  return new Map(tools.map(({ key, value }) => [key, value ?? { name: key }]));
}

describe('resolveFunctionToolCallName', () => {
  it('prefers the bare name for self-namespaced top-level deferred calls', () => {
    const availableToolNames = createToolLookup([
      {
        key: 'lookup_account',
        value: {
          type: 'function',
          name: 'lookup_account',
          deferLoading: true,
        },
      },
    ]);

    expect(
      resolveFunctionToolCallName(
        {
          name: 'lookup_account',
          namespace: 'lookup_account',
        },
        availableToolNames,
      ),
    ).toBe('lookup_account');
  });

  it('falls back to the qualified name when a self-namespaced bare tool is absent', () => {
    const availableToolNames = new Set(['lookup_account.lookup_account']);

    expect(
      resolveFunctionToolCallName(
        {
          name: 'lookup_account',
          namespace: 'lookup_account',
        },
        availableToolNames,
      ),
    ).toBe('lookup_account.lookup_account');
  });

  it('prefers the bare name when both self-namespaced candidates are present', () => {
    const availableToolNames = createToolLookup([
      {
        key: 'lookup_account',
        value: {
          type: 'function',
          name: 'lookup_account',
          deferLoading: true,
        },
      },
      {
        key: 'lookup_account.lookup_account',
        value: {
          type: 'function',
          name: 'lookup_account',
          deferLoading: true,
          [FUNCTION_TOOL_NAMESPACE]: 'lookup_account',
        },
      },
    ]);

    expect(
      resolveFunctionToolCallName(
        {
          name: 'lookup_account',
          namespace: 'lookup_account',
        },
        availableToolNames,
      ),
    ).toBe('lookup_account');
  });

  it('prefers the qualified name when the bare tool is not deferred', () => {
    const availableToolNames = createToolLookup([
      {
        key: 'lookup_account',
        value: {
          type: 'function',
          name: 'lookup_account',
          deferLoading: false,
        },
      },
      {
        key: 'lookup_account.lookup_account',
        value: {
          type: 'function',
          name: 'lookup_account',
          deferLoading: true,
          [FUNCTION_TOOL_NAMESPACE]: 'lookup_account',
        },
      },
    ]);

    expect(
      resolveFunctionToolCallName(
        {
          name: 'lookup_account',
          namespace: 'lookup_account',
        },
        availableToolNames,
      ),
    ).toBe('lookup_account.lookup_account');
  });

  it('keeps qualified matches for real namespace calls', () => {
    const availableToolNames = new Set([
      'lookup_account',
      'crm.lookup_account',
    ]);

    expect(
      resolveFunctionToolCallName(
        {
          name: 'lookup_account',
          namespace: 'crm',
        },
        availableToolNames,
      ),
    ).toBe('crm.lookup_account');
  });
});
