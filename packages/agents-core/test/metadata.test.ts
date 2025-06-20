import { describe, test, expect } from 'vitest';
import METADATA from '../src/metadata';

describe('metadata', () => {
  test('is not unintentionally broken', () => {
    expect(METADATA.name).toBe('@chollier/agents-core');
    expect(METADATA.version).toBeDefined();
  });
});
