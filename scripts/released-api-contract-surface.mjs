// Declaration inspection and compatibility policy. This module only reads package files.
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

export const PUBLIC_PACKAGES = [
  ['@openai/agents-core', 'agents-core'],
  ['@openai/agents-openai', 'agents-openai'],
  ['@openai/agents-realtime', 'agents-realtime'],
  ['@openai/agents-extensions', 'agents-extensions'],
  ['@openai/agents', 'agents'],
];

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const typeFormatFlags =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

export async function readJson(file) {
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

export function sortedUnique(values) {
  return [...new Set(values)].sort();
}

export function packageKey(name, subpath) {
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

function normalizeCanonicalType(value) {
  return value
    .replace(/import\("[^"\n]*node_modules\/(@?[^"\n]+?)"\)/g, 'import("$1")')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalType(checker, type, node) {
  return normalizeCanonicalType(
    checker.typeToString(type, node, typeFormatFlags),
  );
}

function canonicalTypeNode(checker, node, typeParameterNames) {
  const writer = ts.createTextWriter('\n');
  const writeSymbol = writer.writeSymbol.bind(writer);
  writer.writeSymbol = (text, symbol) => {
    writeSymbol(typeParameterNames.get(symbol) ?? text, symbol);
  };
  checker.writeType(
    checker.getTypeFromTypeNode(node),
    node,
    typeFormatFlags,
    writer,
  );
  return normalizeCanonicalType(writer.getText());
}

function containsSymbolReference(checker, node, targetSymbol) {
  let found = false;
  const visit = (current) => {
    if (found) return;
    if (
      ts.isIdentifier(current) &&
      checker.getSymbolAtLocation(current) === targetSymbol
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function describeDirectCallableTypeAlias(checker, declaration) {
  if (
    !ts.isTypeAliasDeclaration(declaration) ||
    !ts.isFunctionTypeNode(declaration.type)
  ) {
    throw new Error('must be declared as a direct function type alias');
  }
  if ((declaration.type.typeParameters ?? []).length > 0) {
    throw new Error('must not declare call-signature type parameters');
  }

  const aliasSymbol = checker.getSymbolAtLocation(declaration.name);
  if (!aliasSymbol) {
    throw new Error('could not resolve callable type alias');
  }
  if (containsSymbolReference(checker, declaration.type, aliasSymbol)) {
    throw new Error('must not recursively reference itself');
  }

  const typeParameters = declaration.typeParameters ?? [];
  const typeParameterNames = new Map(
    typeParameters.map((parameter, index) => {
      const symbol = checker.getSymbolAtLocation(parameter.name);
      if (!symbol) {
        throw new Error('could not resolve callable type parameter');
      }
      return [symbol, `[[type-parameter:${index}]]`];
    }),
  );
  if (
    typeParameters.some(
      (parameter) =>
        ts.canHaveModifiers(parameter) &&
        (ts.getModifiers(parameter) ?? []).length > 0,
    )
  ) {
    throw new Error('must not declare type parameter modifiers');
  }
  if (
    declaration.type.parameters.some(
      (parameter) =>
        ts.isIdentifier(parameter.name) && parameter.name.text === 'this',
    )
  ) {
    throw new Error('must not declare a this parameter');
  }
  return {
    callableSignature: {
      typeParameters: typeParameters.map((parameter) => ({
        constraint: parameter.constraint
          ? canonicalTypeNode(checker, parameter.constraint, typeParameterNames)
          : null,
        default: parameter.default
          ? canonicalTypeNode(checker, parameter.default, typeParameterNames)
          : null,
      })),
      parameters: declaration.type.parameters.map((parameter) => ({
        optional: Boolean(parameter.questionToken),
        rest: Boolean(parameter.dotDotDotToken),
        type: canonicalTypeNode(checker, parameter.type, typeParameterNames),
      })),
      returnType: canonicalTypeNode(
        checker,
        declaration.type.type,
        typeParameterNames,
      ),
    },
  };
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

export function describeOwnedSymbol(
  checker,
  symbol,
  kind,
  { selectedTypeAliasKind } = {},
) {
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
    if (selectedTypeAliasKind === 'callable') {
      return describeDirectCallableTypeAlias(checker, declaration);
    }
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

export function normalizeSelectedPublicTypeAliases(value = []) {
  if (!Array.isArray(value)) {
    throw new Error('selectedPublicTypeAliases must be an array');
  }
  const identities = new Set();
  return value.map((entry) => {
    const requiredFields = ['package', 'subpath', 'export', 'kind'];
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join('\0') !== requiredFields.sort().join('\0')
    ) {
      throw new Error(
        'selectedPublicTypeAliases entries must contain exactly package, subpath, export, and kind',
      );
    }
    for (const field of ['package', 'subpath', 'export']) {
      if (typeof entry[field] !== 'string' || entry[field].length === 0) {
        throw new Error(
          `selectedPublicTypeAliases ${field} values must be non-empty strings`,
        );
      }
    }
    if (entry.kind !== 'callable') {
      throw new Error(
        `selectedPublicTypeAliases ${entry.package}${entry.subpath === '.' ? '' : entry.subpath.slice(1)}.${entry.export} has unsupported kind ${String(entry.kind)}`,
      );
    }
    const identity = `${entry.package}\0${entry.subpath}\0${entry.export}`;
    if (identities.has(identity)) {
      throw new Error(
        `selectedPublicTypeAliases repeats ${entry.package}${entry.subpath === '.' ? '' : entry.subpath.slice(1)}.${entry.export}`,
      );
    }
    identities.add(identity);
    return { ...entry };
  });
}

export function preservedSelectionPolicies(contract) {
  return {
    selectedPublicProperties: contract.selectedPublicProperties ?? [],
    selectedPublicTypeAliases: contract.selectedPublicTypeAliases ?? [],
  };
}

function selectedTypeAliasesForEntry(
  selectedPublicTypeAliases,
  packageName,
  subpath,
) {
  return new Map(
    selectedPublicTypeAliases
      .filter(
        (entry) => entry.package === packageName && entry.subpath === subpath,
      )
      .map((entry) => [entry.export, entry.kind]),
  );
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

function inspectEntry(
  program,
  entryFile,
  ownedRoots,
  selectedTypeAliases = new Map(),
  location,
) {
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
    const selectedTypeAliasKind = selectedTypeAliases.get(
      exportSymbol.getName(),
    );
    if (selectedTypeAliasKind && (!sdkOwned || kind !== 'type')) {
      throw new Error(
        `${location}.${exportSymbol.getName()} must resolve to an SDK-owned type alias`,
      );
    }
    let descriptor = {};
    if (sdkOwned) {
      try {
        descriptor = describeOwnedSymbol(checker, targetSymbol, kind, {
          selectedTypeAliasKind,
        });
      } catch (error) {
        throw new Error(
          `${location}.${exportSymbol.getName()} selected ${selectedTypeAliasKind} type alias ${error.message}`,
        );
      }
    }
    const record = {
      name: exportSymbol.getName(),
      spaces,
      sdkOwned,
      ...(sdkOwned
        ? {
            kind,
            ...descriptor,
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

export async function loadPackageSet(roots, mode) {
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

export async function inspectPackageSet(
  packages,
  mode,
  selectedPublicTypeAliases = [],
) {
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
      const selectedTypeAliases = selectedTypeAliasesForEntry(
        selectedPublicTypeAliases,
        name,
        subpath,
      );
      surfaces[name][subpath] = Object.fromEntries(
        entry.declarations.map((declaration) => [
          declaration.condition,
          inspectEntry(
            program,
            declaration.entryFile,
            roots,
            selectedTypeAliases,
            packageKey(name, subpath),
          ),
        ]),
      );
    }
  }
  return surfaces;
}

export function primarySurface(variants) {
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

function compareCallableSignatures(baseline, candidate, location) {
  const errors = [];
  const baselineTypeParameters = baseline.typeParameters ?? [];
  const candidateTypeParameters = candidate.typeParameters ?? [];
  if (baselineTypeParameters.length !== candidateTypeParameters.length) {
    errors.push(`${location} changed callable type parameter count`);
  } else {
    for (let index = 0; index < baselineTypeParameters.length; index += 1) {
      const baselineParameter = baselineTypeParameters[index];
      const candidateParameter = candidateTypeParameters[index];
      if (baselineParameter.constraint !== candidateParameter.constraint) {
        errors.push(
          `${location} callable type parameter ${index} changed constraint`,
        );
      }
      if (baselineParameter.default !== candidateParameter.default) {
        errors.push(
          `${location} callable type parameter ${index} changed default`,
        );
      }
    }
  }

  const baselineParameters = baseline.parameters ?? [];
  const candidateParameters = candidate.parameters ?? [];
  if (baselineParameters.length !== candidateParameters.length) {
    errors.push(`${location} changed callable parameter count`);
  } else {
    for (let index = 0; index < baselineParameters.length; index += 1) {
      const baselineParameter = baselineParameters[index];
      const candidateParameter = candidateParameters[index];
      if (baselineParameter.optional !== candidateParameter.optional) {
        errors.push(
          `${location} callable parameter ${index} changed optionality`,
        );
      }
      if (baselineParameter.rest !== candidateParameter.rest) {
        errors.push(
          `${location} callable parameter ${index} changed rest kind`,
        );
      }
      if (baselineParameter.type !== candidateParameter.type) {
        errors.push(`${location} callable parameter ${index} changed type`);
      }
    }
  }
  if (baseline.returnType !== candidate.returnType) {
    errors.push(`${location} changed callable return type`);
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
  if (baseline.callableSignature) {
    if (!candidate.callableSignature) {
      errors.push(`${location} lost its selected callable signature`);
    } else {
      errors.push(
        ...compareCallableSignatures(
          baseline.callableSignature,
          candidate.callableSignature,
          location,
        ),
      );
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
    } else if (baseline.enumMembers || baseline.callableSignature) {
      errors.push(
        ...compareOwnedDescriptors(
          {
            kind: baseline.kind,
            ...(baseline.enumMembers
              ? { enumMembers: baseline.enumMembers }
              : {}),
            ...(baseline.callableSignature
              ? { callableSignature: baseline.callableSignature }
              : {}),
          },
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

export function validateSelectedPublicTypeAliases(
  surfaces,
  selectedPublicTypeAliases,
) {
  const errors = [];
  for (const policy of selectedPublicTypeAliases) {
    const location = `${packageKey(policy.package, policy.subpath)}.${policy.export}`;
    const variants = surfaces[policy.package]?.[policy.subpath];
    if (!variants || Object.keys(variants).length === 0) {
      errors.push(`${location} selected public type alias is missing`);
      continue;
    }
    for (const [condition, records] of Object.entries(variants)) {
      const exported = records.find((item) => item.name === policy.export);
      if (!exported) {
        errors.push(
          `${location} selected public type alias is missing in ${condition}`,
        );
      } else if (
        !exported.sdkOwned ||
        exported.kind !== 'type' ||
        !exported.callableSignature
      ) {
        errors.push(
          `${location} selected public type alias has no ${policy.kind} definition in ${condition}`,
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

export function comparePackageSets(
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
    ...validateSelectedPublicTypeAliases(
      candidateSurfaces,
      contract.selectedPublicTypeAliases ?? [],
    ),
  );
  return sortedUnique(errors);
}

export async function inspectAndComparePackageSets(
  contract,
  baselinePackages,
  candidatePackages,
) {
  const selectedPublicTypeAliases = contract.selectedPublicTypeAliases ?? [];
  const baselineSurfaces = await inspectPackageSet(
    baselinePackages,
    'dist',
    selectedPublicTypeAliases,
  );
  const candidateSurfaces = await inspectPackageSet(
    candidatePackages,
    'dist',
    selectedPublicTypeAliases,
  );
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

export async function assertAllTargetsExist(packages) {
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
