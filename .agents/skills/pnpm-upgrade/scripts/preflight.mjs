#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { console, fetch, process } = globalThis;

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return process.argv[index + 1];
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'openai-agents-js-pnpm-upgrade-preflight' },
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${url}`);
  }
  return response.json();
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
        ),
      );
    });
  });
}

async function loadBootstrap(actionRef, options) {
  const lock = await fetchJson(
    `https://raw.githubusercontent.com/pnpm/action-setup/${actionRef}/src/install-pnpm/bootstrap/${options.lockFile}`,
  );
  const version = lock.packages?.[options.packageKey]?.version;
  if (!version) {
    throw new Error(
      `Could not resolve the ${options.label} bootstrap version from pnpm/action-setup@${actionRef}.`,
    );
  }
  return { ...options, lock, version };
}

async function runBootstrapProbe(bootstrap, targetVersion) {
  const workDir = await mkdtemp(
    path.join(tmpdir(), `pnpm-upgrade-preflight-${bootstrap.label}-`),
  );
  try {
    await writeFile(
      path.join(workDir, 'package.json'),
      `${JSON.stringify({ private: true, dependencies: { [bootstrap.packageName]: bootstrap.version } }, null, 2)}\n`,
    );
    await writeFile(
      path.join(workDir, 'package-lock.json'),
      `${JSON.stringify(bootstrap.lock, null, 2)}\n`,
    );
    await run('npm', ['ci'], {
      cwd: workDir,
      env: process.env,
      shell: process.platform === 'win32',
    });

    const pnpmHome =
      bootstrap.label === 'standalone' && process.platform === 'win32'
        ? path.join(workDir, 'node_modules', '@pnpm', 'exe')
        : path.join(workDir, 'node_modules', '.bin');
    const xdgDataHome = path.join(workDir, 'xdg-data');
    await mkdir(xdgDataHome, { recursive: true });
    const bootstrapPnpm =
      bootstrap.label === 'standalone'
        ? path.join(
            workDir,
            'node_modules',
            '@pnpm',
            'exe',
            process.platform === 'win32' ? 'pnpm.exe' : 'pnpm',
          )
        : path.join(workDir, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');
    const command =
      bootstrap.label === 'standalone' ? bootstrapPnpm : process.execPath;
    const args =
      bootstrap.label === 'standalone'
        ? ['self-update', targetVersion]
        : [bootstrapPnpm, 'self-update', targetVersion];
    await run(command, args, {
      cwd: workDir,
      env: {
        ...process.env,
        PNPM_HOME: pnpmHome,
        XDG_DATA_HOME: xdgDataHome,
      },
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  console.log(
    `Preflight passed for the ${bootstrap.label} pnpm/action-setup bootstrap ${bootstrap.version}.`,
  );
}

function assertDependencyFreeManifest(manifest, version) {
  const dependencies = Object.keys(manifest.dependencies ?? {});
  const devDependencies = Object.keys(manifest.devDependencies ?? {});
  if (dependencies.length === 0 && devDependencies.length === 0) return;

  const summarize = (names) =>
    names.length === 0
      ? 'none'
      : `${names.length}: ${names.slice(0, 10).join(', ')}${names.length > 10 ? ', ...' : ''}`;
  throw new Error(
    [
      `pnpm@${version} has an unexpected published manifest.`,
      `dependencies (${summarize(dependencies)})`,
      `devDependencies (${summarize(devDependencies)})`,
      'pnpm bundles its runtime dependencies; aborting before the pnpm/action-setup self-installer runs.',
    ].join('\n'),
  );
}

async function main() {
  const version = readArg('--version');
  const actionRef = readArg('--action-ref');
  if (!/^[0-9a-f]{40}$/.test(actionRef)) {
    throw new Error('--action-ref must be a 40-character commit SHA.');
  }

  const manifest = await fetchJson(
    `https://registry.npmjs.org/pnpm/${encodeURIComponent(version)}`,
  );
  if (manifest.version !== version) {
    throw new Error(
      `Registry returned pnpm@${manifest.version ?? 'unknown'} instead of pnpm@${version}.`,
    );
  }
  assertDependencyFreeManifest(manifest, version);

  const bootstraps = await Promise.all([
    loadBootstrap(actionRef, {
      label: 'regular',
      lockFile: 'pnpm-lock.json',
      packageKey: 'node_modules/pnpm',
      packageName: 'pnpm',
    }),
    loadBootstrap(actionRef, {
      label: 'standalone',
      lockFile: 'exe-lock.json',
      packageKey: 'node_modules/@pnpm/exe',
      packageName: '@pnpm/exe',
    }),
  ]);

  for (const bootstrap of bootstraps) {
    await runBootstrapProbe(bootstrap, version);
  }

  console.log(
    `Preflight passed: all pnpm/action-setup bootstrap paths can self-update to pnpm ${version}.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
