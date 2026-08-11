import { describe, expect, test } from 'vitest';
import { execa } from 'execa';

import { createIntegrationSubprocessEnv } from './_helpers/env';

describe('released package API contract', () => {
  test('validates no-extra and all-optionals packages from Verdaccio', async () => {
    const env = createIntegrationSubprocessEnv();
    delete env.OPENAI_API_KEY;
    const result = await execa(
      'node',
      [
        'scripts/released-api-contract.mjs',
        'package',
        '--registry',
        'http://localhost:4873',
      ],
      {
        cwd: process.cwd(),
        env,
        timeout: 600_000,
      },
    );

    expect(result.stdout).toContain(
      'Released API package contract passed for no-extra and all-optionals profiles',
    );
  }, 620_000);
});
