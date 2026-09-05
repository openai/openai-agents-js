import { check } from 'prettier';
import { describe, expect, it } from 'vitest';
import { applyDiff } from '../../src/utils/applyDiff';

describe('applyDiff CRLF workflow', () => {
  it('keeps a patched CRLF TypeScript file acceptable to a CRLF formatting check', async () => {
    const input = 'const alpha = 1;\r\nconst beta = 2;\r\n';
    const diff = [
      '@@',
      ' const alpha = 1;',
      '+const inserted = 3;',
      ' const beta = 2;',
    ].join('\n');

    const patched = applyDiff(input, diff);

    expect(
      await check(patched, {
        parser: 'typescript',
        endOfLine: 'crlf',
      }),
    ).toBe(true);
  });
});
