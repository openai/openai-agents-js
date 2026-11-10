import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('loads compiled decision and form validators without synchronous ESM support', () => {
  const packageRoot = resolve(import.meta.dirname, '..');
  const script = `
    const assert = require('node:assert/strict');
    const { pathToFileURL } = require('node:url');
    const path = require('node:path');
    const root = ${JSON.stringify(packageRoot)};
    const { Agent, OutputValidationError } = require(path.join(root, 'dist/index.js'));
    const nativePath = path.join(root, 'native/index.js');

    async function check() {
      assert.equal(require.cache[nativePath], undefined);
      const good = new Agent({
        instructions: 'Choose.',
        decisions: { async getDecision() { return { value: true }; } },
      });
      assert.equal(await good.decide('Ready?', { input: 'Explicit.' }), true);
      const bad = new Agent({
        instructions: 'Choose.',
        decisions: { async getDecision() { return { value: 'yes' }; } },
      });
      await assert.rejects(
        bad.decide('Ready?', { input: 'Explicit.' }),
        OutputValidationError,
      );
      assert.equal(require.cache[nativePath], undefined);

      const modules = [
        require(path.join(root, 'dist/runtime/native-forms.js')),
        await import(pathToFileURL(path.join(root, 'dist/runtime/native-forms.mjs'))),
      ];
      for (const { prepareNativeForm } of modules) {
        const schema = {
          type: 'object',
          properties: { url: { type: 'string', format: 'uri' } },
          required: ['url'],
        };
        const pending = prepareNativeForm('form', schema);
        schema.properties.url.format = 'email';
        const standard = await pending;
        assert.deepEqual(standard.validate({ url: 'urn:example:item' }), {
          url: 'urn:example:item',
        });
        assert.throws(() => standard.validate({ url: 'invalid URI\\n' }), {
          message: 'MCP form failed validation',
        });

        const extension = {
          type: 'object',
          properties: { number: { type: 'number', multipleOf: 0.1 } },
          required: ['number'],
        };
        const forms = await Promise.all(
          Array.from({ length: 4 }, () => prepareNativeForm('openai/form', extension)),
        );
        for (const form of forms) {
          assert.deepEqual(form.validate({ number: 0.3 }), { number: 0.3 });
          assert.throws(() => form.validate({ number: 0.35 }), {
            message: 'MCP form failed validation',
          });
        }
      }
      process.stdout.write('validated');
    }
    check().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const output = execFileSync(
    process.execPath,
    [
      '--no-experimental-require-module',
      '--input-type=commonjs',
      '--eval',
      script,
    ],
    { encoding: 'utf8', stdio: 'pipe' },
  );
  expect(output).toBe('validated');
});
