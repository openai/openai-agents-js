import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from '@typescript/typescript6';
import { describe, expect, it } from 'vitest';

// Read source, never import a runtime or activate a native/optional capability.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const core = resolve(root, 'packages/agents-core/src');
const codex = resolve(root, 'packages/agents-codex/src');
const coreName = '@openai/agents-core';
const reversePackages = [
  '@openai/agents',
  '@openai/agents-codex',
  '@openai/agents-openai',
  '@openai/agents-realtime',
  '@openai/agents-extensions',
];
const coreExports = JSON.parse(
  readFileSync(resolve(core, '../package.json'), 'utf8'),
).exports;
type Sources = Map<string, string>;
type Edge = {
  target?: string;
  typeOnly: boolean;
  line: number;
};
type Policy = 'core' | 'leaf';

function sourceFiles(directory: string, files: Sources = new Map()): Sources {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(path, files);
    else if (
      /\.(?:ts|tsx|mts|cts)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    )
      files.set(path, readFileSync(path, 'utf8'));
  }
  return files;
}

function edges(path: string, source: string): Edge[] {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest);
  const result: Edge[] = [];
  const moduleRequires = new Set(['require']);
  const createRequires = new Set<string>();
  for (const statement of tree.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      ['node:module', 'module'].includes(statement.moduleSpecifier.text)
    ) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements)
          if ((element.propertyName ?? element.name).text === 'createRequire')
            createRequires.add(element.name.text);
    }
  }
  function literal(node: ts.Node): string | undefined {
    return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      ? node.text
      : undefined;
  }
  function add(node: ts.Node, target: ts.Node, typeOnly: boolean) {
    result.push({
      target: literal(target),
      typeOnly,
      line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
    });
  }
  const declarations: ts.VariableDeclaration[] = [];
  function collectDeclarations(node: ts.Node) {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, collectDeclarations);
  }
  collectDeclarations(tree);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      const value = declaration.initializer;
      if (!ts.isIdentifier(declaration.name) || !value) continue;
      if (
        (ts.isCallExpression(value) &&
          ts.isIdentifier(value.expression) &&
          createRequires.has(value.expression.text)) ||
        (ts.isIdentifier(value) && moduleRequires.has(value.text))
      ) {
        const previous = moduleRequires.size;
        moduleRequires.add(declaration.name.text);
        changed ||= previous !== moduleRequires.size;
      }
    }
  }
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const typeOnly =
        !!clause?.isTypeOnly ||
        (!clause?.name &&
          !!named &&
          ts.isNamedImports(named) &&
          named.elements.length > 0 &&
          named.elements.every((element) => element.isTypeOnly));
      add(node, node.moduleSpecifier, typeOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const named = node.exportClause;
      add(
        node,
        node.moduleSpecifier,
        node.isTypeOnly ||
          (!!named &&
            ts.isNamedExports(named) &&
            named.elements.length > 0 &&
            named.elements.every((element) => element.isTypeOnly)),
      );
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    ) {
      add(node, node.moduleReference.expression, node.isTypeOnly);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      add(node, node.argument.literal, true);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          moduleRequires.has(node.expression.text)) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'module' &&
          node.expression.name.text === 'require'))
    ) {
      if (node.arguments[0]) add(node, node.arguments[0], false);
      else result.push({ typeOnly: false, line: 1 });
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return result;
}

function packageMatches(target: string, name: string): boolean {
  return target === name || target.startsWith(name + '/');
}

function localTargets(
  importer: string,
  target: string,
  files: Sources,
): string[] | undefined {
  if (target.startsWith('.')) {
    const path = resolve(dirname(importer), target);
    const stem = path.replace(/\.(?:js|mjs|cjs)$/, '');
    const found = [
      path,
      ...['.ts', '.tsx', '.mts', '.cts', '/index.ts'].map((ext) => stem + ext),
    ].find((candidate) => files.has(candidate));
    if (found) return [found];
    if (path.endsWith('.json') && existsSync(path)) return [];
    return undefined;
  }
  if (packageMatches(target, coreName)) {
    const exportKey =
      target === coreName ? '.' : '.' + target.slice(coreName.length);
    const paths = new Set<string>();
    function targets(value: unknown) {
      if (typeof value === 'string') {
        // Packed Node forwarding leaves share these original source owners.
        const path = resolve(
          core,
          value
            .replace(/^\.\/dist\/(?:node\/)?/, '')
            .replace(/\.(?:js|mjs|cjs)$/, '.ts'),
        );
        if (!files.has(path))
          throw new Error(`Unresolved Core export ${target}: ${value}`);
        paths.add(path);
      } else if (Array.isArray(value)) value.forEach(targets);
      else if (value && typeof value === 'object')
        for (const [condition, branch] of Object.entries(value))
          if (condition !== 'types') targets(branch);
    }
    if (!(exportKey in coreExports)) return undefined;
    targets(coreExports[exportKey]);
    return [...paths];
  }
  return []; // External libraries/builtins remain explicit graph boundaries.
}

function violations(files: Sources, roots: string[], policy: Policy): string[] {
  const found: string[] = [];
  const visited = new Set<string>();
  function walk(path: string, chain: string[]) {
    if (visited.has(path)) return;
    visited.add(path);
    const source = files.get(path);
    if (source === undefined) throw new Error(`Missing guarded owner: ${path}`);
    for (const edge of edges(path, source)) {
      const route = [...chain, `${relative(root, path)}:${edge.line}`];
      const fail = (target: string) =>
        found.push([...route, target].join(' -> '));
      if (edge.target === undefined) {
        fail('<computed module target>');
        continue;
      }
      const target = edge.target;
      if (
        policy === 'core' &&
        reversePackages.some((name) => packageMatches(target, name))
      ) {
        fail(target);
        continue;
      }
      // Core declaration edges must not point back into the Codex package either.
      if (edge.typeOnly) {
        if (policy === 'core' && target.startsWith('.')) {
          const targets = localTargets(path, target, files);
          if (targets === undefined) fail(`unresolved type ${target}`);
          else
            for (const resolved of targets)
              if (resolved.startsWith(codex + sep))
                fail(relative(root, resolved));
        }
        continue;
      }
      if (
        policy === 'leaf' &&
        [coreName, ...reversePackages].some((name) =>
          packageMatches(target, name),
        )
      ) {
        fail(target);
        continue;
      }
      const targets = localTargets(path, target, files);
      if (targets === undefined) {
        fail(`unresolved ${target}`);
        continue;
      }
      for (const resolved of targets) {
        if (
          (policy === 'core' && resolved.startsWith(codex + sep)) ||
          (policy === 'leaf' &&
            (resolved.startsWith(core + sep) ||
              [
                'runtime/session.ts',
                'runtime/public-agent.ts',
                'runtime/agent.ts',
                'runtime/binding.ts',
                'index.ts',
              ].some((owner) => resolved === resolve(codex, owner))))
        )
          fail(relative(root, resolved));
        else walk(resolved, route);
      }
    }
  }
  for (const entry of roots) walk(entry, []);
  return found;
}

const leafOwners = [
  'agent-configuration.ts',
  'web-search.ts',
  'mcp-names.ts',
].map((name) => resolve(codex, 'runtime', name));
const files = sourceFiles(codex, sourceFiles(core));
describe('runtime dependency direction', () => {
  it('keeps Core independent of Codex, providers, realtime and convenience packages', () => {
    expect(
      violations(
        files,
        [...files.keys()].filter((path) => path.startsWith(core + sep)),
        'core',
      ),
    ).toEqual([]);
  }, 20_000);
  it('keeps the named declaration and projection leaves outside runtime assembly and binding', () => {
    expect(violations(files, leafOwners, 'leaf')).toEqual([]);
  });
  it('rejects a Core reverse dependency through a local barrel', () => {
    const start = resolve(core, 'model.ts');
    const barrel = resolve(core, 'barrel.ts');
    const result = violations(
      new Map([
        [start, "export * from './barrel.js';"],
        [barrel, "export { Agent } from '@openai/agents-codex';"],
      ]),
      [start],
      'core',
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('barrel.ts:1 -> @openai/agents-codex');
  });
  it('allows erased Session types without allowing mixed value imports', () => {
    const start = leafOwners[0];
    const source = (declaration: string) =>
      new Map([
        [start, declaration],
        [resolve(codex, 'runtime/session.ts'), ''],
      ]);
    expect(
      violations(
        source("import { type Session } from './session';"),
        [start],
        'leaf',
      ),
    ).toEqual([]);
    expect(
      violations(
        source("import { type Session, Agent } from './session';"),
        [start],
        'leaf',
      ).join('\n'),
    ).toContain('runtime/session.ts');
  });
  it('rejects a literal lazy native binding import and an unresolved computed target', () => {
    const start = leafOwners[0];
    const binding = resolve(codex, 'runtime/binding.ts');
    expect(
      violations(
        new Map([
          [start, "await import('./binding');"],
          [binding, ''],
        ]),
        [start],
        'leaf',
      ).join('\n'),
    ).toContain('runtime/binding.ts');
    expect(
      violations(
        new Map([[start, 'await import(target);']]),
        [start],
        'leaf',
      ).join('\n'),
    ).toContain('<computed module target>');
    expect(
      violations(
        new Map([[start, "import './missing';"]]),
        [start],
        'leaf',
      ).join('\n'),
    ).toContain('unresolved ./missing');
  });
  it('recognizes value re-exports and aliased createRequire calls', () => {
    const start = leafOwners[0];
    const binding = resolve(codex, 'runtime/binding.ts');
    for (const source of [
      "export { binding } from './binding';",
      "import { createRequire as makeRequire } from 'node:module'; const load = makeRequire(import.meta.url); load('./binding');",
    ])
      expect(
        violations(
          new Map([
            [start, source],
            [binding, ''],
          ]),
          [start],
          'leaf',
        ).join('\n'),
      ).toContain('runtime/binding.ts');
  });
  it('finds module loaders used before their declarations and through direct aliases', () => {
    const start = leafOwners[0];
    const binding = resolve(codex, 'runtime/binding.ts');
    for (const source of [
      "import { createRequire } from 'node:module'; export function loadBinding() { load('./binding'); } const load = createRequire(import.meta.url);",
      "export function loadBinding() { load('./binding'); } const load = require;",
    ])
      expect(
        violations(
          new Map([
            [start, source],
            [binding, ''],
          ]),
          [start],
          'leaf',
        ).join('\n'),
      ).toContain('runtime/binding.ts');
  });
  it('rejects relative Core declaration back-edges into Codex', () => {
    const start = resolve(core, 'model.ts');
    const target = resolve(codex, 'runtime/public-agent.ts');
    const fixture = new Map([
      [
        start,
        "export type { Agent } from '../../agents-codex/src/runtime/public-agent';",
      ],
      [target, ''],
    ]);
    expect(violations(fixture, [start], 'core').join('\n')).toContain(
      'runtime/public-agent.ts',
    );
  });
  it.each(['import', 'import type'])(
    'rejects durable Core %s edges into Codex',
    (keyword) => {
      const owner = resolve(core, 'sandbox/memory/generation.ts');
      expect(
        violations(
          new Map([
            [owner, `${keyword} { Agent } from '@openai/agents-codex';`],
          ]),
          [owner],
          'core',
        ),
      ).toHaveLength(1);
    },
  );
});
