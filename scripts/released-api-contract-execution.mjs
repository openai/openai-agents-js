// Package acquisition and runtime probes. Importing this module performs no installs or probes.
import { execFile as execFileCallback } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import {
  PUBLIC_PACKAGES,
  repoRoot,
  readJson,
  sortedUnique,
  packageKey,
  collectConditionTargets,
  collectRuntimeConditionSets,
  resolveConditionalTarget,
  primarySurface,
  selectDeclarationSurface,
} from './released-api-contract-surface.mjs';

export const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);

const CONVENIENCE_IDENTITY_PAIRS = [
  {
    bundle: '@openai/agents',
    bundleLabel: '@openai/agents',
    owner: '@openai/agents-core',
    ownerLabel: '@openai/agents-core',
  },
  {
    bundle: '@openai/agents',
    bundleLabel: '@openai/agents',
    owner: '@openai/agents-openai',
    ownerLabel: '@openai/agents-openai',
  },
  {
    bundle: '@openai/agents/sandbox',
    bundleLabel: '@openai/agents/sandbox',
    owner: '@openai/agents-core/sandbox',
    ownerLabel: '@openai/agents-core',
  },
  {
    bundle: '@openai/agents/sandbox/local',
    bundleLabel: '@openai/agents/sandbox/local',
    owner: '@openai/agents-core/sandbox/local',
    ownerLabel: '@openai/agents-core',
  },
  {
    bundle: '@openai/agents/utils',
    bundleLabel: '@openai/agents/utils',
    owner: '@openai/agents-core/utils',
    ownerLabel: '@openai/agents-core',
  },
  {
    bundle: '@openai/agents/realtime',
    bundleLabel: '@openai/agents/realtime',
    owner: '@openai/agents-realtime',
    ownerLabel: '@openai/agents-realtime',
  },
  {
    bundle: '@openai/agents',
    bundleProperty: 'realtime',
    bundleLabel: '@openai/agents.realtime',
    owner: '@openai/agents-realtime',
    ownerLabel: '@openai/agents-realtime',
    requireOwnerSurface: true,
  },
];

const OPTIONAL_PEER_FORMAT_EXCEPTIONS = new Map([
  ['@openai/agents-extensions/experimental/codex', '@openai/codex-sdk'],
]);

export function cleanSubprocessEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_CI;
  delete env.CODEX_THREAD_ID;
  return env;
}

export function compareRuntimeBindings(
  expectedRecords,
  loadedModule,
  location,
) {
  const errors = [];
  for (const record of expectedRecords) {
    const runtimeKind = !['interface', 'type'].includes(record.kind);
    if (
      record.spaces.includes('value') &&
      runtimeKind &&
      !(record.name in loadedModule)
    ) {
      errors.push(`${location}.${record.name} has no runtime binding`);
      continue;
    }
    if (record.namespaceMembers && record.name in loadedModule) {
      const namespace = loadedModule[record.name];
      for (const member of record.namespaceMembers) {
        if (
          member.spaces.includes('value') &&
          (!namespace || !(member.name in namespace))
        ) {
          errors.push(
            `${location}.${record.name}.${member.name} has no runtime binding`,
          );
        }
      }
    }
  }
  return errors;
}

export function compareNamespaceBindingIdentity(
  namespace,
  owner,
  location,
  ownerName,
  format,
) {
  const errors = [];
  if (!namespace || !owner) return errors;
  for (const exportedName of Object.keys(owner)) {
    if (!(exportedName in namespace)) {
      errors.push(`${location}.${exportedName} is missing in ${format}`);
    } else if (namespace[exportedName] !== owner[exportedName]) {
      errors.push(
        `${location}.${exportedName} is not the ${ownerName} runtime binding in ${format}`,
      );
    }
  }
  return errors;
}

export function compareConvenienceBindingIdentity(
  loadedModules,
  identityPairs,
  format,
  conditionLabel = '',
) {
  const errors = [];
  for (const pair of identityPairs) {
    const bundleModule = loadedModules[pair.bundle];
    const bundle = pair.bundleProperty
      ? bundleModule?.[pair.bundleProperty]
      : bundleModule;
    const owner = loadedModules[pair.owner];
    if (!bundle || !owner) continue;
    const exportedNames = pair.requireOwnerSurface
      ? Object.keys(owner)
      : Object.keys(bundle).filter((name) => name in owner);
    for (const exportedName of exportedNames) {
      if (!(exportedName in bundle)) {
        errors.push(
          `${pair.bundleLabel}.${exportedName} is missing in ${format}${conditionLabel}`,
        );
      } else if (bundle[exportedName] !== owner[exportedName]) {
        errors.push(
          `${pair.bundleLabel}.${exportedName} is not the ${pair.ownerLabel} runtime binding in ${format}${conditionLabel}`,
        );
      }
    }
  }
  return errors;
}

async function loadRuntimeTarget(packageRoot, target, format) {
  const absolute = path.join(packageRoot, target);
  if (format === 'import') {
    return import(pathToFileURL(absolute).href);
  }
  return require(absolute);
}

export function isUnsupportedOptionalPeerFormat(
  error,
  packageManifest,
  format,
  specifier,
) {
  if (format !== 'require' || error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
    return false;
  }
  const peer = OPTIONAL_PEER_FORMAT_EXCEPTIONS.get(specifier);
  if (
    !peer ||
    packageManifest.peerDependenciesMeta?.[peer]?.optional !== true
  ) {
    return false;
  }
  const message = error.message ?? error.error ?? '';
  return (
    message.includes(`/node_modules/${peer}/package.json`) &&
    message.includes('No "exports" main defined')
  );
}

async function loadPublicSpecifiers(
  installRoot,
  specifiers,
  format,
  conditions = [],
) {
  const describeLoaded = `const describeLoaded = (loaded) => {
  const keys = Object.keys(loaded);
  const namespaceKeys = {};
  for (const key of keys) {
    const value = loaded[key];
    if (value && (typeof value === 'object' || typeof value === 'function')) {
      namespaceKeys[key] = Object.keys(value);
    }
  }
  return { keys, namespaceKeys };
};`;
  const identityComparison = `const compareConvenienceBindingIdentity = ${compareConvenienceBindingIdentity.toString()};`;
  const loader = `${describeLoaded}\n${identityComparison}\n${
    format === 'import'
      ? `const result = {};
const loadedModules = {};
for (const specifier of JSON.parse(process.argv[1])) {
  try {
    const loaded = await import(specifier);
    loadedModules[specifier] = loaded;
    result[specifier] = describeLoaded(loaded);
  } catch (error) {
    result[specifier] = { error: error.message, code: error.code };
  }
}
console.log(JSON.stringify({
  results: result,
  identityErrors: compareConvenienceBindingIdentity(
    loadedModules,
    JSON.parse(process.argv[2]),
    process.argv[3],
    process.argv[4],
  ),
}));`
      : `const result = {};
const loadedModules = {};
for (const specifier of JSON.parse(process.argv[1])) {
  try {
    const loaded = require(specifier);
    loadedModules[specifier] = loaded;
    result[specifier] = describeLoaded(loaded);
  } catch (error) {
    result[specifier] = { error: error.message, code: error.code };
  }
}
console.log(JSON.stringify({
  results: result,
  identityErrors: compareConvenienceBindingIdentity(
    loadedModules,
    JSON.parse(process.argv[2]),
    process.argv[3],
    process.argv[4],
  ),
}));`
  }`;
  const conditionLabel =
    conditions.length > 0 ? ` conditions ${conditions.join(',')}` : '';
  const args = [
    ...conditions.map((condition) => `--conditions=${condition}`),
    ...(format === 'import' ? ['--input-type=module'] : []),
    '--eval',
    loader,
    JSON.stringify(specifiers),
    JSON.stringify(CONVENIENCE_IDENTITY_PAIRS),
    format,
    conditionLabel,
  ];
  const { stdout } = await execFile(process.execPath, args, {
    cwd: installRoot,
    env: cleanSubprocessEnv(),
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

export async function validatePublicSpecifiers(
  packages,
  surfaces,
  installRoot,
  entryFilter = () => true,
) {
  const entriesBySpecifier = new Map();
  for (const [name, packageInfo] of Object.entries(packages)) {
    for (const subpath of Object.keys(packageInfo.entries)) {
      if (!entryFilter(name, subpath)) continue;
      entriesBySpecifier.set(packageKey(name, subpath), {
        exportNode: packageInfo.entries[subpath].exportNode,
        variants: surfaces[name]?.[subpath],
      });
    }
  }
  const specifiers = [...entriesBySpecifier.keys()];
  const errors = [];
  const exportNodes = Object.values(packages).flatMap((packageInfo) =>
    Object.values(packageInfo.entries).map((entry) => entry.exportNode),
  );
  const conditionSets = [[], ...collectRuntimeConditionSets(exportNodes)];
  for (const conditions of conditionSets) {
    for (const format of ['import', 'require']) {
      const results = await loadPublicSpecifiers(
        installRoot,
        specifiers,
        format,
        conditions,
      );
      errors.push(...results.identityErrors);
      for (const specifier of specifiers) {
        const result = results.results[specifier];
        const conditionLabel =
          conditions.length > 0 ? ` conditions ${conditions.join(',')}` : '';
        if (!result || result.error) {
          const packageName = PUBLIC_PACKAGES.find(
            ([name]) => specifier === name || specifier.startsWith(`${name}/`),
          )?.[0];
          if (
            packageName &&
            isUnsupportedOptionalPeerFormat(
              result,
              packages[packageName].manifest,
              format,
              specifier,
            )
          ) {
            continue;
          }
          errors.push(
            `${specifier} ${format} public specifier${conditionLabel} failed to load: ${result?.error ?? 'no result'}`,
          );
          continue;
        }
        const entry = entriesBySpecifier.get(specifier);
        const resolved = resolveConditionalTarget(
          entry.exportNode,
          format,
          conditions,
        );
        if (!resolved) {
          errors.push(
            `${specifier} ${format} public specifier${conditionLabel} has no matching runtime target`,
          );
          continue;
        }
        const loaded = Object.fromEntries(
          result.keys.map((key) => [
            key,
            Object.fromEntries(
              (result.namespaceKeys?.[key] ?? []).map((member) => [
                member,
                true,
              ]),
            ),
          ]),
        );
        errors.push(
          ...compareRuntimeBindings(
            selectDeclarationSurface(
              entry.variants,
              resolved.condition,
              format,
            ),
            loaded,
            `${specifier} ${format} public specifier${conditionLabel}`,
          ),
        );
      }
    }
  }
  return errors;
}

export async function validateRuntime(
  packages,
  surfaces,
  entryFilter = () => true,
) {
  const errors = [];
  for (const [name, packageInfo] of Object.entries(packages)) {
    for (const [subpath, entry] of Object.entries(packageInfo.entries)) {
      if (!entryFilter(name, subpath)) continue;
      for (const format of ['import', 'require']) {
        for (const { condition, target } of collectConditionTargets(
          entry.exportNode,
          format,
        )) {
          const typeCondition = condition.replace(
            new RegExp(`${format}$`, 'u'),
            'types',
          );
          const expected =
            surfaces[name]?.[subpath]?.[typeCondition] ??
            primarySurface(surfaces[name]?.[subpath]);
          try {
            const loaded = await loadRuntimeTarget(
              packageInfo.packageRoot,
              target,
              format,
            );
            errors.push(
              ...compareRuntimeBindings(
                expected,
                loaded,
                `${packageKey(name, subpath)} ${format}`,
              ),
            );
          } catch (error) {
            if (
              isUnsupportedOptionalPeerFormat(
                error,
                packageInfo.manifest,
                format,
                packageKey(name, subpath),
              )
            ) {
              continue;
            }
            errors.push(
              `${packageKey(name, subpath)} ${format} target ${target} failed to load: ${error.message}`,
            );
          }
        }
      }
    }
  }

  return sortedUnique(errors);
}

export function isSafeWithoutOptionalPeers(name, subpath) {
  return name !== '@openai/agents-extensions' || subpath === '.';
}

async function runNpm(args, cwd) {
  const result = await execFile('npm', args, {
    cwd,
    env: cleanSubprocessEnv(),
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout;
}

async function removeDirectories(...directories) {
  const results = await Promise.allSettled(
    directories
      .filter(Boolean)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}

export async function withAcquiredResources(acquirers, operation) {
  const resources = [];
  let result;
  let operationError;
  try {
    for (const acquire of acquirers) {
      resources.push(await acquire());
    }
    result = await operation(resources);
  } catch (error) {
    operationError = error;
  }
  const cleanupResults = await Promise.allSettled(
    [...resources].reverse().map((resource) => resource.cleanup()),
  );
  if (operationError) throw operationError;
  const cleanupFailure = cleanupResults.find(
    (cleanup) => cleanup.status === 'rejected',
  );
  if (cleanupFailure) throw cleanupFailure.reason;
  return result;
}

async function packPublishedPackage(
  name,
  version,
  registry,
  expectedIntegrity,
  packDirectory,
) {
  const stdout = await runNpm(
    [
      'pack',
      `${name}@${version}`,
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      packDirectory,
      '--registry',
      registry,
    ],
    packDirectory,
  );
  const [packed] = JSON.parse(stdout);
  if (!packed?.filename || !packed?.integrity) {
    throw new Error(
      `npm pack returned no artifact metadata for ${name}@${version}`,
    );
  }
  if (expectedIntegrity && packed.integrity !== expectedIntegrity) {
    throw new Error(
      `${name}@${version} integrity changed: expected ${expectedIntegrity}, received ${packed.integrity}`,
    );
  }
  return {
    file: path.join(packDirectory, packed.filename),
    integrity: packed.integrity,
  };
}

export async function installTarballs(
  packageRecords,
  registry,
  install = runNpm,
) {
  const installRoot = await mkdtemp(
    path.join(tmpdir(), 'agents-api-contract-install-'),
  );
  try {
    const dependencies = Object.fromEntries(
      Object.entries(packageRecords).map(([name, record]) => [
        name,
        `file:${record.file}`,
      ]),
    );
    dependencies.zod = '^4.0.0';
    await writeFile(
      path.join(installRoot, 'package.json'),
      `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`,
    );
    await install(
      [
        'install',
        '--ignore-scripts',
        '--no-package-lock',
        '--omit=optional',
        '--registry',
        registry,
      ],
      installRoot,
    );
    return installRoot;
  } catch (error) {
    await rm(installRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function materializePublished(contractPackages, registry) {
  const packDirectory = await mkdtemp(
    path.join(tmpdir(), 'agents-api-contract-pack-'),
  );
  const packed = {};
  try {
    for (const [name] of PUBLIC_PACKAGES) {
      const baseline = contractPackages[name];
      packed[name] = await packPublishedPackage(
        name,
        baseline.version,
        registry,
        baseline.integrity,
        packDirectory,
      );
    }
    const installRoot = await installTarballs(packed, registry);
    const roots = Object.fromEntries(
      PUBLIC_PACKAGES.map(([name]) => [
        name,
        path.join(installRoot, 'node_modules', name),
      ]),
    );
    return {
      installRoot,
      roots,
      packed,
      async cleanup() {
        await removeDirectories(installRoot, packDirectory);
      },
    };
  } catch (error) {
    await rm(packDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function installOptionalPeers(materialized, registry) {
  const extensionManifest = await readJson(
    path.join(materialized.roots['@openai/agents-extensions'], 'package.json'),
  );
  const optionalSpecs = Object.entries(
    extensionManifest.peerDependenciesMeta ?? {},
  )
    .filter(([, metadata]) => metadata.optional)
    .map(([name]) => `${name}@${extensionManifest.peerDependencies[name]}`);
  if (optionalSpecs.length === 0) return;
  await runNpm(
    [
      'install',
      '--ignore-scripts',
      '--no-package-lock',
      '--no-save',
      ...optionalSpecs,
      '--registry',
      registry,
    ],
    materialized.installRoot,
  );
}

export async function installFromRegistry(registry, allOptionals) {
  const installRoot = await mkdtemp(
    path.join(tmpdir(), 'agents-api-contract-registry-'),
  );
  let packDirectory;
  const dependencies = {};
  try {
    packDirectory = await mkdtemp(
      path.join(tmpdir(), 'agents-api-contract-registry-pack-'),
    );
    for (const [name, directory] of PUBLIC_PACKAGES) {
      const manifest = await readJson(
        path.join(repoRoot, 'packages', directory, 'package.json'),
      );
      const packed = await packPublishedPackage(
        name,
        manifest.version,
        registry,
        undefined,
        packDirectory,
      );
      dependencies[name] = `file:${packed.file}`;
    }
    dependencies.zod = '^4.0.0';
    if (allOptionals) {
      const extensionManifest = await readJson(
        path.join(repoRoot, 'packages/agents-extensions/package.json'),
      );
      for (const [name, metadata] of Object.entries(
        extensionManifest.peerDependenciesMeta ?? {},
      )) {
        if (metadata.optional) {
          dependencies[name] = extensionManifest.peerDependencies[name];
        }
      }
    }
    await writeFile(
      path.join(installRoot, 'package.json'),
      `${JSON.stringify({ private: true, type: 'module', dependencies }, null, 2)}\n`,
    );
    await runNpm(
      [
        'install',
        '--ignore-scripts',
        '--no-package-lock',
        '--registry',
        'https://registry.npmjs.org',
      ],
      installRoot,
    );
    return {
      installRoot,
      roots: Object.fromEntries(
        PUBLIC_PACKAGES.map(([name]) => [
          name,
          path.join(installRoot, 'node_modules', name),
        ]),
      ),
      async cleanup() {
        await removeDirectories(installRoot, packDirectory);
      },
    };
  } catch (error) {
    await removeDirectories(installRoot, packDirectory);
    throw error;
  }
}
