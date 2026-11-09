import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { createRewriteImportTransformer } from 'tsc-multi/dist/transformers/rewriteImport';
import { expect, it } from 'vitest';

it('bundles actual public voice platform subpaths for browsers without native or Node imports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-voice-browser-'));
  try {
    for (const name of ['agents-codex', 'agents']) {
      const sourceRoot = resolve(import.meta.dirname, '../../', name);
      const targetRoot = join(directory, 'node_modules/@openai', name);
      await mkdir(targetRoot, { recursive: true });
      const manifest = JSON.parse(
        await readFile(join(sourceRoot, 'package.json'), 'utf8'),
      );
      await writeFile(
        join(targetRoot, 'package.json'),
        JSON.stringify(manifest),
      );
      // Produce only these independent entry artifacts; package exports resolve
      // normally, with no alias that could conceal a native barrel dependency.
      for (const leaf of ['browser', 'workerd', 'portable']) {
        const entry = manifest.exports[`./voice/${leaf}`].import
          .default as string;
        const source = await readFile(
          join(sourceRoot, 'src/voice', `${leaf}.ts`),
          'utf8',
        );
        const emitted = ts.transpileModule(source, {
          fileName: join(sourceRoot, 'src/voice', `${leaf}.ts`),
          // Apply the producer's exact ESM import rewrite, including local dependencies.
          transformers: {
            after: [
              createRewriteImportTransformer({
                extname: '.mjs',
                system: ts.sys,
                ts,
              }),
            ],
          },
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
          },
        }).outputText;
        const path = join(targetRoot, entry);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, emitted);
      }
    }
    // tsx is a direct workspace dev dependency and declares esbuild itself.
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      absWorkingDir: directory,
      stdin: {
        contents:
          "export { NativeVoiceWebRTC } from '@openai/agents/voice/browser'; export { openVoiceWebSocket } from '@openai/agents/voice/workerd'; export { NativeVoiceControl, PortableVoiceSession } from '@openai/agents/voice/portable';",
        resolveDir: directory,
        sourcefile: 'consumer.js',
      },
      platform: 'browser',
      format: 'esm',
      bundle: true,
      write: false,
      metafile: true,
    });
    expect(Object.keys(result.metafile!.inputs)).toHaveLength(7);
    expect(result.outputFiles[0].text).toContain('NativeVoiceWebRTC');
    expect(result.outputFiles[0].text).toContain('openVoiceWebSocket');
    expect(result.outputFiles[0].text).not.toMatch(
      /codex\.node|node:|NativeProvider|ClassicRealtimeSession/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
