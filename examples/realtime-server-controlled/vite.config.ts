import type { UserConfig } from 'vite';
import { defineConfig, loadEnv } from 'vite';
import { parseApiPort } from './src/shared/config';

export function createViteConfig(
  env: Record<string, string | undefined>,
): UserConfig {
  const apiPort = parseApiPort(env.PORT);
  return {
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/api': `http://127.0.0.1:${apiPort}`,
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  return createViteConfig(loadEnv(mode, process.cwd(), ''));
});
