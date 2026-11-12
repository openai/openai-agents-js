import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { it } from 'vitest';

it.each([true, false])(
  'matches both OpenAI client entrypoints with synchronous ESM loading %s',
  (requireModule) => {
    const script = `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { dirname, join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      const require = createRequire(import.meta.url);
      const sdkRequire = createRequire(import.meta.resolve('@openai/agents-codex'));
      const sdkCjs = require('@openai/agents-codex');
      const sdkDist = dirname(require.resolve('@openai/agents-codex'));
      // Node may select the ESM facade backed by CJS. Exercise the actual ESM build too.
      const sdkEsm = await import(pathToFileURL(join(sdkDist, 'index.mjs')));
      assert.notEqual(sdkEsm.responsesCompaction, sdkCjs.responsesCompaction);
      const openai = dirname(sdkRequire.resolve('openai'));
      const ESM = (await import(pathToFileURL(join(openai, 'index.mjs')))).default;
      const CJS = sdkRequire(join(openai, 'index.js'));
      assert.notEqual(ESM.prototype, CJS.prototype);

      const apiKey = 'synthetic-compaction';
      const baseURL = 'http://127.0.0.1:9/v1';
      const options = {
        baseURL, apiKey, fetch: globalThis.fetch, organization: null, project: null,
      };
      const config = {
        model_provider: 'fixture',
        'model_providers.fixture': { base_url: baseURL },
      };

      const overridden = new ESM(options);
      overridden.post = () => { throw new Error('unexpected dispatch'); };
      const invalid = sdkCjs.responsesCompaction({ client: overridden });
      delete overridden.post;
      await invalid.loadClientEntrypoint();
      assert.equal(invalid.matchesProvider(apiKey, config), false);

      const missing = new ESM(options);
      const savedOptions = missing._options;
      delete missing._options;
      const missingCapture = sdkCjs.responsesCompaction({ client: missing });
      missing._options = savedOptions;
      await missingCapture.loadClientEntrypoint();
      assert.equal(missingCapture.matchesProvider(apiKey, config), false);

      const changed = new ESM(options);
      const captured = sdkCjs.responsesCompaction({ client: changed });
      const loading = captured.loadClientEntrypoint();
      changed.baseURL = 'http://127.0.0.1:9/other';
      await loading;
      assert.throws(
        () => captured.matchesProvider(apiKey, config),
        /scope changed after capture/,
      );

      for (const [sdk, factory] of [['ESM', sdkEsm], ['CJS', sdkCjs]]) {
        for (const [entrypoint, Client] of [['ESM', ESM], ['CJS', CJS]]) {
          const compaction = factory.responsesCompaction({ client: new Client(options) });
          await compaction.loadClientEntrypoint();
          assert.equal(compaction.matchesProvider(apiKey, config), true, sdk + '/' + entrypoint);
        }
      }
    `;
    execFileSync(
      process.execPath,
      [
        ...(requireModule ? [] : ['--no-experimental-require-module']),
        '--input-type=module',
        '--eval',
        script,
      ],
      {
        cwd: resolve(import.meta.dirname, '..'),
        stdio: 'pipe',
      },
    );
  },
);
