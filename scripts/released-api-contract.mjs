#!/usr/bin/env node

import console from 'node:console';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  PUBLIC_PACKAGES,
  repoRoot,
  readJson,
  sortedUnique,
  loadPackageSet,
  inspectPackageSet,
  comparePackageSets,
  inspectAndComparePackageSets,
  assertAllTargetsExist,
  normalizeSelectedPublicTypeAliases,
  preservedSelectionPolicies,
  validateSelectedProperties,
  validateSelectedPublicTypeAliases,
} from './released-api-contract-surface.mjs';
import {
  execFile,
  cleanSubprocessEnv,
  validateRuntime,
  validatePublicSpecifiers,
  isSafeWithoutOptionalPeers,
  withAcquiredResources,
  materializePublished,
  installOptionalPeers,
  installFromRegistry,
} from './released-api-contract-execution.mjs';

// Preserve the helper imports used by existing internal consumers.
export {
  PUBLIC_PACKAGES,
  collectConditionTargets,
  collectExportLeaves,
  validateExportLeafConditions,
  validateExportTreeTerminals,
  collectRuntimeConditionSets,
  resolveConditionalTarget,
  validatePackageExportTarget,
  compareConditionTrees,
  isPublicDeclaration,
  isReadonlyDeclarations,
  isDirectObjectTypeAliasDeclaration,
  describeOwnedSymbol,
  normalizeSelectedPublicTypeAliases,
  preservedSelectionPolicies,
  selectDeclarationSurface,
  compareResolvedConditionSurfaces,
  compareOwnedDescriptors,
  compareSurfaceRecords,
  validateSelectedProperties,
  validateSelectedPublicTypeAliases,
  compareOptionalPeers,
} from './released-api-contract-surface.mjs';
export {
  compareRuntimeBindings,
  compareNamespaceBindingIdentity,
  compareConvenienceBindingIdentity,
  isUnsupportedOptionalPeerFormat,
  isSafeWithoutOptionalPeers,
  withAcquiredResources,
  installTarballs,
} from './released-api-contract-execution.mjs';

const defaultContractPath = path.join(
  repoRoot,
  'scripts/released-api-contract.json',
);

function workspaceRoots() {
  return Object.fromEntries(
    PUBLIC_PACKAGES.map(([name, directory]) => [
      name,
      path.join(repoRoot, 'packages', directory),
    ]),
  );
}

async function validateSource(contract) {
  const baseline = await materializePublished(
    contract.packages,
    'https://registry.npmjs.org',
  );
  try {
    const baselinePackages = await loadPackageSet(baseline.roots, 'dist');
    const selectedPublicTypeAliases = contract.selectedPublicTypeAliases ?? [];
    const baselineSurfaces = await inspectPackageSet(
      baselinePackages,
      'dist',
      selectedPublicTypeAliases,
    );
    const packages = await loadPackageSet(workspaceRoots(), 'source');
    const surfaces = await inspectPackageSet(
      packages,
      'source',
      selectedPublicTypeAliases,
    );
    const errors = comparePackageSets(
      contract,
      baselineSurfaces,
      packages,
      surfaces,
      false,
    );
    if (errors.length > 0) throw new Error(errors.join('\n'));
    console.log(
      `Released API source contract passed for ${countEntries(surfaces)} entry points.`,
    );
  } finally {
    await baseline.cleanup();
  }
}

async function validateDist(contract) {
  const baseline = await materializePublished(
    contract.packages,
    'https://registry.npmjs.org',
  );
  try {
    const baselinePackages = await loadPackageSet(baseline.roots, 'dist');
    const candidatePackages = await loadPackageSet(workspaceRoots(), 'dist');
    const { errors: comparisonErrors, candidateSurfaces } =
      await inspectAndComparePackageSets(
        contract,
        baselinePackages,
        candidatePackages,
      );
    const errors = [
      ...(await assertAllTargetsExist(candidatePackages)),
      ...comparisonErrors,
      ...(await validateRuntime(candidatePackages, candidateSurfaces)),
    ];
    if (errors.length > 0) throw new Error(sortedUnique(errors).join('\n'));
    console.log(
      `Released API dist contract passed for ${countEntries(candidateSurfaces)} entry points.`,
    );
  } finally {
    await baseline.cleanup();
  }
}

async function validatePackage(contract, registry) {
  await withAcquiredResources(
    [() => installFromRegistry(registry, false)],
    async ([noExtra]) => {
      const packages = await loadPackageSet(noExtra.roots, 'dist');
      const surfaces = await inspectPackageSet(
        packages,
        'dist',
        contract.selectedPublicTypeAliases ?? [],
      );
      const errors = [
        ...(await validateRuntime(
          packages,
          surfaces,
          isSafeWithoutOptionalPeers,
        )),
        ...(await validatePublicSpecifiers(
          packages,
          surfaces,
          noExtra.installRoot,
          isSafeWithoutOptionalPeers,
        )),
      ];
      if (errors.length > 0) throw new Error(errors.join('\n'));
    },
  );

  await withAcquiredResources(
    [
      () =>
        materializePublished(contract.packages, 'https://registry.npmjs.org'),
      () => installFromRegistry(registry, true),
    ],
    async ([baseline, allOptionals]) => {
      const baselinePackages = await loadPackageSet(baseline.roots, 'dist');
      const candidatePackages = await loadPackageSet(
        allOptionals.roots,
        'dist',
      );
      const { errors: comparisonErrors, candidateSurfaces } =
        await inspectAndComparePackageSets(
          contract,
          baselinePackages,
          candidatePackages,
        );
      const errors = [
        ...(await assertAllTargetsExist(candidatePackages)),
        ...comparisonErrors,
        ...(await validateRuntime(candidatePackages, candidateSurfaces)),
        ...(await validatePublicSpecifiers(
          candidatePackages,
          candidateSurfaces,
          allOptionals.installRoot,
        )),
      ];
      if (errors.length > 0) throw new Error(sortedUnique(errors).join('\n'));
      console.log(
        `Released API package contract passed for no-extra and all-optionals profiles (${countEntries(candidateSurfaces)} entry points).`,
      );
    },
  );
}

function countEntries(surfaces) {
  return Object.values(surfaces).reduce(
    (count, packageEntries) => count + Object.keys(packageEntries).length,
    0,
  );
}

async function promote(contract, version, contractPath) {
  const previousPackages = contract.packages ?? {};
  const packageSpec = Object.fromEntries(
    PUBLIC_PACKAGES.map(([name]) => [name, { version, integrity: undefined }]),
  );
  const hasPreviousBaseline = Object.keys(previousPackages).length > 0;
  return withAcquiredResources(
    [
      () => materializePublished(packageSpec, 'https://registry.npmjs.org'),
      ...(hasPreviousBaseline
        ? [
            () =>
              materializePublished(
                previousPackages,
                'https://registry.npmjs.org',
              ),
          ]
        : []),
    ],
    async ([released, baseline]) => {
      const packages = await loadPackageSet(released.roots, 'dist');
      let surfaces;
      const errors = [...(await assertAllTargetsExist(packages))];
      if (baseline) {
        const baselinePackages = await loadPackageSet(baseline.roots, 'dist');
        const { errors: comparisonErrors, candidateSurfaces } =
          await inspectAndComparePackageSets(
            contract,
            baselinePackages,
            packages,
          );
        surfaces = candidateSurfaces;
        errors.push(...comparisonErrors);
      } else {
        surfaces = await inspectPackageSet(
          packages,
          'dist',
          contract.selectedPublicTypeAliases ?? [],
        );
      }
      errors.push(
        ...(await validateRuntime(
          packages,
          surfaces,
          isSafeWithoutOptionalPeers,
        )),
        ...(await validatePublicSpecifiers(
          packages,
          surfaces,
          released.installRoot,
          isSafeWithoutOptionalPeers,
        )),
      );
      await installOptionalPeers(released, 'https://registry.npmjs.org');
      errors.push(...(await validateRuntime(packages, surfaces)));
      errors.push(
        ...(await validatePublicSpecifiers(
          packages,
          surfaces,
          released.installRoot,
        )),
      );
      errors.push(
        ...validateSelectedProperties(
          surfaces,
          contract.selectedPublicProperties ?? [],
        ),
        ...validateSelectedPublicTypeAliases(
          surfaces,
          contract.selectedPublicTypeAliases ?? [],
        ),
      );
      if (errors.length > 0) {
        throw new Error(
          `Refusing to promote an incompatible release:\n${sortedUnique(errors).join('\n')}`,
        );
      }

      const promotedPackages = {};
      for (const [name] of PUBLIC_PACKAGES) {
        const packageInfo = packages[name];
        promotedPackages[name] = {
          version,
          integrity: released.packed[name].integrity,
          exports: packageInfo.manifest.exports,
          optionalPeers: Object.keys(
            packageInfo.manifest.peerDependenciesMeta ?? {},
          )
            .filter(
              (peer) =>
                packageInfo.manifest.peerDependenciesMeta[peer].optional,
            )
            .sort(),
        };
      }
      let commit;
      try {
        commit = (
          await execFile('git', ['rev-parse', `v${version}^{commit}`], {
            cwd: repoRoot,
            env: cleanSubprocessEnv(),
          })
        ).stdout.trim();
      } catch {
        throw new Error(`Local tag v${version} is required before promotion`);
      }
      const promoted = {
        schemaVersion: 1,
        baseline: { tag: `v${version}`, commit },
        packages: promotedPackages,
        ...preservedSelectionPolicies(contract),
      };
      const temporary = `${contractPath}.tmp`;
      await writeFile(temporary, `${JSON.stringify(promoted, null, 2)}\n`);
      await rename(temporary, contractPath);
      console.log(`Promoted released API contract to v${version} (${commit}).`);
    },
  );
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const contractPath = path.resolve(
    argumentValue(args, '--contract') ?? defaultContractPath,
  );
  const contract = await readJson(contractPath);
  contract.selectedPublicTypeAliases = normalizeSelectedPublicTypeAliases(
    contract.selectedPublicTypeAliases,
  );
  if (command === 'source') {
    await validateSource(contract);
    return;
  }
  if (command === 'dist') {
    await validateDist(contract);
    return;
  }
  if (command === 'package') {
    await validatePackage(
      contract,
      argumentValue(args, '--registry') ?? 'http://localhost:4873',
    );
    return;
  }
  if (command === 'promote') {
    const version = argumentValue(args, '--version');
    if (!version) throw new Error('promote requires --version <version>');
    await promote(contract, version, contractPath);
    return;
  }
  throw new Error(
    'Usage: released-api-contract.mjs <source|dist|package|promote> [options]',
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
