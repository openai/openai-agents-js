import { defineConfig } from 'vitest/config';

process.env.NODE_ENV = 'test';

export default defineConfig({
  test: {
    include: ['./integration-tests/*.test.ts'],
    globalSetup: './integration-tests/_helpers/setup.ts',
    hookTimeout: 120_000,
  },
});
