import process from 'node:process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build, loadConfig } from 'tsc-multi';
import { buildEsmDeclarations } from './build-esm-declarations.mjs';

export async function buildPackages(config) {
  const ts = createRequire(import.meta.url)(config.compiler ?? 'typescript');
  // Projects are configured in dependency order. Finish each dependency's ESM
  // graph before its consumers, then leave the actual CommonJS declarations.
  for (const project of config.projects) {
    for (const target of config.targets) {
      const status = await build({
        ...config,
        projects: [project],
        targets: [target],
        maxWorkers: 1,
      });
      if (status !== 0) return status;
      if (target.extname === '.mjs') {
        const file = resolve(config.cwd, project);
        const parsed = ts.getParsedCommandLineOfConfigFile(
          file,
          {},
          {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic(diagnostic) {
              throw new Error(
                ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
              );
            },
          },
        );
        buildEsmDeclarations(parsed.options.outDir);
      }
    }
  }
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  process.exitCode = await buildPackages(await loadConfig({ cwd }));
}
