/* global require */
/* oxlint-disable typescript/no-require-imports -- This fixture verifies CommonJS loading. */
const process = require('node:process');
const console = require('node:console');
(async () => {
  const { checkConditions } = await import('./import-checks.mjs');
  await checkConditions(
    (specifier) => require(specifier),
    require.resolve,
    process.argv[2],
    'js',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
