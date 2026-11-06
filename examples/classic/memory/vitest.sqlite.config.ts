import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['sessions/*.test.ts'],
  },
});
