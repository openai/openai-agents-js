import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

function parseArguments(args) {
  const separator = args.indexOf('--');
  const options = separator === -1 ? args : args.slice(0, separator);
  const runnerArguments = separator === -1 ? [] : args.slice(separator + 1);
  const values = new Map();

  for (let index = 0; index < options.length; index += 2) {
    const name = options[index];
    const value = options[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error('Invalid background supervisor arguments.');
    }
    values.set(name, value);
  }

  const required = ['--token', '--pid-file', '--script', '--log'];
  for (const name of required) {
    if (!values.get(name)) {
      throw new Error(`Missing required argument: ${name}.`);
    }
  }

  return {
    token: values.get('--token'),
    pidFile: values.get('--pid-file'),
    script: values.get('--script'),
    log: values.get('--log'),
    runnerArguments,
  };
}

async function waitForOwnership(pidFile, token, timeoutMs = 5_000) {
  const expected = `${process.pid} ${token} pending`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if ((await readFile(pidFile, 'utf8')).trim() === expected) {
        return;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
    await delay(25);
  }

  throw new Error('Timed out waiting for the background ownership file.');
}

async function removeOwnedPidFile(pidFile, token) {
  try {
    const ownedPrefix = `${process.pid} ${token} `;
    if ((await readFile(pidFile, 'utf8')).trim().startsWith(ownedPrefix)) {
      await rm(pidFile);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

function exitStatus(code, signal) {
  if (Number.isInteger(code)) {
    return code;
  }
  return signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
}

export async function runBackgroundSupervisor({
  token,
  pidFile,
  script,
  log,
  runnerArguments,
  environment = process.env,
} = {}) {
  await waitForOwnership(pidFile, token);

  const child = spawn(
    '/bin/bash',
    [script, '__background_worker', log, ...runnerArguments],
    {
      detached: true,
      env: environment,
      stdio: 'ignore',
    },
  );
  const childResult = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let stopPromise;

  const stopChildGroup = () => {
    if (!stopPromise) {
      stopPromise = (async () => {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch (error) {
          if (error?.code !== 'ESRCH') {
            throw error;
          }
          return;
        }

        const exited = await Promise.race([
          childResult.then(() => true),
          delay(5_000).then(() => false),
        ]);
        if (!exited) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if (error?.code !== 'ESRCH') {
              throw error;
            }
          }
        }
      })();
    }
    return stopPromise;
  };

  let receivedSignal = null;
  const listeners = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const listener = () => {
      receivedSignal ??= signal;
      void stopChildGroup();
    };
    listeners.set(signal, listener);
    process.once(signal, listener);
  }
  await writeFile(pidFile, `${process.pid} ${token} ready\n`, 'utf8');

  try {
    const result = await childResult;
    await stopPromise;
    if (receivedSignal) {
      return 0;
    }
    return exitStatus(result.code, result.signal);
  } finally {
    for (const [signal, listener] of listeners) {
      process.removeListener(signal, listener);
    }
    await removeOwnedPidFile(pidFile, token);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runBackgroundSupervisor(parseArguments(process.argv.slice(2)))
    .then((status) => {
      process.exitCode = status;
    })
    .catch(async (error) => {
      process.stderr.write(
        `Background example supervisor failed: ${error.message}\n`,
      );
      process.exitCode = 1;
    });
}
