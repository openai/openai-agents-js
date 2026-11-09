import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { URL } from 'node:url';
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from 'node:worker_threads';

async function startReader() {
  const native = createRequire(import.meta.url)(workerData.module);
  const config = {
    approval_policy: 'never',
    sandbox_mode: 'danger-full-access',
    web_search: 'disabled',
    'analytics.enabled': false,
    'features.shell_snapshot': false,
    model_provider: 'pending_borrow_probe',
    model_providers: {
      pending_borrow_probe: {
        name: 'PendingBorrowProbe',
        base_url: 'http://127.0.0.1:1/v1',
        wire_api: 'responses',
        requires_openai_auth: false,
        supports_websockets: false,
      },
    },
  };
  const runtime = {
    ...native._packaged_runtime(),
    codex_home: workerData.home,
    cwd: workerData.cwd,
    strict_config: true,
    loader: {
      managed_config_path: join(workerData.home, 'managed.toml'),
      system_config_path: join(workerData.home, 'system.toml'),
      system_requirements_path: join(workerData.home, 'requirements.toml'),
      ignore_user_config: true,
      ignore_project_config: true,
    },
  };
  const engine = await native.create_engine(
    JSON.stringify(config),
    JSON.stringify(runtime),
    'synthetic-reader-test-key',
  );
  const thread = await engine.start_replaceable_thread('{}', '[]');
  assert.equal(thread._enable_native_interception(30, 'root'), true);
  thread._configure_native_interception('[]');
  const pending = thread._next_native_interception();
  let settled = false;
  void pending.then(
    (value) => {
      settled = true;
      parentPort.postMessage({ kind: 'unexpected-settlement', value });
    },
    (error) => {
      settled = true;
      parentPort.postMessage({
        kind: 'unexpected-settlement',
        error: String(error),
      });
    },
  );
  await Promise.resolve();
  assert.equal(settled, false);
  // Keep the receiver, owners and pending read alive; only the parent terminates this Worker.
  globalThis.__pendingNativeReader = { native, engine, thread, pending };
  parentPort.postMessage({ kind: 'ready' });
}

async function terminateReader() {
  const require = createRequire(import.meta.url);
  const loadedAddons = () =>
    Object.keys(require.cache).filter((path) => path.endsWith('.node'));
  assert.deepEqual(loadedAddons(), []);
  const worker = new Worker(new URL(import.meta.url), {
    workerData: {
      module: process.argv[2],
      home: process.argv[3],
      cwd: process.argv[4],
    },
    execArgv: [],
    stdout: true,
    stderr: true,
  });
  worker.stdout.pipe(process.stderr);
  worker.stderr.pipe(process.stderr);
  let rejectReady, resolveReady, timer, workerError, unexpected, termination;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const exit = new Promise((resolve) =>
    worker.once('exit', (code) => {
      rejectReady(new Error('Worker exited before readiness'));
      resolve(code);
    }),
  );
  worker.on('error', (error) => {
    workerError = error;
    rejectReady(error);
  });
  worker.on('message', (message) => {
    if (message.kind === 'ready') resolveReady();
    else {
      unexpected = message;
      rejectReady(new Error(JSON.stringify(message)));
    }
  });
  const terminate = () => (termination ??= worker.terminate());
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Pending reader readiness deadline')),
          20_000,
        );
      }),
    ]);
    clearTimeout(timer);
    const returned = await Promise.race([
      terminate(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Worker termination deadline')),
          10_000,
        );
      }),
    ]);
    const code = await exit;
    assert.equal(workerError, undefined);
    assert.equal(unexpected, undefined);
    assert.equal(returned, 1);
    assert.equal(code, 1);
    assert.deepEqual(loadedAddons(), []);
    process.stdout.write(
      JSON.stringify({
        hostSurvived: true,
        workerExit: code,
      }) + '\n',
    );
  } finally {
    clearTimeout(timer);
    await terminate();
    await exit;
  }
}

if (isMainThread) {
  terminateReader().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  startReader().catch((error) => {
    parentPort.postMessage({ kind: 'setup-failure', error: String(error) });
  });
}
