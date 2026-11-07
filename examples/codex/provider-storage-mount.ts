/**
 * Run with OPENAI_API_KEY, STORAGE_BUCKET and NATIVE_EXECUTOR_CONNECTOR set.
 * The connector module exports connect(sandbox, { signal }) and provisions an
 * authenticated native executor gateway for that exact provider session.
 * Docker needs a configured rclone volume driver; this example installs none.
 */
import { pathToFileURL } from 'node:url';
import { Agent, NativeProvider } from '@openai/agents';
import {
  Manifest,
  s3Mount,
  dockerVolumeMountStrategy,
  sandboxEnvironment,
  renderStorageLayout,
  type SandboxEnvironmentOptions,
} from '@openai/agents/sandbox';
import { DockerSandboxClient } from '@openai/agents/sandbox/local';

export async function main(connect: SandboxEnvironmentOptions['connect']) {
  const bucket = process.env.STORAGE_BUCKET;
  if (!bucket) throw new Error('Set STORAGE_BUCKET to an existing S3 bucket.');
  const manifest = new Manifest({
    entries: {
      reference: s3Mount({
        bucket,
        region: process.env.AWS_REGION,
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN,
        mountStrategy: dockerVolumeMountStrategy({ driver: 'rclone' }),
        description: 'Reference data; read files to answer the question.',
      }),
    },
  });
  const environment = sandboxEnvironment({
    client: new DockerSandboxClient(),
    manifest,
    connect,
    options: { image: process.env.SANDBOX_IMAGE ?? 'python:3.14-slim' },
  });
  await using provider = new NativeProvider();
  const agent = new Agent({
    provider,
    model: process.env.OPENAI_MODEL ?? 'gpt-5',
    instructions: `Use the configured filesystem.\n${renderStorageLayout(manifest)}`,
  });
  const result = await agent.run(
    'List the available reference files and summarize their purpose.',
    { environment },
  );
  return result.finalOutput;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const connector = process.env.NATIVE_EXECUTOR_CONNECTOR;
  if (!connector)
    throw new Error(
      'Set NATIVE_EXECUTOR_CONNECTOR to your gateway connector module path.',
    );
  const { connect } = await import(pathToFileURL(connector).href);
  if (typeof connect !== 'function')
    throw new Error('The connector module must export connect.');
  console.log(await main(connect));
}
