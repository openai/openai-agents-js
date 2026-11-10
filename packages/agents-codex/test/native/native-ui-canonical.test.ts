import { describe, expect, it } from 'vitest';
import type { SessionItem } from '@openai/agents';
import {
  completeDisplay,
  nativeBlank,
  type ViewSession,
} from '../../../../examples/codex/native-ui/projection';

type Message = Extract<SessionItem, { type: 'message' }>;

function message(
  id: string,
  text: string,
  options: Partial<Pick<Message, 'phase' | 'turnId' | 'role' | 'status'>> = {},
): Message {
  return {
    id,
    turnId: 'last',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    phase: null,
    content: [{ type: 'output_text', text }],
    ...options,
  };
}

// Only the public read surface is needed; this fixture issues no SDK authority.
function session(items: readonly SessionItem[]): ViewSession {
  return {
    id: 'session',
    async *items() {
      yield* items;
    },
  };
}

function complete(
  items: readonly SessionItem[],
  shown: readonly (readonly [string, string])[],
  output: unknown,
  plain = true,
): Promise<boolean> {
  return completeDisplay(
    session(items),
    null,
    new Set(['earlier', 'last']),
    'last',
    new Map(shown),
    plain,
    output,
    new AbortController().signal,
  );
}

describe('native UI canonical display identity', () => {
  it('uses the later nonblank unphased message over an earlier final_answer', async () => {
    const items = [
      message('final', 'first', { phase: 'final_answer' }),
      message('later', 'last'),
    ];
    const shown = [
      ['final', 'first'],
      ['later', 'last'],
    ] as const;
    expect(await complete(items, shown, 'first')).toBe(false);
    expect(await complete(items, shown, 'last')).toBe(true);
  });

  it('uses a later final_answer over an earlier nonblank unphased message', async () => {
    const items = [
      message('unphased', 'earlier'),
      message('final', 'answer', { phase: 'final_answer' }),
    ];
    const shown = [
      ['unphased', 'earlier'],
      ['final', 'answer'],
    ] as const;
    expect(await complete(items, shown, 'earlier')).toBe(false);
    expect(await complete(items, shown, 'answer')).toBe(true);
  });

  it('uses the last of repeated final_answer candidates', async () => {
    const items = [
      message('first', 'first', { phase: 'final_answer' }),
      message('second', 'second', { phase: 'final_answer' }),
    ];
    const shown = [
      ['first', 'first'],
      ['second', 'second'],
    ] as const;
    expect(await complete(items, shown, 'first')).toBe(false);
    expect(await complete(items, shown, 'second')).toBe(true);
  });

  it('does not let a later blank unphased message displace a nonblank candidate', async () => {
    const items = [
      message('final', 'answer', { phase: 'final_answer' }),
      message('blank', '\u0085'),
    ];
    expect(
      await complete(
        items,
        [
          ['final', 'answer'],
          ['blank', '\u0085'],
        ],
        'answer',
      ),
    ).toBe(true);
  });

  it('does not accept equal commentary as observation of the final ID', async () => {
    const items = [
      message('commentary', 'answer', { phase: 'commentary' }),
      message('final', 'answer', { phase: 'final_answer' }),
    ];
    expect(await complete(items, [['commentary', 'answer']], 'answer')).toBe(
      false,
    );
    expect(
      await complete(
        items,
        [
          ['commentary', 'answer'],
          ['final', 'answer'],
        ],
        'answer',
      ),
    ).toBe(true);
  });

  it('does not promote commentary when it is the only recorded message', async () => {
    expect(
      await complete(
        [message('commentary', 'answer', { phase: 'commentary' })],
        [['commentary', 'answer']],
        'answer',
      ),
    ).toBe(false);
  });

  it('does not treat a done-only final output as observed text', async () => {
    expect(await complete([], [], 'answer')).toBe(false);
    expect(await complete([message('final', 'answer')], [], 'answer')).toBe(
      false,
    );
  });

  it('requires every shown message to match, even when the final matches', async () => {
    const items = [
      message('commentary', 'working', { phase: 'commentary' }),
      message('final', 'answer'),
    ];
    expect(
      await complete(
        items,
        [
          ['commentary', 'working'],
          ['final', 'answer'],
        ],
        'answer',
      ),
    ).toBe(true);
    expect(
      await complete(
        items,
        [
          ['commentary', 'partial'],
          ['final', 'answer'],
        ],
        'answer',
      ),
    ).toBe(false);
    expect(
      await complete(
        items,
        [
          ['missing', 'working'],
          ['final', 'answer'],
        ],
        'answer',
      ),
    ).toBe(false);
  });

  it('compares the full ordered text of every content part exactly', async () => {
    const final = message('final', '');
    final.content = [
      { type: 'output_text', text: ' leading ' },
      { type: 'input_image', image_url: 'https://example.invalid/image.png' },
      { type: 'output_text', text: 'trailing\n' },
    ];
    const text = ' leading trailing\n';
    expect(await complete([final], [['final', text]], text)).toBe(true);
    expect(await complete([final], [['final', text.trim()]], text)).toBe(false);
    expect(await complete([final], [['final', text]], text.trim())).toBe(false);
    expect(
      await complete([final], [['final', 'trailing\n leading ']], text),
    ).toBe(false);
  });

  it('selects the final candidate only from the last submitted turn', async () => {
    const items = [
      message('final', 'current'),
      message('old', 'earlier', { turnId: 'earlier', phase: 'final_answer' }),
    ];
    const shown = [
      ['old', 'earlier'],
      ['final', 'current'],
    ] as const;
    expect(await complete(items, shown, 'earlier')).toBe(false);
    expect(await complete(items, shown, 'current')).toBe(true);
  });

  it.each<Message['status']>(['in_progress', 'failed', 'incomplete'])(
    'does not use a %s message as canonical evidence',
    async (status) => {
      const items = [
        message('final', 'same'),
        message('unfinished', 'same', { status }),
      ];
      expect(await complete(items, [['final', 'same']], 'same')).toBe(true);
      expect(await complete(items, [['unfinished', 'same']], 'same')).toBe(
        false,
      );
    },
  );

  it.each<Partial<Pick<Message, 'role' | 'turnId'>>>([
    { role: 'user' },
    { turnId: 'unsubmitted' },
  ])('ignores ineligible message identity %j', async (options) => {
    const items = [
      message('final', 'same'),
      message('ineligible', 'same', options),
    ];
    expect(await complete(items, [['final', 'same']], 'same')).toBe(true);
    expect(await complete(items, [['ineligible', 'same']], 'same')).toBe(false);
  });
});

describe('native UI blank output', () => {
  it.each([
    ['', true],
    [' \t\r\n\u0085\u00a0\u1680\u2000\u2028\u2029\u202f\u205f\u3000', true],
    ['\ufeff', false],
    ['\u001c', false],
    [' \ufeff\n', false],
    [' \u001c\n', false],
    ['answer', false],
  ])('classifies %j with native Unicode White_Space', (text, blank) => {
    expect(nativeBlank(text)).toBe(blank);
  });

  it('allows an empty completion with no shown text', async () => {
    expect(await complete([], [], '')).toBe(true);
  });

  it('requires every nonempty blank message before accepting empty output', async () => {
    const items = [message('first', '\u0085'), message('last', '\u0085')];
    expect(await complete(items, [['first', '\u0085']], '')).toBe(false);
    expect(await complete(items, [['last', '\u0085']], '')).toBe(false);
    expect(
      await complete(
        items,
        [
          ['first', '\u0085'],
          ['last', '\u0085'],
        ],
        '',
      ),
    ).toBe(true);
  });

  it.each(['\ufeff', '\u001c'])(
    'does not equate nonblank %j with empty final output',
    async (text) => {
      const items = [message('final', text)];
      expect(await complete(items, [['final', text]], '')).toBe(false);
      expect(await complete(items, [['final', text]], text)).toBe(true);
    },
  );

  it('still requires exact recorded text before normalizing a blank completion', async () => {
    expect(
      await complete([message('final', '\u0085')], [['final', ' ']], ''),
    ).toBe(false);
  });
});

describe('native UI selected typed output declaration (plain=false)', () => {
  it('accepts typed output without inventing a textual observation', async () => {
    const output = {
      answer: 42,
      toString(): never {
        throw new Error('Typed output must not be coerced to display text');
      },
    };
    expect(await complete([], [], output, false)).toBe(true);
  });

  it('does not infer a plain declaration from a string-valued typed result', async () => {
    expect(await complete([], [], 'typed string', false)).toBe(true);
    expect(await complete([], [], 'typed string', true)).toBe(false);
  });

  it('validates shown text without comparing it with the typed output', async () => {
    const items = [message('commentary', 'working', { phase: 'commentary' })];
    const output = { answer: 42 };
    expect(
      await complete(items, [['commentary', 'working']], output, false),
    ).toBe(true);
    expect(
      await complete(items, [['commentary', 'wrong']], output, false),
    ).toBe(false);
    expect(await complete(items, [['missing', 'working']], output, false)).toBe(
      false,
    );
  });
});

describe('native UI complete canonical view', () => {
  it.each(['answer', ''])(
    'rejects unshown commentary even with final output %j',
    async (output) => {
      const items = [
        message('commentary', 'working', { phase: 'commentary' }),
        message('final', output, { phase: 'final_answer' }),
      ];
      const shown: [string, string][] = output ? [['final', output]] : [];
      expect(await complete(items, shown, output)).toBe(false);
      expect(
        await complete(
          items,
          [
            ['commentary', 'working'],
            ['final', output],
          ],
          output,
        ),
      ).toBe(true);
    },
  );

  it('requires commentary while allowing an unrendered typed final item', async () => {
    const items = [
      message('commentary', 'working', { phase: 'commentary' }),
      message('final', '{"answer":42}', { phase: 'final_answer' }),
    ];
    expect(await complete(items, [], { answer: 42 }, false)).toBe(false);
    expect(
      await complete(items, [['commentary', 'working']], { answer: 42 }, false),
    ).toBe(true);
    expect(
      await complete(items, [['final', 'incorrect']], { answer: 42 }, false),
    ).toBe(false);
  });

  it('does not accept empty output when canonical history is unavailable', async () => {
    const unavailable: ViewSession = {
      id: 'session',
      async *items() {
        yield* [];
        throw new Error('Unavailable history');
      },
    };
    expect(
      await completeDisplay(
        unavailable,
        null,
        new Set(['last']),
        'last',
        new Map(),
        true,
        '',
        new AbortController().signal,
      ),
    ).toBe(false);
  });
});
