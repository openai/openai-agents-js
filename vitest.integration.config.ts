import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['./integration-tests/*.test.ts'],
    globalSetup: './integration-tests/_helpers/setup.ts',
    hookTimeout: 120_000,
  },
});
