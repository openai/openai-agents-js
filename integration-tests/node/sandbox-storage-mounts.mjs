// @ts-check

import {
  Manifest,
  azureBlobMount,
  inContainerMountStrategy,
  mountPattern,
  s3Mount,
} from '@openai/agents/sandbox';
import { DockerSandboxClient } from '@openai/agents/sandbox/local';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const mountImage =
  process.env.SANDBOX_STORAGE_MOUNT_IMAGE ??
  'openai-agents-js-storage-mount-smoke:local';
const azuriteImage =
  process.env.SANDBOX_STORAGE_AZURITE_IMAGE ??
  'mcr.microsoft.com/azure-storage/azurite';
const minioImage =
  process.env.SANDBOX_STORAGE_MINIO_IMAGE ?? 'minio/minio:latest';

const azureAccountName = 'devstoreaccount1';
const azureAccountKey =
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
const azureContainer = 'azurite-smoke';

const s3Bucket = 'minio-smoke';
const s3AccessKeyId = 'minioadmin';
const s3SecretAccessKey = 'minioadmin';

const startedContainers = new Set();

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    input: options.input,
    encoding: 'utf8',
    stdio: options.capture
      ? ['pipe', 'pipe', 'pipe']
      : ['pipe', 'inherit', 'inherit'],
    env: process.env,
    timeout: options.timeoutMs,
  });
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? `\n${result.stderr}` : '';
    throw new Error(`${command} ${args.join(' ')} failed.${detail}`);
  }
  return result.stdout ?? '';
}

function ensureMountImage() {
  const inspect = spawnSync('docker', ['image', 'inspect', mountImage], {
    stdio: 'ignore',
  });
  if (inspect.status === 0) {
    return;
  }
  runCommand('docker', [
    'build',
    '-t',
    mountImage,
    '-f',
    'sandbox-storage-mounts.Dockerfile',
    '.',
  ]);
}

function startContainer(args) {
  const name = args.namePrefix + randomUUID().slice(0, 8);
  runCommand('docker', ['run', '-d', '--name', name, ...args.runArgs], {
    timeoutMs: 120_000,
  });
  startedContainers.add(name);
  const ipAddress = runCommand(
    'docker',
    [
      'inspect',
      '-f',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      name,
    ],
    { capture: true },
  ).trim();
  if (!ipAddress) {
    throw new Error(`Could not resolve container IP address for ${name}.`);
  }
  return { name, ipAddress };
}

function cleanupContainers() {
  for (const name of [...startedContainers].reverse()) {
    runCommand('docker', ['rm', '-f', name], { allowFailure: true });
    startedContainers.delete(name);
  }
}

function runRclone(args, options = {}) {
  return runCommand(
    'docker',
    ['run', '--rm', '-i', mountImage, 'rclone', ...args],
    {
      ...options,
      timeoutMs: options.timeoutMs ?? 30_000,
    },
  );
}

function azureRcloneArgs(endpoint, args) {
  return [
    '--contimeout',
    '5s',
    '--timeout',
    '10s',
    '--retries',
    '1',
    '--low-level-retries',
    '1',
    ...args,
    '--azureblob-account',
    azureAccountName,
    '--azureblob-key',
    azureAccountKey,
    '--azureblob-endpoint',
    endpoint,
    '--azureblob-use-emulator',
  ];
}

function s3RcloneArgs(endpoint, args) {
  return [
    '--contimeout',
    '5s',
    '--timeout',
    '10s',
    '--retries',
    '1',
    '--low-level-retries',
    '1',
    ...args,
    '--s3-provider',
    'Minio',
    '--s3-access-key-id',
    s3AccessKeyId,
    '--s3-secret-access-key',
    s3SecretAccessKey,
    '--s3-endpoint',
    endpoint,
    '--s3-region',
    'us-east-1',
  ];
}

async function waitForRclone(args) {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const result = spawnSync(
      'docker',
      ['run', '--rm', mountImage, 'rclone', ...args],
      {
        stdio: 'ignore',
        timeout: 10_000,
      },
    );
    if (result.status === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Storage emulator did not become ready.');
}

async function startAzurite() {
  const container = startContainer({
    namePrefix: 'oaajs-azurite-',
    runArgs: [azuriteImage, 'azurite-blob', '--blobHost', '0.0.0.0'],
  });
  const endpoint = `http://${container.ipAddress}:10000/${azureAccountName}`;
  await waitForRclone(
    azureRcloneArgs(endpoint, ['mkdir', `:azureblob:${azureContainer}`]),
  );
  return endpoint;
}

async function startMinio() {
  const container = startContainer({
    namePrefix: 'oaajs-minio-',
    runArgs: [
      '-e',
      `MINIO_ROOT_USER=${s3AccessKeyId}`,
      '-e',
      `MINIO_ROOT_PASSWORD=${s3SecretAccessKey}`,
      minioImage,
      'server',
      '/data',
      '--address',
      ':9000',
      '--console-address',
      ':9001',
    ],
  });
  const endpoint = `http://${container.ipAddress}:9000`;
  await waitForRclone(s3RcloneArgs(endpoint, ['mkdir', `:s3:${s3Bucket}`]));
  return endpoint;
}

async function smokeAzureBlobMount() {
  const endpoint = await startAzurite();
  runRclone(
    azureRcloneArgs(endpoint, [
      'rcat',
      `:azureblob:${azureContainer}/from-host.txt`,
    ]),
    { input: 'hello from host\n' },
  );
  const prepared = runRclone(
    azureRcloneArgs(endpoint, [
      'cat',
      `:azureblob:${azureContainer}/from-host.txt`,
    ]),
    { capture: true },
  );
  if (prepared !== 'hello from host\n') {
    throw new Error(`Azurite preparation readback failed: ${prepared}`);
  }

  const manifest = new Manifest({
    entries: {
      azure: azureBlobMount({
        container: azureContainer,
        accountName: azureAccountName,
        accountKey: azureAccountKey,
        endpointUrl: endpoint,
        readOnly: false,
        mountStrategy: inContainerMountStrategy({
          pattern: mountPattern({
            type: 'rclone',
            mode: 'fuse',
            args: [
              '--azureblob-use-emulator',
              '--contimeout',
              '5s',
              '--timeout',
              '10s',
              '--retries',
              '1',
              '--low-level-retries',
              '1',
            ],
          }),
        }),
      }),
    },
  });

  const client = new DockerSandboxClient({ image: mountImage });
  const session = await client.create(manifest);
  try {
    const result = await session.execCommand?.({
      cmd: [
        'set -e',
        'cat azure/from-host.txt',
        'printf "hello from sandbox\\n" > azure/from-sandbox.txt',
        'sync',
        'sleep 2',
        'cat azure/from-sandbox.txt',
      ].join(' && '),
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 20_000,
      maxOutputTokens: 4000,
    });
    const output = typeof result === 'string' ? result : result?.output;
    if (
      !output?.includes('hello from host') ||
      !output.includes('hello from sandbox')
    ) {
      throw new Error(`Unexpected Azure Blob mount output: ${String(output)}`);
    }
  } finally {
    await session.close?.();
  }

  const downloaded = runRclone(
    azureRcloneArgs(endpoint, [
      'cat',
      `:azureblob:${azureContainer}/from-sandbox.txt`,
    ]),
    { capture: true },
  );
  if (downloaded !== 'hello from sandbox\n') {
    throw new Error(`Azurite sandbox write readback failed: ${downloaded}`);
  }
}

async function smokeS3Mount() {
  const endpoint = await startMinio();
  runRclone(s3RcloneArgs(endpoint, ['rcat', `:s3:${s3Bucket}/from-host.txt`]), {
    input: 'hello from host\n',
  });
  const prepared = runRclone(
    s3RcloneArgs(endpoint, ['cat', `:s3:${s3Bucket}/from-host.txt`]),
    { capture: true },
  );
  if (prepared !== 'hello from host\n') {
    throw new Error(`MinIO preparation readback failed: ${prepared}`);
  }

  const manifest = new Manifest({
    entries: {
      s3: s3Mount({
        bucket: s3Bucket,
        endpointUrl: endpoint,
        s3Provider: 'Minio',
        region: 'us-east-1',
        accessKeyId: s3AccessKeyId,
        secretAccessKey: s3SecretAccessKey,
        readOnly: false,
        mountStrategy: inContainerMountStrategy({
          pattern: mountPattern({
            type: 'rclone',
            mode: 'fuse',
            args: [
              '--contimeout',
              '5s',
              '--timeout',
              '10s',
              '--retries',
              '1',
              '--low-level-retries',
              '1',
            ],
          }),
        }),
      }),
    },
  });

  const client = new DockerSandboxClient({ image: mountImage });
  const session = await client.create(manifest);
  try {
    const result = await session.execCommand?.({
      cmd: [
        'set -e',
        'cat s3/from-host.txt',
        'printf "hello from sandbox\\n" > s3/from-sandbox.txt',
        'sync',
        'sleep 2',
        'cat s3/from-sandbox.txt',
      ].join(' && '),
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 20_000,
      maxOutputTokens: 4000,
    });
    const output = typeof result === 'string' ? result : result?.output;
    if (
      !output?.includes('hello from host') ||
      !output.includes('hello from sandbox')
    ) {
      throw new Error(`Unexpected S3 mount output: ${String(output)}`);
    }
  } finally {
    await session.close?.();
  }

  const downloaded = runRclone(
    s3RcloneArgs(endpoint, ['cat', `:s3:${s3Bucket}/from-sandbox.txt`]),
    { capture: true },
  );
  if (downloaded !== 'hello from sandbox\n') {
    throw new Error(`MinIO sandbox write readback failed: ${downloaded}`);
  }
}

try {
  ensureMountImage();
  await smokeAzureBlobMount();
  console.log('[STORAGE_MOUNT_RESPONSE]azure:ok[/STORAGE_MOUNT_RESPONSE]');
  await smokeS3Mount();
  console.log('[STORAGE_MOUNT_RESPONSE]s3:ok[/STORAGE_MOUNT_RESPONSE]');
} finally {
  cleanupContainers();
}
