import { describe, expect, it } from 'vitest';
import { UserError } from '../src/errors';
import {
  applySessionHistoryMutations,
  sessionHistoryItemsMatch,
} from '../src/memory/historyMutations';
import type { SessionHistoryMutation } from '../src/memory/session';
import type { AgentInputItem } from '../src/types';

const userMessage = (content: string): AgentInputItem => ({
  type: 'message',
  role: 'user',
  content,
});

const functionCall = (
  callId: string,
  name: string,
  args: string,
): Extract<AgentInputItem, { type: 'function_call' }> => ({
  type: 'function_call',
  callId,
  name,
  arguments: args,
  status: 'completed',
});

describe('applySessionHistoryMutations', () => {
  it('preserves the released call-ID replacement behavior when expected is omitted', () => {
    const replacement = functionCall('call_1', 'fixed', '{"ok":true}');
    const mutation: SessionHistoryMutation = {
      type: 'replace_function_call',
      callId: 'call_1',
      replacement,
    };
    const items: AgentInputItem[] = [
      userMessage('before'),
      functionCall('call_1', 'broken', '{}'),
      functionCall('call_2', 'keep', '{}'),
      functionCall('call_1', 'duplicate', '{}'),
      userMessage('after'),
    ];

    expect(applySessionHistoryMutations(items, [mutation])).toEqual([
      userMessage('before'),
      replacement,
      functionCall('call_2', 'keep', '{}'),
      userMessage('after'),
    ]);
  });

  it('replaces the latest expected function call without changing an older reused call ID', () => {
    const olderCall = functionCall('call_1', 'lookup', '{"run":"older"}');
    const expected = functionCall('call_1', 'lookup', '{"run":"current"}');
    const replacement = functionCall('call_1', 'lookup', '{"ok":true}');
    const mutation: SessionHistoryMutation = {
      type: 'replace_function_call',
      callId: 'call_1',
      expected,
      replacement,
    };
    const items: AgentInputItem[] = [
      userMessage('before'),
      structuredClone(expected),
      olderCall,
      functionCall('call_2', 'keep', '{}'),
      expected,
      userMessage('after'),
    ];

    const result = applySessionHistoryMutations(items, [mutation]);
    const expectedResult = [
      userMessage('before'),
      expected,
      olderCall,
      functionCall('call_2', 'keep', '{}'),
      replacement,
      userMessage('after'),
    ];

    expect(result).toEqual(expectedResult);
    expect(applySessionHistoryMutations(result, [mutation])).toEqual(
      expectedResult,
    );
  });

  it('preserves valid unrelated history without applying function-call snapshot rules', () => {
    const optionalMetadataMessage = {
      ...userMessage('optional metadata'),
      providerData: undefined,
    } as AgentInputItem;
    const binaryMetadataMessage = {
      ...userMessage('binary metadata'),
      providerData: { bytes: new Uint8Array([1, 2, 3]) },
    } as AgentInputItem;
    const expected = functionCall('call_1', 'lookup', '{"run":"current"}');
    const replacement = functionCall('call_1', 'lookup', '{"ok":true}');

    expect(
      applySessionHistoryMutations(
        [optionalMetadataMessage, binaryMetadataMessage, expected],
        [
          {
            type: 'replace_function_call',
            callId: 'call_1',
            expected,
            replacement,
          },
        ],
      ),
    ).toEqual([optionalMetadataMessage, binaryMetadataMessage, replacement]);
  });

  it('rejects a replacement when the expected function call is missing', () => {
    const expected = functionCall('call_1', 'lookup', '{"run":"current"}');
    const replacement = functionCall('call_1', 'lookup', '{"ok":true}');

    expect(() =>
      applySessionHistoryMutations(
        [functionCall('call_1', 'lookup', '{"run":"older"}')],
        [
          {
            type: 'replace_function_call',
            callId: 'call_1',
            expected,
            replacement,
          },
        ],
      ),
    ).toThrow('could not find the expected function call');
  });

  it('redacts accessor errors before cloning expected-bearing history', () => {
    const secret = 'SECRET_HISTORY_ACCESSOR';
    const item = functionCall('call_1', 'lookup', '{}');
    Object.defineProperty(item, 'providerData', {
      enumerable: true,
      get() {
        throw new Error(secret);
      },
    });
    const expected = functionCall('call_1', 'lookup', '{}');
    const replacement = functionCall('call_1', 'lookup', '{"ok":true}');

    let error: unknown;
    try {
      applySessionHistoryMutations(
        [item],
        [
          {
            type: 'replace_function_call',
            callId: 'call_1',
            expected,
            replacement,
          },
        ],
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(UserError);
    expect(String(error)).toContain(
      'Session history items could not be compared safely',
    );
    expect(String(error)).not.toContain(secret);
  });

  it('rejects indexed history accessors without executing them', () => {
    const expected = functionCall('call_1', 'lookup', '{}');
    const history = new Array<AgentInputItem>(1);
    let reads = 0;
    Object.defineProperty(history, '0', {
      enumerable: true,
      get() {
        reads += 1;
        return expected;
      },
    });

    expect(() =>
      applySessionHistoryMutations(history, [
        {
          type: 'replace_function_call',
          callId: 'call_1',
          expected,
          replacement: functionCall('call_1', 'lookup', '{"ok":true}'),
        },
      ]),
    ).toThrow('Session history items could not be compared safely');
    expect(reads).toBe(0);
  });

  it('redacts accessor errors on the mutation envelope before reading fields', () => {
    const secret = 'SECRET_MUTATION_ACCESSOR';
    const replacement = functionCall('call_1', 'lookup', '{"ok":true}');
    const mutation: Record<string, unknown> = {
      type: 'replace_function_call',
      callId: 'call_1',
      replacement,
    };
    Object.defineProperty(mutation, 'expected', {
      enumerable: true,
      get() {
        throw new Error(secret);
      },
    });

    let error: unknown;
    try {
      applySessionHistoryMutations([], [mutation as SessionHistoryMutation]);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(UserError);
    expect(String(error)).toContain(
      'Session history items could not be compared safely',
    );
    expect(String(error)).not.toContain(secret);
  });

  it.each([null, false, 0, ''])(
    'rejects a present malformed expected value %# before legacy replacement',
    (expected) => {
      const items: AgentInputItem[] = [
        functionCall('call_1', 'older', '{}'),
        functionCall('call_1', 'current', '{}'),
      ];
      const originalItems = structuredClone(items);
      const mutation = {
        type: 'replace_function_call',
        callId: 'call_1',
        expected,
        replacement: functionCall('call_1', 'fixed', '{"ok":true}'),
      } as unknown as SessionHistoryMutation;

      expect(() => applySessionHistoryMutations(items, [mutation])).toThrow(
        'Session history items could not be compared safely',
      );
      expect(items).toEqual(originalItems);
    },
  );

  it.each([
    [
      'non-finite numbers',
      { value: Number.POSITIVE_INFINITY },
      { value: null },
    ],
    ['negative zero', { value: -0 }, { value: 0 }],
    ['undefined object values', { value: undefined }, {}],
    ['sparse arrays', { values: new Array(1) }, { values: [null] }],
  ])(
    'rejects lossy %s before matching history',
    (_name, actualData, expectedData) => {
      const actual = {
        ...functionCall('call_1', 'lookup', '{}'),
        providerData: actualData,
      };
      const expected = {
        ...functionCall('call_1', 'lookup', '{}'),
        providerData: expectedData,
      };

      expect(() =>
        applySessionHistoryMutations(
          [actual],
          [
            {
              type: 'replace_function_call',
              callId: 'call_1',
              expected,
              replacement: functionCall('call_1', 'lookup', '{"ok":true}'),
            },
          ],
        ),
      ).toThrow('Session history items could not be compared safely');
    },
  );

  it('rejects enumerable array accessors without executing them', () => {
    const values: unknown[] = [];
    let reads = 0;
    Object.defineProperty(values, 'secret', {
      enumerable: true,
      get() {
        reads += 1;
        return 'different';
      },
    });
    const actual = {
      ...functionCall('call_1', 'lookup', '{}'),
      providerData: { values },
    };
    const expected = {
      ...functionCall('call_1', 'lookup', '{}'),
      providerData: { values: [] },
    };

    expect(() =>
      applySessionHistoryMutations(
        [actual],
        [
          {
            type: 'replace_function_call',
            callId: 'call_1',
            expected,
            replacement: functionCall('call_1', 'lookup', '{"ok":true}'),
          },
        ],
      ),
    ).toThrow('Session history items could not be compared safely');
    expect(reads).toBe(0);
  });

  it('orders distinct Unicode keys independently of locale collation', () => {
    const composed = 'é';
    const decomposed = 'e\u0301';
    const base = functionCall('call_1', 'lookup', '{}');
    const left = {
      ...base,
      providerData: { [composed]: 1, [decomposed]: 2 },
    };
    const right = {
      ...base,
      providerData: { [decomposed]: 2, [composed]: 1 },
    };

    expect(composed).not.toBe(decomposed);
    expect(sessionHistoryItemsMatch(left, right)).toBe(true);
  });

  it('returns cloned items and cloned replacements', () => {
    const original = functionCall('call_1', 'broken', '{}');
    const replacement = functionCall('call_1', 'fixed', '{"ok":true}');

    const result = applySessionHistoryMutations(
      [original],
      [
        {
          type: 'replace_function_call',
          callId: 'call_1',
          expected: original,
          replacement,
        },
      ],
    );

    expect(result).toEqual([replacement]);
    expect(result[0]).not.toBe(original);
    expect(result[0]).not.toBe(replacement);
  });
});
