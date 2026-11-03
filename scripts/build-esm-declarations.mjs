import process from 'node:process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import ts from '@typescript/typescript6';

// tsc-multi rewrites runtime imports, but emits only shared .d.ts files. Keep
// those for CommonJS and legacy resolution; give ESM its own declaration graph.
export function buildEsmDeclarations(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      buildEsmDeclarations(file);
      continue;
    }
    if (!entry.name.endsWith('.d.ts')) continue;
    let source = readFileSync(file, 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const references = [];
    function visit(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        references.push(node.moduleSpecifier);
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        references.push(node.argument.literal);
      ts.forEachChild(node, visit);
    }
    visit(ast);
    for (const reference of references.sort((a, b) => b.pos - a.pos)) {
      const specifier = reference.text;
      if (!ts.isExternalModuleNameRelative(specifier)) continue;
      const target = resolve(dirname(file), specifier.replace(/\.js$/, ''));
      const esm = [`${target}.mjs`, join(target, 'index.mjs')].find(existsSync);
      // Imports of external CommonJS files (notably native/index.js) retain
      // their original module kind instead of referring to a nonexistent ESM file.
      if (!esm) continue;
      let replacement = relative(dirname(file), esm).replaceAll('\\', '/');
      if (!replacement.startsWith('.')) replacement = `./${replacement}`;
      source =
        source.slice(0, reference.getStart(ast) + 1) +
        replacement +
        source.slice(reference.end - 1);
    }
    writeFileSync(file.replace(/\.d\.ts$/, '.d.mts'), source);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = new URL('../', import.meta.url);
  for (const name of [
    'agents-core',
    'agents-openai',
    'agents-realtime',
    'agents',
    'agents-extensions',
  ]) {
    buildEsmDeclarations(fileURLToPath(new URL(`packages/${name}/dist`, root)));
  }
}
