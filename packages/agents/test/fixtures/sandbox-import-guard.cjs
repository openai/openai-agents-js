/* global process */
const { registerHooks, syncBuiltinESMExports } =
  process.getBuiltinModule('node:module');
const childProcess = process.getBuiltinModule('node:child_process');
for (const name of [
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
]) {
  childProcess[name] = () => {
    throw new Error('Import attempted process creation');
  };
}
syncBuiltinESMExports();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      /^(modal|e2b|@e2b\/code-interpreter|@daytonaio\/sdk|@blaxel\/core|@vercel\/sandbox)$/.test(
        specifier,
      )
    )
      throw new Error('Import loaded optional cloud SDK: ' + specifier);
    const result = nextResolve(specifier, context);
    if (result.url.endsWith('.node') || result.url.includes('/native/index.js'))
      throw new Error('Import loaded native addon: ' + result.url);
    return result;
  },
});
