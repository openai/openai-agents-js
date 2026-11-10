// Copied into an extracted starter so every SDK import resolves as a consumer.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Agent, Environment, NativeProvider, tool } from '@openai/agents';
import { z } from 'zod';

const execute = promisify(execFile);
const directory = await realpath(process.cwd());
const require = createRequire(join(directory, 'package.json'));
const receipt = JSON.parse(await readFile('verification-build.json', 'utf8'));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const core = require.resolve('@openai/agents-core');
const names = Object.keys(receipt.packages);
const installed = {};
for (const name of names) {
  const root = await realpath(join(directory, 'node_modules', name));
  assert(root.startsWith(directory + sep), `${name} resolves outside consumer`);
  installed[name] = root;
  const manifest = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  );
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, receipt.packages[name].version);
  assert.equal(
    createRequire(join(root, 'package.json')).resolve('@openai/agents-core'),
    core,
  );
  const loaded = require(name);
  const imported = await import(name);
  assert(Object.keys(loaded).length > 0 && Object.keys(imported).length > 0);
}
const locked = [];
for (const [path, entry] of Object.entries(lock.packages)) {
  const name = path.slice(
    path.lastIndexOf('node_modules/') + 'node_modules/'.length,
  );
  if (!names.includes(name)) continue;
  const archive = receipt.packages[name];
  assert.equal(path, `node_modules/${name}`, 'Duplicate SDK package');
  assert(
    !entry.link && entry.resolved?.startsWith('file:'),
    'Registry SDK substitution',
  );
  assert.equal(
    resolve(directory, entry.resolved.slice(5)),
    join(directory, 'vendor/agents', archive.archive),
  );
  assert.equal(entry.integrity, archive.integrity);
  assert.equal(entry.version, archive.version);
  locked.push(name);
}
assert.deepEqual(locked.sort(), names.sort());

// Each facade export must retain the runtime owner's object identity in both
// module systems, including constructors, symbols, and experimental helpers.
for (const esm of [false, true]) {
  for (const suffix of [
    '',
    '/testing',
    '/experimental/deferred',
    '/experimental/mcp-tasks',
    '/a2a',
    '/memory',
    '/artifacts',
    '/ui',
    '/mcp-apps',
  ]) {
    const facade = esm
      ? await import(`@openai/agents${suffix}`)
      : require(`@openai/agents${suffix}`);
    const runtime = esm
      ? await import(`@openai/agents-codex${suffix}`)
      : require(`@openai/agents-codex${suffix}`);
    const keys = (module) =>
      Object.keys(module)
        .filter((key) => key !== 'default')
        .sort();
    assert.deepEqual(
      keys(facade),
      keys(runtime),
      `Forwarded exports: ${suffix}`,
    );
    for (const key of keys(runtime))
      assert.equal(
        facade[key],
        runtime[key],
        `Forwarded identity: ${suffix}:${key}`,
      );
  }
}
const facadeRoot = installed['@openai/agents'];
const agentRoot = installed['@openai/agents-codex'];
for (const path of ['native', 'bin', 'licenses']) {
  await access(join(agentRoot, path));
}
for (const path of ['bin', 'licenses']) {
  await assert.rejects(lstat(join(facadeRoot, path)), {
    code: 'ENOENT',
  });
}

const portableWasm = 'codex-realtime-control.wasm';
const portableReceiptFile = 'portable-build-receipt.json';
const facadeNative = join(facadeRoot, 'native');
assert(
  (await lstat(facadeNative)).isDirectory(),
  'Invalid facade native directory',
);
assert.deepEqual(
  (await readdir(facadeNative)).sort(),
  [portableWasm, portableReceiptFile],
  'Unexpected facade native inventory',
);
const portableReceipts = [];
for (const name of ['@openai/agents', '@openai/agents-codex']) {
  const wasm = join(installed[name], 'native', portableWasm);
  const receiptFile = join(installed[name], 'native', portableReceiptFile);
  for (const file of [wasm, receiptFile]) {
    assert((await lstat(file)).isFile(), `Expected a regular file: ${file}`);
  }
  const specifier = `${name}/voice/control.wasm`;
  assert.equal(require.resolve(specifier), wasm, `CJS export: ${specifier}`);
  assert.equal(
    import.meta.resolve(specifier),
    pathToFileURL(wasm).href,
    `ESM export: ${specifier}`,
  );
  const portableReceipt = JSON.parse(await readFile(receiptFile, 'utf8'));
  assert.equal(portableReceipt.format, 'reviewed-portable-realtime-v1');
  assert.equal(
    portableReceipt.sourceIdentity?.codex?.revision,
    receipt.codexRevision,
  );
  assert.equal(portableReceipt.target, 'wasm32-unknown-unknown');
  assert.equal(portableReceipt.artifact?.path, portableWasm);
  assert.equal(
    createHash('sha256')
      .update(await readFile(wasm))
      .digest('hex'),
    portableReceipt.artifact.sha256,
    `Changed portable Wasm: ${name}`,
  );
  portableReceipts.push(portableReceipt);
}
assert.deepEqual(
  portableReceipts[0],
  portableReceipts[1],
  'Portable Realtime receipts disagree',
);

const native = require(join(agentRoot, 'native/index.js'));
assert.equal(native.CODEX_REVISION, receipt.codexRevision);
assert.equal(
  (await readFile(join(agentRoot, 'native/CODEX_REVISION'), 'utf8')).trim(),
  receipt.codexRevision,
);
assert.equal(typeof native.create_engine, 'function');
assert.equal(typeof native.create_checkpoint_engine, 'function');
const nativeReceipt = JSON.parse(
  await readFile(join(agentRoot, 'native/build-receipt.json'), 'utf8'),
);
assert.equal(nativeReceipt.format, 'reviewed-native-v1');
assert.equal(nativeReceipt.release, true);
const helpers = Object.values(native._packaged_runtime());
assert.equal(
  helpers.length,
  process.platform === 'linux' ? 4 : process.platform === 'win32' ? 2 : 3,
);
for (const [path, expected] of Object.entries(nativeReceipt.products)) {
  const file = resolve(agentRoot, path);
  assert(
    file.startsWith(agentRoot + sep),
    'Native receipt path leaves package',
  );
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  assert.equal(
    `sha256:${hash.digest('hex')}`,
    expected,
    `Changed native product ${path}`,
  );
}
for (const file of [join(agentRoot, 'native/codex.node'), ...helpers]) {
  assert(
    Object.hasOwn(
      nativeReceipt.products,
      file.slice(agentRoot.length + 1).replaceAll('\\', '/'),
    ),
  );
}
for (const helper of helpers) {
  try {
    const probe = execute(helper, ['--help'], { timeout: 10_000 });
    // The Code Mode helper reads stdin until the stream closes.
    probe.child.stdin.end();
    await probe;
  } catch (error) {
    // Argument wrappers may reject --help; an ordinary usage error still proves
    // that the packaged executable and its dynamic libraries can start.
    assert(
      [1, 2].includes(error.code) && !error.signal,
      `Helper failed to start: ${helper}: ${error.message}`,
    );
  }
}

const message = (text) => ({
  type: 'message',
  id: 'answer',
  role: 'assistant',
  content: [{ type: 'output_text', text }],
});
async function withModel(responses, run) {
  const requests = [];
  const failures = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/responses');
      assert.equal(request.headers.authorization, 'Bearer synthetic-alpha-key');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const script = responses[requests.length];
      requests.push(body);
      assert(script, 'Unexpected model request');
      const output = typeof script === 'function' ? script(body) : script;
      const id = `response-${requests.length}`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { type: 'response.created', response: { id } },
        ...output.map((item, output_index) => ({
          type: 'response.output_item.done',
          output_index,
          item,
        })),
        { type: 'response.completed', response: { id, output } },
      ])
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end();
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end('Synthetic model verification failed');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const result = await run(`http://127.0.0.1:${server.address().port}/v1`);
    assert.deepEqual(failures, []);
    assert.equal(requests.length, responses.length);
    return result;
  } finally {
    server.closeAllConnections();
    await new Promise((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    );
  }
}

await withModel(
  [
    [
      {
        type: 'function_call',
        call_id: 'greeting-1',
        name: 'greeting',
        arguments: '{"name":"Ada"}',
      },
    ],
    (request) => {
      assert(
        request.input.some(
          (item) =>
            item.type === 'function_call_output' &&
            item.call_id === 'greeting-1' &&
            item.output === 'Hello, Ada!',
        ),
      );
      return [message('Hello from the alpha verification!')];
    },
  ],
  async (baseUrl) => {
    const { stdout } = await execute(process.execPath, ['hello.mjs'], {
      cwd: directory,
      timeout: 30_000,
      env: {
        ...process.env,
        OPENAI_API_KEY: 'synthetic-alpha-key',
        OPENAI_BASE_URL: baseUrl,
      },
    });
    assert.equal(stdout.trim(), 'Hello from the alpha verification!');
  },
);

const calls = [];
await withModel(
  [
    [
      {
        type: 'function_call',
        call_id: 'sum-1',
        name: 'sum',
        arguments: '{"a":19,"b":23}',
      },
    ],
    (request) => {
      assert(
        request.input.some(
          (item) =>
            item.type === 'function_call_output' &&
            item.call_id === 'sum-1' &&
            item.output === '42',
        ),
      );
      assert.deepEqual(calls, [[19, 23]]);
      return [message('The answer is 42.')];
    },
    [message('The same session answered again.')],
  ],
  async (baseUrl) => {
    const provider = new NativeProvider({
      baseUrl,
      apiKey: 'synthetic-alpha-key',
      supportsWebsockets: false,
    });
    try {
      const agent = new Agent({
        instructions: 'Use sum and report the result.',
        model: 'gpt-5',
        provider,
        tools: [
          tool({
            name: 'sum',
            parameters: z.strictObject({ a: z.number(), b: z.number() }),
            async execute({ a, b }) {
              calls.push([a, b]);
              return a + b;
            },
          }),
        ],
      });
      const session = await agent.session();
      try {
        assert.equal(
          (await (await session.submit('Add 19 and 23.')).wait()).finalOutput,
          'The answer is 42.',
        );
        assert.equal(
          (await (await session.submit('Answer again.')).wait()).finalOutput,
          'The same session answered again.',
        );
      } finally {
        await session.close();
      }
    } finally {
      await provider.close();
    }
  },
);

if (receipt.platform === 'linux-arm64') {
  assert.equal(`${process.platform}-${process.arch}`, receipt.platform);
  const proof = process.argv[2];
  assert(proof, 'Missing local sandbox proof path');
  const temporary = await mkdtemp(join(tmpdir(), 'agents-alpha-sandbox-'));
  try {
    const root = await realpath(temporary);
    const cwd = join(root, 'workspace');
    const writable = join(root, 'writable');
    const sentinel = join(root, 'sentinel');
    await mkdir(cwd);
    await mkdir(writable);
    await writeFile(sentinel, 'protected');
    const callId = 'sandbox-write';
    await withModel(
      [
        [
          {
            type: 'function_call',
            call_id: callId,
            name: 'exec_command',
            arguments: JSON.stringify({
              cmd: 'command -v dd >/dev/null || exit 1; if (printf overwritten | dd of=../sentinel conv=nocreat status=none) 2>/dev/null; then exit 1; fi; printf granted > ../writable/proof.txt',
              workdir: cwd,
            }),
          },
        ],
        [message('Sandbox command finished.')],
      ],
      async (baseUrl) => {
        const provider = new NativeProvider({
          baseUrl,
          apiKey: 'synthetic-alpha-key',
          supportsWebsockets: false,
        });
        try {
          const agent = new Agent({
            instructions:
              'Use the local command tool to verify the write grant.',
            model: 'gpt-5',
            provider,
          });
          const session = await agent.session({
            environment: Environment.local({
              cwd,
              tools: ['exec_command'],
              writableRoots: [writable],
            }),
          });
          try {
            const turn = await session.submit('Check the local write grant.');
            assert.equal(
              (await turn.wait()).finalOutput,
              'Sandbox command finished.',
            );
            const command = (await Array.fromAsync(session.items())).find(
              (item) =>
                item.type === 'command_execution' && item.callId === callId,
            );
            assert.equal(
              command?.status,
              'completed',
              'Missing completed sandbox command',
            );
            assert.equal(command.exitCode, 0, 'Sandbox command failed');
            assert.deepEqual(
              await readFile(join(writable, 'proof.txt')),
              Buffer.from('granted'),
            );
            assert.deepEqual(
              await readFile(sentinel),
              Buffer.from('protected'),
            );
          } finally {
            await session.close();
          }
        } finally {
          await provider.close();
        }
      },
    );
    await writeFile(proof, '', { flag: 'wx' });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

for (const esm of [false, true]) {
  const classic = esm
    ? await import('@openai/agents/classic')
    : require('@openai/agents/classic');
  const testing = esm
    ? await import('@openai/agents/classic/testing')
    : require('@openai/agents/classic/testing');
  const owner = esm
    ? await import('@openai/agents-core')
    : require('@openai/agents-core');
  assert.equal(classic.Agent, owner.Agent);
  classic.setTracingDisabled(true);
  const model = new testing.ScriptedModel([
    testing.modelResponse([testing.assistantMessage('first')]),
    testing.modelResponse([testing.assistantMessage('second')]),
  ]);
  const session = new classic.MemorySession({ sessionId: esm ? 'esm' : 'cjs' });
  const agent = new classic.Agent({ name: 'packed', model });
  const runner = new classic.Runner({ tracingDisabled: true });
  assert.equal(
    (await runner.run(agent, 'one', { session })).finalOutput,
    'first',
  );
  assert.equal(
    (await runner.run(agent, 'two', { session })).finalOutput,
    'second',
  );
  assert.equal((await session.getItems()).length, 4);
  assert.equal(model.calls.length, 2);
}
console.log(
  'Verified local SDK locks, CJS/ESM imports, native products/helpers, forwarded facade exports, runtime payload ownership, portable Realtime exports and receipts, bundled hello, native tool/sessions, and classic sessions.',
);
