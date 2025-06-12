import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*'],
    globalSetup: './helpers/tests/setup.ts',
    // Enable code coverage reporting with Vitest's built‑in integration. We
    // only enable it for the monorepo packages (workspaces) so that the
    // initial report focuses on our public libraries and avoids unnecessary
    // noise from docs and examples.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      all: true,
      // Only include source files from the published packages. This keeps the
      // metrics meaningful and prevents Vitest from trying to instrument node
      // dependencies or the compiled dist folder.
      include: ['packages/**/src/**/*.ts'],
      exclude: ['**/*.d.ts', 'packages/**/test/**', 'packages/**/dist/**'],
    },
  },
});
