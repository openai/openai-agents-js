import process from 'node:process';
import console from 'node:console';
import { watch } from 'node:fs';
import { clearTimeout, setTimeout } from 'node:timers';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build, loadConfig } from 'tsc-multi';
import { buildEsmDeclarations } from './build-esm-declarations.mjs';
import { buildCoreNode } from './build-core-node.mjs';

export async function buildPackages(config, isStopped = () => false) {
  const ts = createRequire(import.meta.url)(config.compiler ?? 'typescript');
  // Projects are configured in dependency order. Finish each dependency's ESM
  // graph before its consumers, then leave the actual CommonJS declarations.
  for (const project of config.projects) {
    for (const target of config.targets) {
      if (isStopped()) return 0;
      const status = await build({
        ...config,
        projects: [project],
        targets: [target],
        maxWorkers: 1,
      });
      if (status !== 0 || isStopped()) return status;
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
    if (
      !isStopped() &&
      resolve(config.cwd, project) ===
        resolve(config.cwd, 'packages/agents-core/tsconfig.json')
    ) {
      await buildCoreNode(resolve(config.cwd, 'packages/agents-core'));
    }
  }
  return 0;
}

// Run the same ordered build on changes so ESM and CommonJS declarations never
// race to overwrite each other, and dependents see the completed ESM graph.
export function watchPackages(
  config,
  onBuild = (status) => {
    console.log(
      `Package build ${status === 0 ? 'completed' : 'failed'}. Watching for changes.`,
    );
  },
) {
  const ts = createRequire(import.meta.url)(config.compiler ?? 'typescript');
  const watchers = [];
  let closed = false;
  let dirty = false;
  let timer;
  let running;

  function schedule() {
    if (closed) return;
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(rebuild, 100);
  }

  async function rebuild() {
    if (closed || running) return;
    running = (async () => {
      do {
        dirty = false;
        let status;
        try {
          const latest = {
            ...config,
            ...(await loadConfig({ cwd: config.cwd })),
          };
          if (closed) return;
          watchInputs(latest);
          status = await buildPackages(latest, () => closed);
        } catch (error) {
          console.error(error);
          status = 1;
        }
        if (!closed) onBuild(status);
      } while (dirty && !closed);
    })();
    try {
      await running;
    } finally {
      running = undefined;
    }
  }

  function watchInputs(latest) {
    const files = new Set([resolve(latest.cwd, 'tsc-multi.json')]);
    const directories = new Set();
    for (const project of latest.projects) {
      const file = resolve(latest.cwd, project);
      files.add(file);
      files.add(resolve(dirname(file), 'package.json'));
      const nativeTypes = resolve(dirname(file), 'native/index.d.ts');
      if (ts.sys.fileExists(nativeTypes)) files.add(nativeTypes);
      const parsed = ts.getParsedCommandLineOfConfigFile(
        file,
        {},
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic() {},
        },
      );
      for (const base of parsed?.options.configFile?.extendedSourceFiles ??
        []) {
        files.add(base);
      }
      directories.add(parsed?.options.rootDir ?? resolve(dirname(file), 'src'));
    }
    for (const watcher of watchers.splice(0)) watcher.close();
    for (const file of files) {
      watchers.push(ts.sys.watchFile(file, schedule, 250));
    }
    for (const directory of directories) {
      watchers.push(
        ts.sys.directoryExists(directory)
          ? watch(directory, { recursive: true }, schedule)
          : ts.sys.watchFile(directory, schedule, 250),
      );
    }
  }
  void rebuild();

  return {
    async close() {
      closed = true;
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      await running;
    },
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const config = await loadConfig({ cwd });
  if (process.argv.includes('--watch')) {
    const watcher = watchPackages(config);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, async () => {
        await watcher.close();
      });
    }
  } else {
    process.exitCode = await buildPackages(config);
  }
}
