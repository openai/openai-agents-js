import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const digest = (kind, bytes) =>
  createHash('sha1')
    .update(`${kind} ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
export const sha256Bytes = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');
const gitEnvironment = () => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  ),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
});
export function git(args, options = {}) {
  const result = spawnSync('git', ['--no-replace-objects', ...args], {
    env: gitEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}
function regular(path) {
  return lstatSync(path).isFile();
}
function keys(value, expected) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

export function verifyVendoredHyper(root) {
  // This fixed published inventory needs no additional prepared-source backend.
  const vendor = join(root, 'rust/vendor');
  for (const name of [
    'rust/vendor/hyper-1.8.1-provenance.json',
    'rust/vendor/hyper-1.8.1-readiness.patch',
    'Cargo.toml',
    'Cargo.lock',
    'rust/tests/hyper-readiness/Cargo.lock',
    '../licenses/hyper/LICENSE',
  ]) {
    if (!regular(join(root, name)))
      throw new Error(`Vendored Hyper input must be a regular file: ${name}`);
  }
  const manifest = JSON.parse(
    readFileSync(join(vendor, 'hyper-1.8.1-provenance.json'), 'utf8'),
  );
  const original = manifest.original_files;
  const originalDigest = sha256Bytes(
    Buffer.from(
      JSON.stringify(
        Object.fromEntries(
          Object.keys(original)
            .sort()
            .map((name) => [name, original[name]]),
        ),
      ),
    ),
  );
  const upstream = manifest.upstream;
  const changed = Object.keys(manifest.files).filter(
    (name) =>
      JSON.stringify(manifest.files[name]) !== JSON.stringify(original[name]),
  );
  if (
    manifest.format !== 'hyper-1.8.1-backport-v1' ||
    !keys(upstream, ['name', 'version', 'license', 'archive', 'sha256']) ||
    upstream.name !== 'hyper' ||
    upstream.version !== '1.8.1' ||
    upstream.license !== 'MIT' ||
    upstream.archive !==
      'https://static.crates.io/crates/hyper/hyper-1.8.1.crate' ||
    upstream.sha256 !==
      '2ab2d4f250c3d7b1c9fcdff1cece94ea4e2dfbec68614f7b87cb205f24ca9d11' ||
    originalDigest !==
      'a28fc1a73b6285118b347eb2a4daa862d7abb9e680ed6b5d9e41a5f27d83ca18' ||
    sha256Bytes(
      Buffer.from(
        JSON.stringify(
          Object.fromEntries(
            Object.keys(manifest.files)
              .sort()
              .map((name) => [name, manifest.files[name]]),
          ),
        ),
      ),
    ) !== '673337b63602b1cfd3974bdb948bc629aad822bca8cad2f3326cb8e60936a30e' ||
    manifest.patch_sha256 !==
      'f273142389a7036fcaff8fa3e2cfa26d093d3bccc75d227afaf314956a1198c1' ||
    Object.keys(manifest.files).length !== 69 ||
    Object.values(manifest.files).some(
      (value) =>
        !Array.isArray(value) ||
        value.length !== 2 ||
        value[0] !== '100644' ||
        !/^[0-9a-f]{40}$/.test(value[1]),
    ) ||
    JSON.stringify(Object.keys(manifest.files).sort()) !==
      JSON.stringify(Object.keys(original).sort()) ||
    JSON.stringify(changed) !== JSON.stringify(['src/client/dispatch.rs']) ||
    JSON.stringify(manifest.changed_files) !== JSON.stringify(changed) ||
    manifest.patch !== 'hyper-1.8.1-readiness.patch'
  )
    throw new Error(
      'Vendored Hyper provenance differs from the reviewed release',
    );
  if (
    sha256Bytes(readFileSync(join(vendor, manifest.patch))) !==
    manifest.patch_sha256
  )
    throw new Error(
      'Vendored Hyper patch bytes differ from their reviewed identity',
    );
  verifyTree(
    join(vendor, 'hyper-1.8.1'),
    new Map(
      Object.entries(manifest.files).map(([name, [mode, id]]) => [
        name,
        { mode, id },
      ]),
    ),
  );
  const cargo = readFileSync(join(root, 'Cargo.toml'), 'utf8');
  const overrides = cargo
    .split(/^\[patch\.crates-io\]\r?\n/m)[1]
    ?.split(/^\[/m)[0];
  if (
    !/^hyper = \{ version = "=1\.8\.1",/m.test(cargo) ||
    !/^hyper = \{ path = "rust\/vendor\/hyper-1\.8\.1" \}\r?$/m.test(
      overrides || '',
    )
  )
    throw new Error(
      'Native Cargo manifest must select the reviewed Hyper path and exact version',
    );
  for (const name of ['Cargo.lock', 'rust/tests/hyper-readiness/Cargo.lock']) {
    const packages = readFileSync(join(root, name), 'utf8')
      .split('[[package]]')
      .filter((section) => /^name = "hyper"\r?$/m.test(section));
    if (
      packages.length !== 1 ||
      !/^version = "1\.8\.1"\r?$/m.test(packages[0]) ||
      /^(source|checksum) =/m.test(packages[0])
    )
      throw new Error(
        `Cargo lock must select only the vendored Hyper 1.8.1: ${name}`,
      );
  }
  if (
    !readFileSync(join(root, '../licenses/hyper/LICENSE')).equals(
      readFileSync(join(vendor, 'hyper-1.8.1/LICENSE')),
    )
  )
    throw new Error(
      'Packaged Hyper license differs from the authenticated source',
    );
}

export function readSeries(directory) {
  if (
    !lstatSync(directory).isDirectory() ||
    !regular(join(directory, 'series.json'))
  )
    throw new Error(
      'Reviewed patch directory and manifest must be regular files',
    );
  const bytes = readFileSync(join(directory, 'series.json'));
  const series = JSON.parse(bytes);
  if (
    !keys(series, ['patches', 'result_tree']) ||
    !Array.isArray(series.patches) ||
    !/^[a-f0-9]{40}$/.test(series.result_tree)
  )
    throw new Error('Invalid reviewed patch manifest');
  const names = new Set(['series.json']);
  const patches = series.patches.map((entry) => {
    if (
      !keys(entry, ['path', 'sha256']) ||
      typeof entry.path !== 'string' ||
      !/^[a-zA-Z0-9_-]+\.patch$/.test(entry.path) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      names.has(entry.path) ||
      !regular(join(directory, entry.path))
    )
      throw new Error(
        'Patch inputs must be unique regular sibling files with SHA256 digests',
      );
    names.add(entry.path);
    const bytes = readFileSync(join(directory, entry.path));
    if (sha256Bytes(bytes) !== entry.sha256)
      throw new Error(`Reviewed patch hash differs: ${entry.path}`);
    return { ...entry, bytes };
  });
  if (readdirSync(directory).some((name) => !names.has(name)))
    throw new Error('Reviewed patch directory contains unlisted inputs');
  return {
    patches,
    result_tree: series.result_tree,
    manifest_sha256: sha256Bytes(bytes),
  };
}
export function sourceRepository(upstream, { source, name, url, revision }) {
  const repository = source ? resolve(source) : join(upstream, `${name}.git`);
  if (!source) {
    mkdirSync(upstream, { recursive: true });
    if (!existsSync(repository)) git(['init', '--bare', '--quiet', repository]);
    const present = spawnSync(
      'git',
      [
        '--no-replace-objects',
        '-C',
        repository,
        'cat-file',
        '-e',
        `${revision}^{commit}`,
      ],
      { env: gitEnvironment(), stdio: 'ignore' },
    );
    if (present.status !== 0)
      git(['-C', repository, 'fetch', '--depth=1', url, revision]);
  }
  const commit = git(['-C', repository, 'cat-file', 'commit', revision]);
  if (digest('commit', commit) !== revision)
    throw new Error('Source is not the pinned commit');
  return repository;
}
// Authenticate the whole recursive listing, not just the names returned by a local object store.
function treeIdentity(files) {
  const root = new Map();
  for (const [name, entry] of files) {
    const parts = name.split('/');
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      if (!directory.has(part)) directory.set(part, new Map());
      directory = directory.get(part);
      if (!(directory instanceof Map))
        throw new Error('Conflicting Git source paths');
    }
    directory.set(parts.at(-1), entry);
  }
  function encode(directory) {
    const entries = [...directory]
      .map(([name, entry]) => ({
        name,
        mode: entry instanceof Map ? '40000' : entry.mode,
        id: entry instanceof Map ? encode(entry) : entry.id,
        sort: Buffer.from(name + (entry instanceof Map ? '/' : '')),
      }))
      .sort((a, b) => Buffer.compare(a.sort, b.sort));
    return digest(
      'tree',
      Buffer.concat(
        entries.map(({ name, mode, id }) =>
          Buffer.concat([
            Buffer.from(`${mode} ${name}\0`),
            Buffer.from(id, 'hex'),
          ]),
        ),
      ),
    );
  }
  return encode(root);
}
function listing(repository, tree, options = {}) {
  const files = new Map();
  for (const row of git(['-C', repository, 'ls-tree', '-rz', tree], options)
    .toString('utf8')
    .split('\0')
    .filter(Boolean)) {
    const tab = row.indexOf('\t');
    const [mode, kind, id] = row.slice(0, tab).split(' ');
    const name = row.slice(tab + 1);
    if (
      kind !== 'blob' ||
      !['100644', '100755', '120000'].includes(mode) ||
      isAbsolute(name) ||
      name.includes('\\') ||
      name.split('/').some((p) => !p || p === '.' || p === '..')
    )
      throw new Error(`Unsupported Git source entry: ${name}`);
    files.set(name, { mode, id });
  }
  const expected = git(
    ['-C', repository, 'rev-parse', `${tree}^{tree}`],
    options,
  )
    .toString()
    .trim();
  if (treeIdentity(files) !== expected)
    throw new Error('Source tree differs from its Git identity');
  return files;
}
export function verifyTree(
  directory,
  files,
  { marker, identity, pristineRevision } = {},
) {
  const errors = [];
  const directories = new Set(['']);
  for (const name of files.keys()) {
    let parent = dirname(name);
    while (parent !== '.') {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  for (const name of directories) {
    const path = join(directory, name);
    if (!existsSync(path) || !lstatSync(path).isDirectory())
      errors.push(`Wrong directory type: ${name || '.'}`);
  }
  if (errors.length)
    throw new Error(`Native source audit failed:\n${errors.join('\n')}`);
  for (const [name, { mode, id }] of files) {
    const path = join(directory, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      errors.push(`Missing: ${name}`);
      continue;
    }
    const actual = stat.isSymbolicLink()
      ? '120000'
      : stat.isFile()
        ? stat.mode & 0o100
          ? '100755'
          : '100644'
        : null;
    const modesMatch =
      actual === mode ||
      (process.platform === 'win32' &&
        stat.isFile() &&
        ['100644', '100755'].includes(mode));
    if (
      !modesMatch ||
      digest(
        'blob',
        stat.isSymbolicLink()
          ? readlinkSync(path, { encoding: 'buffer' })
          : stat.isFile()
            ? readFileSync(path)
            : Buffer.alloc(0),
      ) !== id
    )
      errors.push(`Modified: ${name}`);
  }
  function extras(parent = '') {
    for (const entry of readdirSync(join(directory, parent), {
      withFileTypes: true,
    })) {
      const name = parent ? `${parent}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!directories.has(name)) errors.push(`Extra: ${name}`);
        extras(name);
      } else if (
        !files.has(name) &&
        name !== marker &&
        !(pristineRevision && name === '.sdk-revision')
      )
        errors.push(`Extra: ${name}`);
    }
  }
  extras();
  if (marker) {
    const path = join(directory, marker);
    if (
      !existsSync(path) ||
      !regular(path) ||
      readFileSync(path, 'utf8') !== `${JSON.stringify(identity)}\n`
    )
      errors.push(
        'Reviewed source marker differs or is missing; preserve this tree and explicitly replace the generated directory before preparing again',
      );
  }
  if (
    pristineRevision &&
    existsSync(join(directory, '.sdk-revision')) &&
    (!regular(join(directory, '.sdk-revision')) ||
      readFileSync(join(directory, '.sdk-revision'), 'utf8').trim() !==
        pristineRevision)
  )
    errors.push('Revision marker does not match CODEX_REVISION');
  if (errors.length)
    throw new Error(`Native source audit failed:\n${errors.join('\n')}`);
  return files.size;
}
function extract(repository, tree, destination, files, options = {}) {
  mkdirSync(destination);
  const tar = join(dirname(destination), 'source.tar');
  // Verify symlink targets before tar can create them. Git trees cannot contain children of symlink entries.
  for (const [name, { mode, id }] of files) {
    if (mode !== '120000') continue;
    const target = git(['-C', repository, 'cat-file', 'blob', id], options);
    if (digest('blob', target) !== id)
      throw new Error('Source symlink differs from its Git identity');
    const path = relative(
      destination,
      resolve(dirname(join(destination, name)), target.toString()),
    );
    if (
      isAbsolute(target.toString()) ||
      isAbsolute(path) ||
      path === '..' ||
      path.startsWith(`..${sep}`)
    )
      throw new Error('Source symlink escapes its destination');
  }
  git(
    [
      '-C',
      repository,
      '-c',
      'core.autocrlf=false',
      'archive',
      '--format=tar',
      `--output=${tar}`,
      tree,
    ],
    options,
  );
  const unpack = spawnSync(
    'tar',
    ['-xf', 'source.tar', '-C', relative(dirname(destination), destination)],
    {
      cwd: dirname(destination),
      env: { ...process.env, MSYS: 'winsymlinks:nativestrict' },
      stdio: 'pipe',
    },
  );
  if (unpack.error) throw unpack.error;
  if (unpack.status !== 0)
    throw new Error(`Cannot unpack native source: ${unpack.stderr}`);
  // Git archives retain old commit dates. Fresh dependency files must invalidate restored Cargo fingerprints.
  const now = new Date();
  for (const [name, { mode }] of files)
    if (mode !== '120000') utimesSync(join(destination, name), now, now);
  verifyTree(destination, files);
}
export function prepareSources(root, sources, prepare) {
  const upstream = join(root, '.upstream');
  const identities = {};
  for (const spec of sources) {
    const series = readSeries(join(root, spec.patches));
    const identity = {
      revision: spec.revision,
      result_tree: series.result_tree,
      manifest_sha256: series.manifest_sha256,
      patches: series.patches.map(({ path, sha256 }) => ({ path, sha256 })),
    };
    const repository = sourceRepository(upstream, spec);
    const baseFiles = listing(repository, spec.revision);
    const pristine = join(upstream, spec.name);
    if (existsSync(pristine) && readdirSync(pristine).length)
      verifyTree(pristine, baseFiles, { pristineRevision: spec.revision });
    // Keep all index/object writes private; the supplied repository only provides immutable objects.
    mkdirSync(upstream, { recursive: true });
    const temporary = mkdtempSync(join(upstream, 'review-'));
    try {
      const bare = join(temporary, 'objects.git');
      const objects = git([
        '-C',
        repository,
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        'objects',
      ])
        .toString()
        .trim();
      const env = {
        ...gitEnvironment(),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: objects,
      };
      const options = { env };
      git(['init', '--bare', '--quiet', bare], options);
      git(['-C', bare, 'read-tree', spec.revision], options);
      for (const patch of series.patches)
        git(['-C', bare, 'apply', '--cached', '--whitespace=nowarn', '-'], {
          ...options,
          input: patch.bytes,
        });
      const result = git(['-C', bare, 'write-tree'], options).toString().trim();
      if (result !== series.result_tree)
        throw new Error(
          'Applied source patches differ from reviewed result_tree',
        );
      const files = listing(bare, result, options);
      const destination = join(upstream, `reviewed-${spec.name}`);
      const marker = '.sdk-reviewed-source.json';
      if (existsSync(destination) && readdirSync(destination).length)
        verifyTree(destination, files, { marker, identity });
      else if (!prepare)
        throw new Error(`Reviewed source is not prepared: ${destination}`);
      else {
        const staged = join(temporary, 'tree');
        extract(bare, result, staged, files, options);
        writeFileSync(join(staged, marker), `${JSON.stringify(identity)}\n`);
        verifyTree(staged, files, { marker, identity });
        if (existsSync(destination)) rmSync(destination, { recursive: true });
        renameSync(staged, destination);
      }
      // Preserve the original pristine archive route and its refusal semantics.
      if (prepare && (!existsSync(pristine) || !readdirSync(pristine).length)) {
        const staged = join(temporary, 'base');
        extract(repository, spec.revision, staged, baseFiles);
        writeFileSync(join(staged, '.sdk-revision'), `${spec.revision}\n`);
        if (existsSync(pristine)) rmSync(pristine, { recursive: true });
        renameSync(staged, pristine);
      }
      identities[spec.name] = identity;
      console.log(
        `Verified ${files.size} ${spec.name} source files at reviewed tree ${result}`,
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  return identities;
}
