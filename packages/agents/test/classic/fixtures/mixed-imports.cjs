/* global require */
/* oxlint-disable typescript/no-require-imports -- This fixture verifies CommonJS loading. */
const process = require('node:process');
const console = require('node:console');
(async () => {
  const { checkMixedImports } = await import('./import-checks.mjs');
  await checkMixedImports((specifier) => require(specifier), process.argv[2]);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
