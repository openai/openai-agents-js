// Only the package build runs a compiler. Installation and import never do.
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));
const headers = resolve(dirname(process.execPath), '../include/node');
const abi = process.versions.modules;
const supported =
  process.release.name === 'node' &&
  process.platform === 'linux' &&
  process.arch === 'x64' &&
  (abi === '127' || abi === '137') &&
  process.config.variables.v8_enable_pointer_compression === 0 &&
  process.config.variables.v8_enable_sandbox === 0 &&
  existsSync(join(headers, 'node.h'));
if (!supported) {
  console.log('Building the portable SDK without native history support.');
} else {
  const output = resolve(source, '../dist/native');
  mkdirSync(output, { recursive: true });
  try {
    execFileSync(
      'c++',
      [
        '-std=c++20',
        '-shared',
        '-fPIC',
        '-O3',
        '-fvisibility=hidden',
        '-DAGENTS_NODE_ABI=' + abi,
        '-I' + headers,
        join(source, 'input-history.cc'),
        '-o',
        join(output, 'linux-x64-' + abi + '.node'),
      ],
      { stdio: 'inherit' },
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log('No C++ compiler. Building the portable SDK.');
  }
}
