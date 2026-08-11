#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import console from 'node:console';
import { createRequire } from 'node:module';
import {
  access,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);

export const PUBLIC_PACKAGES = [
  ['@openai/agents-core', 'agents-core'],
  ['@openai/agents-openai', 'agents-openai'],
  ['@openai/agents-realtime', 'agents-realtime'],
  ['@openai/agents-extensions', 'agents-extensions'],
  ['@openai/agents', 'agents'],
];

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const defaultContractPath = path.join(
  repoRoot,
  'tests/fixtures/released-api-contract.json',
);
const typeFormatFlags =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

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

function cleanSubprocessEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_CI;
  delete env.CODEX_THREAD_ID;
  return env;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function pathExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function packageKey(name, subpath) {
  return `${name}${subpath === '.' ? '' : subpath.slice(1)}`;
}

export function collectConditionTargets(
  node,
  condition,
  conditions = [],
  targets = [],
) {
  if (typeof node === 'string') {
    return targets;
  }
  if (!node || typeof node !== 'object') {
    return targets;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === condition && typeof value === 'string') {
      targets.push({
        condition: [...conditions, key].join('.'),
        target: value,
      });
    } else {
      collectConditionTargets(value, condition, [...conditions, key], targets);
    }
  }
  return targets.filter(
    (entry, index) =>
      targets.findIndex(
        (candidate) =>
          candidate.condition === entry.condition &&
          candidate.target === entry.target,
      ) === index,
  );
}

export function collectExportLeaves(node, conditions = [], leaves = []) {
  if (typeof node === 'string') {
    leaves.push({
      condition: conditions.join('.'),
      target: node,
    });
    return leaves;
  }
  if (!node || typeof node !== 'object') {
    return leaves;
  }
  for (const [key, value] of Object.entries(node)) {
    collectExportLeaves(value, [...conditions, key], leaves);
  }
  return leaves;
}

export function validateExportLeafConditions(exportNode, location) {
  const errors = validateExportTreeTerminals(exportNode, location);
  for (const { target } of collectExportLeaves(exportNode)) {
    const targetError = validatePackageExportTarget(target);
    if (targetError) {
      errors.push(
        `${location} has invalid package export target ${target}: ${targetError}`,
      );
    }
  }
  return errors;
}

export function validateExportTreeTerminals(
  node,
  location,
  conditions = [],
  errors = [],
) {
  if (typeof node === 'string') {
    return errors;
  }
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    const condition = conditions.join('.') || '<direct>';
    const kind =
      node === null ? 'null' : Array.isArray(node) ? 'array' : typeof node;
    errors.push(
      `${location} condition ${condition} has unsupported ${kind} export target`,
    );
    return errors;
  }
  for (const [condition, value] of Object.entries(node)) {
    validateExportTreeTerminals(
      value,
      location,
      [...conditions, condition],
      errors,
    );
  }
  return errors;
}

export function collectRuntimeConditionSets(exportNodes) {
  const builtInConditions = new Set([
    'types',
    'import',
    'require',
    'default',
    'node',
    'node-addons',
  ]);
  const conditionSets = new Map();
  for (const exportNode of exportNodes) {
    for (const { condition } of collectExportLeaves(exportNode)) {
      const customConditions = condition
        .split('.')
        .filter((item) => item && !builtInConditions.has(item));
      if (customConditions.length > 0) {
        conditionSets.set(customConditions.join('\0'), customConditions);
      }
    }
  }
  return [...conditionSets.values()].sort((left, right) =>
    left.join('.').localeCompare(right.join('.')),
  );
}

export function resolveConditionalTarget(
  node,
  format,
  customConditions = [],
  conditions = [],
) {
  if (typeof node === 'string') {
    return { condition: conditions.join('.'), target: node };
  }
  if (!node || typeof node !== 'object') {
    return null;
  }
  const activeConditions = new Set([
    ...customConditions,
    'default',
    'node',
    'node-addons',
    format,
  ]);
  for (const [condition, value] of Object.entries(node)) {
    if (condition === 'types' || !activeConditions.has(condition)) {
      continue;
    }
    const resolved = resolveConditionalTarget(value, format, customConditions, [
      ...conditions,
      condition,
    ]);
    if (resolved) return resolved;
  }
  return null;
}

export function validatePackageExportTarget(target) {
  if (!target.startsWith('./')) {
    return 'target must start with ./';
  }
  if (target.includes('\\')) {
    return 'backslashes are not allowed';
  }
  for (const rawSegment of target.slice(2).split('/')) {
    let segment;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return 'target contains malformed percent encoding';
    }
    if (segment.includes('/') || segment.includes('\\')) {
      return 'encoded path separators are not allowed';
    }
    const normalized = segment.toLowerCase();
    if (
      normalized === '.' ||
      normalized === '..' ||
      normalized === 'node_modules'
    ) {
      return `segment ${rawSegment} is not allowed`;
    }
  }
  return null;
}

function collectTargets(node, condition) {
  return sortedUnique(
    collectConditionTargets(node, condition).map((entry) => entry.target),
  );
}

export function compareConditionTrees(
  baseline,
  candidate,
  location = 'exports',
) {
  const errors = [];
  if (typeof baseline === 'string') {
    if (typeof candidate === 'string') {
      return errors;
    }
    if (
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      'default' in candidate
    ) {
      return compareConditionTrees(
        baseline,
        candidate.default,
        `${location}.default`,
      );
    }
    errors.push(`${location} no longer resolves to a file target`);
    return errors;
  }
  if (!baseline || typeof baseline !== 'object') {
    return errors;
  }
  if (!candidate || typeof candidate !== 'object') {
    return [`${location} no longer has released export conditions`];
  }
  const baselineConditions = Object.keys(baseline);
  const candidateReleasedConditions = Object.keys(candidate).filter(
    (condition) => condition in baseline,
  );
  if (
    candidateReleasedConditions.length === baselineConditions.length &&
    candidateReleasedConditions.join('\0') !== baselineConditions.join('\0')
  ) {
    errors.push(`${location} changed released condition precedence`);
  }
  for (const [condition, baselineValue] of Object.entries(baseline)) {
    if (!(condition in candidate)) {
      errors.push(`${location}.${condition} was removed`);
      continue;
    }
    errors.push(
      ...compareConditionTrees(
        baselineValue,
        candidate[condition],
        `${location}.${condition}`,
      ),
    );
  }
  return errors;
}

function symbolIsTypeOnly(symbol) {
  return (symbol.declarations ?? []).some((declaration) => {
    if (ts.isExportSpecifier(declaration)) {
      return (
        declaration.isTypeOnly ||
        (ts.isNamedExports(declaration.parent) &&
          ts.isExportDeclaration(declaration.parent.parent) &&
          declaration.parent.parent.isTypeOnly)
      );
    }
    return ts.isExportDeclaration(declaration) && declaration.isTypeOnly;
  });
}

function resolveAliasedSymbol(checker, symbol) {
  if (!(symbol.flags & ts.SymbolFlags.Alias)) {
    return symbol;
  }
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}

function symbolSpaces(exportSymbol, targetSymbol) {
  if (symbolIsTypeOnly(exportSymbol)) {
    return ['type'];
  }
  const spaces = [];
  if (targetSymbol.flags & ts.SymbolFlags.Type) {
    spaces.push('type');
  }
  if (targetSymbol.flags & (ts.SymbolFlags.Value | ts.SymbolFlags.Namespace)) {
    spaces.push('value');
  }
  return spaces;
}

function symbolKind(symbol) {
  if (symbol.flags & ts.SymbolFlags.Class) return 'class';
  if (symbol.flags & ts.SymbolFlags.Function) return 'function';
  if (symbol.flags & ts.SymbolFlags.Enum) return 'enum';
  if (symbol.flags & ts.SymbolFlags.Interface) return 'interface';
  if (symbol.flags & ts.SymbolFlags.TypeAlias) return 'type';
  if (symbol.flags & ts.SymbolFlags.Variable) return 'variable';
  if (symbol.flags & ts.SymbolFlags.Namespace) return 'namespace';
  return 'other';
}

export function isPublicDeclaration(declaration) {
  if (declaration?.name && ts.isPrivateIdentifier(declaration.name)) {
    return false;
  }
  if (!declaration || !ts.canHaveModifiers(declaration)) {
    return true;
  }
  const modifiers = ts.getModifiers(declaration) ?? [];
  return !modifiers.some(
    (modifier) =>
      modifier.kind === ts.SyntaxKind.PrivateKeyword ||
      modifier.kind === ts.SyntaxKind.ProtectedKeyword,
  );
}

export function isReadonlyDeclarations(declarations = []) {
  const hasReadonlyModifier = declarations.some(
    (declaration) =>
      ts.canHaveModifiers(declaration) &&
      (ts.getModifiers(declaration) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
      ),
  );
  if (hasReadonlyModifier) return true;
  const hasGetter = declarations.some((declaration) =>
    ts.isGetAccessorDeclaration(declaration),
  );
  const hasSetter = declarations.some((declaration) =>
    ts.isSetAccessorDeclaration(declaration),
  );
  return hasGetter && !hasSetter;
}

function canonicalType(checker, type, node) {
  return checker
    .typeToString(type, node, typeFormatFlags)
    .replace(/import\("[^"\n]*node_modules\/(@?[^"\n]+?)"\)/g, 'import("$1")')
    .replace(/\s+/g, ' ')
    .trim();
}

function describeMembers(checker, type, excludedNames = new Set()) {
  const members = [];
  for (const member of checker.getPropertiesOfType(type)) {
    if (excludedNames.has(member.getName())) {
      continue;
    }
    const declaration = member.valueDeclaration ?? member.declarations?.[0];
    if (
      (member.declarations ?? []).some(
        (item) => ts.isMethodDeclaration(item) || ts.isMethodSignature(item),
      )
    ) {
      continue;
    }
    if (!isPublicDeclaration(declaration)) {
      continue;
    }
    const memberType = checker.getTypeOfSymbolAtLocation(
      member,
      declaration ?? type.symbol?.valueDeclaration,
    );
    const callable =
      checker.getSignaturesOfType(memberType, ts.SignatureKind.Call).length > 0;
    const memberName =
      declaration?.name && ts.isComputedPropertyName(declaration.name)
        ? `[${declaration.name.expression.getText()}]`
        : member.getName();
    members.push({
      name: memberName,
      optional: Boolean(member.flags & ts.SymbolFlags.Optional),
      readonly: isReadonlyDeclarations(member.declarations),
      callable,
    });
  }
  return members.sort((left, right) => left.name.localeCompare(right.name));
}

function describeMethodNames(checker, type) {
  return checker
    .getPropertiesOfType(type)
    .filter((member) =>
      (member.declarations ?? []).some(
        (declaration) =>
          (ts.isMethodDeclaration(declaration) ||
            ts.isMethodSignature(declaration)) &&
          isPublicDeclaration(declaration),
      ),
    )
    .map((member) => member.getName())
    .sort();
}

function enumMembers(checker, symbol) {
  const type = checker.getDeclaredTypeOfSymbol(symbol);
  return checker.getPropertiesOfType(type).map((member) => {
    const declaration = member.valueDeclaration ?? member.declarations?.[0];
    const value =
      declaration && ts.isEnumMember(declaration)
        ? checker.getConstantValue(declaration)
        : undefined;
    return { name: member.getName(), value: value ?? member.getName() };
  });
}

function namespaceMembers(checker, symbol) {
  return checker
    .getExportsOfModule(symbol)
    .map((exportSymbol) => {
      const targetSymbol = resolveAliasedSymbol(checker, exportSymbol);
      return {
        name: exportSymbol.getName(),
        spaces: symbolSpaces(exportSymbol, targetSymbol),
      };
    })
    .filter((member) => member.spaces.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function isDirectObjectTypeAliasDeclaration(declaration) {
  return (
    Boolean(declaration) &&
    ts.isTypeAliasDeclaration(declaration) &&
    ts.isTypeLiteralNode(declaration.type)
  );
}

function isPubliclyConstructibleClass(declaration) {
  if (!declaration || !ts.isClassLike(declaration)) return false;
  const modifiers = ts.canHaveModifiers(declaration)
    ? (ts.getModifiers(declaration) ?? [])
    : [];
  if (
    modifiers.some(
      (modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword,
    )
  ) {
    return false;
  }
  const constructors = declaration.members.filter((member) =>
    ts.isConstructorDeclaration(member),
  );
  return constructors.length === 0 || constructors.some(isPublicDeclaration);
}

function isUnitLiteralType(type) {
  return Boolean(
    type.isLiteral() ||
    type.flags &
      (ts.TypeFlags.BooleanLiteral |
        ts.TypeFlags.Null |
        ts.TypeFlags.Undefined),
  );
}

export function describeOwnedSymbol(checker, symbol, kind) {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (kind === 'enum') {
    return { enumMembers: enumMembers(checker, symbol) };
  }
  if (kind === 'function') {
    return {};
  }
  if (kind === 'class') {
    const valueType = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    const declaredType = checker.getDeclaredTypeOfSymbol(symbol);
    return {
      constructible: isPubliclyConstructibleClass(declaration),
      members: describeMembers(checker, declaredType),
      methodNames: describeMethodNames(checker, declaredType),
      staticMembers: describeMembers(
        checker,
        valueType,
        new Set(['prototype']),
      ),
    };
  }
  if (kind === 'interface') {
    const declaredType = checker.getDeclaredTypeOfSymbol(symbol);
    return {
      members: describeMembers(checker, declaredType),
      methodNames: describeMethodNames(checker, declaredType),
    };
  }
  if (kind === 'type') {
    const type = checker.getDeclaredTypeOfSymbol(symbol);
    const literalTypes = type.isUnion() ? type.types : [type];
    if (literalTypes.every(isUnitLiteralType)) {
      return {
        literals: literalTypes
          .map((item) => canonicalType(checker, item, declaration))
          .sort(),
      };
    }
    if (!isDirectObjectTypeAliasDeclaration(declaration)) {
      return {};
    }
    const members = describeMembers(checker, type);
    if (members.length > 0 || type.flags & ts.TypeFlags.Object) {
      return {
        members,
        methodNames: describeMethodNames(checker, type),
      };
    }
    return {};
  }
  if (kind === 'namespace') {
    return { namespaceMembers: namespaceMembers(checker, symbol) };
  }
  if (kind === 'variable') {
    return {};
  }
  return {};
}

function symbolOwnedByRoots(symbol, ownedRoots) {
  return (symbol.declarations ?? []).some((declaration) => {
    const file = path.resolve(declaration.getSourceFile().fileName);
    return ownedRoots.some((root) =>
      file.startsWith(`${path.resolve(root)}${path.sep}`),
    );
  });
}

function createProgram(rootNames, sourceMode = false) {
  const paths = sourceMode
    ? Object.fromEntries(
        PUBLIC_PACKAGES.flatMap(([name, directory]) => [
          [name, [`packages/${directory}/src/index.ts`]],
          [`${name}/*`, [`packages/${directory}/src/*`]],
        ]),
      )
    : undefined;
  if (paths) {
    paths['@openai/agents-core/_shims'] = [
      'packages/agents-core/src/shims/shims-node.ts',
    ];
    paths['@openai/agents-core/_shims/config'] = [
      'packages/agents-core/src/shims/config-node.ts',
    ];
    paths['@openai/agents-realtime/_shims'] = [
      'packages/agents-realtime/src/shims/shims-node.ts',
    ];
  }
  return ts.createProgram({
    rootNames,
    options: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      baseUrl: repoRoot,
      paths,
    },
  });
}

function inspectEntry(program, entryFile, ownedRoots) {
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(path.resolve(entryFile));
  if (!sourceFile) {
    throw new Error(`TypeScript did not load entry point ${entryFile}`);
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    throw new Error(`TypeScript found no module symbol for ${entryFile}`);
  }
  const records = [];
  for (const exportSymbol of checker.getExportsOfModule(moduleSymbol)) {
    const targetSymbol = resolveAliasedSymbol(checker, exportSymbol);
    const spaces = symbolSpaces(exportSymbol, targetSymbol);
    if (spaces.length === 0) {
      continue;
    }
    const sdkOwned = symbolOwnedByRoots(targetSymbol, ownedRoots);
    const kind = symbolKind(targetSymbol);
    const record = {
      name: exportSymbol.getName(),
      spaces,
      sdkOwned,
      ...(sdkOwned
        ? {
            kind,
            ...describeOwnedSymbol(checker, targetSymbol, kind),
          }
        : {}),
    };
    records.push(record);
  }
  return records.sort((left, right) => left.name.localeCompare(right.name));
}

function sourceTarget(packageRoot, declarationTarget) {
  return path.join(
    packageRoot,
    declarationTarget.replace(/^\.\/dist\//, 'src/').replace(/\.d\.ts$/, '.ts'),
  );
}

async function loadPackageSet(roots, mode) {
  const packages = {};
  for (const [name] of PUBLIC_PACKAGES) {
    const packageRoot = roots[name];
    const manifest = await readJson(path.join(packageRoot, 'package.json'));
    const entries = {};
    for (const [subpath, exportNode] of Object.entries(
      manifest.exports ?? {},
    )) {
      const declarationTargets = collectConditionTargets(exportNode, 'types');
      if (declarationTargets.length === 0) {
        throw new Error(
          `${packageKey(name, subpath)} has no types export target`,
        );
      }
      entries[subpath] = {
        exportNode,
        declarations: declarationTargets.map(({ condition, target }) => ({
          condition,
          target,
          entryFile:
            mode === 'source'
              ? sourceTarget(packageRoot, target)
              : path.join(packageRoot, target),
        })),
      };
    }
    packages[name] = { manifest, packageRoot, entries };
  }
  return packages;
}

async function inspectPackageSet(packages, mode) {
  const roots = Object.values(packages).map((item) => item.packageRoot);
  const entryFiles = Object.values(packages).flatMap((item) =>
    Object.values(item.entries).flatMap((entry) =>
      entry.declarations.map((declaration) => declaration.entryFile),
    ),
  );
  for (const file of entryFiles) {
    if (!(await pathExists(file))) {
      throw new Error(
        `${mode} entry point is missing: ${path.relative(repoRoot, file)}`,
      );
    }
  }
  const program = createProgram(entryFiles, mode === 'source');
  const surfaces = {};
  for (const [name, packageInfo] of Object.entries(packages)) {
    surfaces[name] = {};
    for (const [subpath, entry] of Object.entries(packageInfo.entries)) {
      surfaces[name][subpath] = Object.fromEntries(
        entry.declarations.map((declaration) => [
          declaration.condition,
          inspectEntry(program, declaration.entryFile, roots),
        ]),
      );
    }
  }
  return surfaces;
}

function primarySurface(variants) {
  return variants?.types ?? Object.values(variants ?? {})[0] ?? [];
}

export function selectDeclarationSurface(variants, runtimeCondition, format) {
  const conditions = runtimeCondition ? runtimeCondition.split('.') : [];
  const candidates = [];
  if (conditions.at(-1) === format) {
    candidates.push([...conditions.slice(0, -1), 'types'].join('.'));
  }
  for (let length = conditions.length - 1; length > 0; length -= 1) {
    candidates.push([...conditions.slice(0, length), 'types'].join('.'));
  }
  candidates.push('types');
  for (const candidate of candidates) {
    if (variants?.[candidate]) return variants[candidate];
  }
  return primarySurface(variants);
}

export function compareResolvedConditionSurfaces(
  baselineExport,
  candidateExport,
  baselineVariants,
  candidateVariants,
  location,
  { deep = true } = {},
) {
  const errors = [];
  const conditionSets = [[], ...collectRuntimeConditionSets([baselineExport])];
  for (const conditions of conditionSets) {
    for (const format of ['import', 'require']) {
      const baselineTarget = resolveConditionalTarget(
        baselineExport,
        format,
        conditions,
      );
      const candidateTarget = resolveConditionalTarget(
        candidateExport,
        format,
        conditions,
      );
      if (!baselineTarget || !candidateTarget) continue;
      const conditionLabel =
        conditions.length > 0 ? conditions.join(',') : 'default';
      errors.push(
        ...compareSurfaceRecords(
          selectDeclarationSurface(
            baselineVariants,
            baselineTarget.condition,
            format,
          ),
          selectDeclarationSurface(
            candidateVariants,
            candidateTarget.condition,
            format,
          ),
          `${location} [${conditionLabel} ${format}]`,
          { deep },
        ),
      );
    }
  }
  return sortedUnique(errors);
}

function compareMemberShape(
  baseline,
  candidate,
  location,
  { rejectRequiredAdditions = false } = {},
) {
  const errors = [];
  const candidateByName = new Map(
    candidate.map((member) => [member.name, member]),
  );
  for (const baselineMember of baseline) {
    const candidateMember = candidateByName.get(baselineMember.name);
    if (!candidateMember) {
      errors.push(`${location}.${baselineMember.name} was removed`);
      continue;
    }
    if (baselineMember.optional !== candidateMember.optional) {
      errors.push(`${location}.${baselineMember.name} changed optionality`);
    }
    if (baselineMember.readonly !== candidateMember.readonly) {
      errors.push(`${location}.${baselineMember.name} changed readonly status`);
    }
    if (baselineMember.callable !== candidateMember.callable) {
      errors.push(`${location}.${baselineMember.name} changed callable kind`);
    }
  }
  if (rejectRequiredAdditions) {
    const baselineNames = new Set(baseline.map((member) => member.name));
    for (const candidateMember of candidate) {
      if (
        !baselineNames.has(candidateMember.name) &&
        !candidateMember.optional
      ) {
        errors.push(
          `${location}.${candidateMember.name} added required member`,
        );
      }
    }
  }
  return errors;
}

export function compareOwnedDescriptors(baseline, candidate, location) {
  const errors = [];
  if (baseline.kind === 'enum') {
    const candidateMembers = new Map(
      (candidate.enumMembers ?? []).map((member) => [
        member.name,
        member.value,
      ]),
    );
    for (const member of baseline.enumMembers ?? []) {
      if (!candidateMembers.has(member.name)) {
        errors.push(`${location}.${member.name} enum member was removed`);
      } else if (candidateMembers.get(member.name) !== member.value) {
        errors.push(`${location}.${member.name} enum value changed`);
      }
    }
  }
  if (baseline.members) {
    errors.push(
      ...compareMemberShape(
        baseline.members,
        candidate.members ?? [],
        location,
        {
          rejectRequiredAdditions: ['interface', 'type'].includes(
            baseline.kind,
          ),
        },
      ),
    );
  }
  if (baseline.staticMembers) {
    errors.push(
      ...compareMemberShape(
        baseline.staticMembers,
        candidate.staticMembers ?? [],
        `${location} static`,
      ),
    );
  }
  if (baseline.constructible && !candidate.constructible) {
    errors.push(`${location} is no longer publicly constructible`);
  }
  if (baseline.literals) {
    const candidateLiterals = new Set(candidate.literals ?? []);
    for (const literal of baseline.literals) {
      if (!candidateLiterals.has(literal)) {
        errors.push(`${location} removed literal ${literal}`);
      }
    }
  }
  if (baseline.namespaceMembers) {
    const candidateMembers = new Map(
      (candidate.namespaceMembers ?? []).map((member) => [member.name, member]),
    );
    for (const member of baseline.namespaceMembers) {
      const candidateMember = candidateMembers.get(member.name);
      if (!candidateMember) {
        errors.push(`${location}.${member.name} namespace member was removed`);
        continue;
      }
      for (const space of member.spaces) {
        if (!candidateMember.spaces.includes(space)) {
          errors.push(
            `${location}.${member.name} namespace member lost its ${space} binding`,
          );
        }
      }
    }
  }
  return errors;
}

export function compareSurfaceRecords(
  baselineRecords,
  candidateRecords,
  location,
  { deep = true } = {},
) {
  const errors = [];
  const candidateByName = new Map(
    candidateRecords.map((item) => [item.name, item]),
  );
  for (const baseline of baselineRecords) {
    const candidate = candidateByName.get(baseline.name);
    const bindingLocation = `${location}.${baseline.name}`;
    if (!candidate) {
      errors.push(`${bindingLocation} was removed`);
      continue;
    }
    for (const space of baseline.spaces) {
      if (!candidate.spaces.includes(space)) {
        errors.push(`${bindingLocation} lost its ${space} binding`);
      }
    }
    if (!baseline.sdkOwned) {
      continue;
    }
    if (!candidate.sdkOwned) {
      errors.push(`${bindingLocation} is no longer SDK-owned`);
      continue;
    }
    if (baseline.kind !== candidate.kind) {
      errors.push(
        `${bindingLocation} changed declaration kind from ${baseline.kind} to ${candidate.kind}`,
      );
      continue;
    }
    if (deep) {
      errors.push(
        ...compareOwnedDescriptors(baseline, candidate, bindingLocation),
      );
    } else if (baseline.enumMembers) {
      errors.push(
        ...compareOwnedDescriptors(
          { kind: 'enum', enumMembers: baseline.enumMembers },
          candidate,
          bindingLocation,
        ),
      );
    }
  }
  return errors;
}

export function validateSelectedProperties(surfaces, selectedProperties) {
  const errors = [];
  for (const policy of selectedProperties) {
    const records = primarySurface(surfaces[policy.package]?.[policy.subpath]);
    const exported = records.find((item) => item.name === policy.export);
    const members = new Set([
      ...(exported?.members ?? []).map((item) => item.name),
      ...(exported?.methodNames ?? []),
    ]);
    for (const property of policy.properties) {
      if (!members.has(property)) {
        errors.push(
          `${packageKey(policy.package, policy.subpath)}.${policy.export}.${property} was removed`,
        );
      }
    }
  }
  return errors;
}

export function compareOptionalPeers(baselinePackage, candidateManifest, name) {
  const errors = [];
  for (const optionalPeer of baselinePackage.optionalPeers ?? []) {
    if (!candidateManifest.peerDependencies?.[optionalPeer]) {
      errors.push(`${name} optional peer ${optionalPeer} was removed`);
    } else if (
      candidateManifest.peerDependenciesMeta?.[optionalPeer]?.optional !== true
    ) {
      errors.push(`${name} peer ${optionalPeer} is no longer optional`);
    }
  }
  return errors;
}

function comparePackageSets(
  contract,
  baselineSurfaces,
  candidatePackages,
  candidateSurfaces,
  deep,
) {
  const errors = [];
  for (const [name] of PUBLIC_PACKAGES) {
    const baselinePackage = contract.packages[name];
    const candidatePackage = candidatePackages[name];
    errors.push(
      ...compareOptionalPeers(baselinePackage, candidatePackage.manifest, name),
    );
    for (const [subpath, baselineExport] of Object.entries(
      baselinePackage.exports ?? {},
    )) {
      const candidateExport = candidatePackage.manifest.exports?.[subpath];
      if (!candidateExport) {
        errors.push(`${packageKey(name, subpath)} export path was removed`);
        continue;
      }
      errors.push(
        ...compareConditionTrees(
          baselineExport,
          candidateExport,
          `${packageKey(name, subpath)} conditions`,
        ),
      );
      errors.push(
        ...compareResolvedConditionSurfaces(
          baselineExport,
          candidateExport,
          baselineSurfaces[name]?.[subpath],
          candidateSurfaces[name]?.[subpath],
          packageKey(name, subpath),
          { deep },
        ),
      );
      for (const { condition } of collectConditionTargets(
        baselineExport,
        'types',
      )) {
        errors.push(
          ...compareSurfaceRecords(
            baselineSurfaces[name]?.[subpath]?.[condition] ?? [],
            candidateSurfaces[name]?.[subpath]?.[condition] ?? [],
            `${packageKey(name, subpath)} [${condition}]`,
            { deep },
          ),
        );
      }
    }
  }
  errors.push(
    ...validateSelectedProperties(
      candidateSurfaces,
      contract.selectedPublicProperties ?? [],
    ),
  );
  return sortedUnique(errors);
}

async function inspectAndComparePackageSets(
  contract,
  baselinePackages,
  candidatePackages,
) {
  const baselineSurfaces = await inspectPackageSet(baselinePackages, 'dist');
  const candidateSurfaces = await inspectPackageSet(candidatePackages, 'dist');
  return {
    errors: comparePackageSets(
      contract,
      baselineSurfaces,
      candidatePackages,
      candidateSurfaces,
      true,
    ),
    candidateSurfaces,
  };
}

async function assertAllTargetsExist(packages) {
  const errors = [];
  for (const [name, packageInfo] of Object.entries(packages)) {
    for (const [subpath, entry] of Object.entries(packageInfo.entries)) {
      errors.push(
        ...validateExportLeafConditions(
          entry.exportNode,
          packageKey(name, subpath),
        ),
      );
      for (const { target } of collectExportLeaves(entry.exportNode)) {
        if (!(await pathExists(path.join(packageInfo.packageRoot, target)))) {
          errors.push(
            `${packageKey(name, subpath)} export target ${target} is missing`,
          );
        }
      }
      for (const condition of ['types', 'require', 'import']) {
        const targets = collectTargets(entry.exportNode, condition);
        if (targets.length === 0) {
          errors.push(
            `${packageKey(name, subpath)} has no ${condition} target`,
          );
        }
      }
    }
  }
  return errors;
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

async function validatePublicSpecifiers(
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

async function validateRuntime(packages, surfaces, entryFilter = () => true) {
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

async function materializePublished(contractPackages, registry) {
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

async function installOptionalPeers(materialized, registry) {
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
    const baselineSurfaces = await inspectPackageSet(baselinePackages, 'dist');
    const packages = await loadPackageSet(workspaceRoots(), 'source');
    const surfaces = await inspectPackageSet(packages, 'source');
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

async function installFromRegistry(registry, allOptionals) {
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

async function validatePackage(contract, registry) {
  await withAcquiredResources(
    [() => installFromRegistry(registry, false)],
    async ([noExtra]) => {
      const packages = await loadPackageSet(noExtra.roots, 'dist');
      const surfaces = await inspectPackageSet(packages, 'dist');
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
        surfaces = await inspectPackageSet(packages, 'dist');
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
        selectedPublicProperties: contract.selectedPublicProperties ?? [],
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
