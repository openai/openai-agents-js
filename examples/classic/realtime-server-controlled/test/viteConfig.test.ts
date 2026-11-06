import { describe, expect, it } from 'vitest';
import { createViteConfig } from '../vite.config';

describe('createViteConfig', () => {
  it('routes API requests to the configured backend port', () => {
    const config = createViteConfig({ PORT: '4123' });

    expect(config.server?.proxy?.['/api']).toBe('http://127.0.0.1:4123');
    expect(config.server?.port).toBe(5173);
    expect(config.server?.strictPort).toBe(true);
  });

  it('rejects an invalid backend port', () => {
    expect(() => createViteConfig({ PORT: 'not-a-port' })).toThrow(
      'PORT must be a valid TCP port.',
    );
  });
});
