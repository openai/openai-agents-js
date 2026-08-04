import { describe, expect, it } from 'vitest';

import {
  FUNCTION_TOOL_NAMESPACE,
  buildFunctionToolLookupMap,
  getFunctionToolLegacyStateKeyFromStateKey,
  getFunctionToolStateKeyForResolvedCall,
  getFunctionToolStateKeys,
  resolveFunctionToolCall,
} from '../src/toolIdentity';

describe('category-aware function tool lookup', () => {
  it('projects canonical state keys to released public approval names', () => {
    expect(getFunctionToolLegacyStateKeyFromStateKey('["bare","lookup"]')).toBe(
      'lookup',
    );
    expect(
      getFunctionToolLegacyStateKeyFromStateKey(
        '["deferred_top_level","lookup"]',
      ),
    ).toBe('lookup');
    expect(
      getFunctionToolLegacyStateKeyFromStateKey(
        '["namespaced","crm","lookup"]',
      ),
    ).toBe('crm.lookup');
    expect(getFunctionToolLegacyStateKeyFromStateKey('lookup')).toBeUndefined();
  });

  it('distinguishes bare and deferred top-level tools with the same name', () => {
    const bare = { type: 'function', name: 'lookup', deferLoading: false };
    const deferred = { type: 'function', name: 'lookup', deferLoading: true };
    const tools = buildFunctionToolLookupMap([bare, deferred]);

    expect(resolveFunctionToolCall({ name: 'lookup' }, tools)).toBe(bare);
    expect(
      resolveFunctionToolCall({ name: 'lookup', namespace: 'lookup' }, tools),
    ).toBe(deferred);
  });

  it('distinguishes dotted bare names from explicit namespaces', () => {
    const dotted = { type: 'function', name: 'crm.lookup' };
    const namespaced = {
      type: 'function',
      name: 'lookup',
      [FUNCTION_TOOL_NAMESPACE]: 'crm',
    };
    const tools = buildFunctionToolLookupMap([dotted, namespaced]);

    expect(resolveFunctionToolCall({ name: 'crm.lookup' }, tools)).toBe(dotted);
    expect(
      resolveFunctionToolCall({ name: 'lookup', namespace: 'crm' }, tools),
    ).toBe(namespaced);
  });

  it('resolves an unambiguous flattened qualified namespace call', () => {
    const namespaced = {
      type: 'function',
      name: 'lookup',
      [FUNCTION_TOOL_NAMESPACE]: 'crm',
    };
    const tools = buildFunctionToolLookupMap([namespaced]);

    expect(resolveFunctionToolCall({ name: 'crm.lookup' }, tools)).toBe(
      namespaced,
    );
  });

  it('leaves ambiguous flattened namespace calls unresolved', () => {
    const firstNamespaced = {
      type: 'function',
      name: 'lookup.detail',
      [FUNCTION_TOOL_NAMESPACE]: 'crm',
    };
    const secondNamespaced = {
      type: 'function',
      name: 'detail',
      [FUNCTION_TOOL_NAMESPACE]: 'crm.lookup',
    };
    const ambiguousTools = buildFunctionToolLookupMap([
      firstNamespaced,
      secondNamespaced,
    ]);

    expect(
      resolveFunctionToolCall({ name: 'crm.lookup.detail' }, ambiguousTools),
    ).toBeUndefined();

    const deferred = {
      type: 'function',
      name: 'crm.lookup.detail',
      deferLoading: true,
    };
    const toolsWithDeferred = buildFunctionToolLookupMap([
      firstNamespaced,
      secondNamespaced,
      deferred,
    ]);

    expect(
      resolveFunctionToolCall({ name: 'crm.lookup.detail' }, toolsWithDeferred),
    ).toBe(deferred);
  });

  it('accepts legacy bare calls for deferred tools only when no bare tool exists', () => {
    const deferred = { type: 'function', name: 'lookup', deferLoading: true };
    const tools = buildFunctionToolLookupMap([deferred]);

    expect(resolveFunctionToolCall({ name: 'lookup' }, tools)).toBe(deferred);
  });

  it('does not route a bare call to a deferred tool when a bare tool exists', () => {
    const bare = { type: 'function', name: 'lookup' };
    const deferred = { type: 'function', name: 'lookup', deferLoading: true };
    const tools = buildFunctionToolLookupMap([deferred, bare]);

    expect(resolveFunctionToolCall({ name: 'lookup' }, tools)).toBe(bare);
  });

  it('normalizes a resolved deferred bare fallback to its canonical state key', () => {
    const deferred = { type: 'function', name: 'lookup', deferLoading: true };

    expect(
      getFunctionToolStateKeyForResolvedCall({ name: 'lookup' }, deferred),
    ).toBe('["deferred_top_level","lookup"]');
    expect(
      getFunctionToolStateKeyForResolvedCall({ name: 'different' }, deferred),
    ).toBeUndefined();
  });

  it('keeps released state-key fallbacks when they are unambiguous', () => {
    const deferred = { type: 'function', name: 'lookup', deferLoading: true };
    const namespaced = {
      type: 'function',
      name: 'lookup',
      [FUNCTION_TOOL_NAMESPACE]: 'crm',
    };

    expect(getFunctionToolStateKeys(deferred, [deferred])).toEqual([
      '["deferred_top_level","lookup"]',
      'lookup',
    ]);
    expect(getFunctionToolStateKeys(namespaced, [namespaced])).toEqual([
      '["namespaced","crm","lookup"]',
      'crm.lookup',
    ]);
  });

  it('omits released state-key fallbacks when another category owns them', () => {
    const bare = { type: 'function', name: 'lookup' };
    const deferred = { type: 'function', name: 'lookup', deferLoading: true };
    const dotted = { type: 'function', name: 'crm.lookup' };
    const namespaced = {
      type: 'function',
      name: 'lookup',
      [FUNCTION_TOOL_NAMESPACE]: 'crm',
    };

    expect(getFunctionToolStateKeys(deferred, [bare, deferred])).toEqual([
      '["deferred_top_level","lookup"]',
    ]);
    expect(getFunctionToolStateKeys(bare, [bare, deferred])).toEqual([
      '["bare","lookup"]',
    ]);
    expect(getFunctionToolStateKeys(namespaced, [dotted, namespaced])).toEqual([
      '["namespaced","crm","lookup"]',
    ]);
    expect(getFunctionToolStateKeys(dotted, [dotted, namespaced])).toEqual([
      '["bare","crm.lookup"]',
    ]);
  });

  it('rejects explicit namespaces reserved for deferred top-level tools', () => {
    const namespaced = {
      type: 'function',
      name: 'lookup',
      [FUNCTION_TOOL_NAMESPACE]: 'lookup',
    };

    expect(() => buildFunctionToolLookupMap([namespaced])).toThrow(
      'Responses tool search reserves same-name namespaces for deferred top-level function tools.',
    );
  });
});
