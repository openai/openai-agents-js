import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { build } from 'rolldown';

export async function buildCoreNode(directory) {
  const pkg = JSON.parse(
    await readFile(resolve(directory, 'package.json'), 'utf8'),
  );
  const input = {};
  const self = {};
  for (const [key, entry] of Object.entries(pkg.exports)) {
    const source = entry.node.import ?? entry.import;
    const name = source.replace(/^\.\/dist\//, '').replace(/\.mjs$/, '');
    input[name] = resolve(directory, source);
    self[key === '.' ? pkg.name : pkg.name + key.slice(1)] = input[name];
  }
  await build({
    input,
    platform: 'node',
    preserveEntrySignatures: 'strict',
    treeshake: false,
    external: (id) =>
      !id.startsWith('.') && !isAbsolute(id) && !Object.hasOwn(self, id),
    plugins: [
      {
        name: 'canonical-core-self-paths',
        resolveId(id) {
          return self[id] ?? null;
        },
      },
    ],
    output: {
      dir: resolve(directory, 'dist/node'),
      format: 'cjs',
      exports: 'named',
      esModule: true,
      generatedCode: { symbols: false },
      // Match the existing CJS marker's descriptor and Node's named export lexer.
      footer: (chunk) =>
        chunk.isEntry
          ? 'Object.defineProperty(exports, "__esModule", { value: true });'
          : '',
      entryFileNames: '[name].cjs',
      chunkFileNames: 'chunks/[name]-[hash].cjs',
      codeSplitting: true,
      strictExecutionOrder: true,
      keepNames: true,
      sourcemap: true,
    },
  });
}
