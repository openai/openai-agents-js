import { describe, test, expect } from 'vitest';
import {
  RECOMMENDED_PROMPT_PREFIX,
  promptWithHandoffInstructions,
} from '../../src/extensions';

describe('RECOMMENDED_PROMPT_PREFIX', () => {
  test('should be available', () => {
    expect(RECOMMENDED_PROMPT_PREFIX).toBeDefined();
  });
});

describe('promptWithHandoffInstructions', () => {
  test('should be available', () => {
    expect(promptWithHandoffInstructions('foo')).toEqual(
      `${RECOMMENDED_PROMPT_PREFIX}\n\nfoo`,
    );
  });
});
