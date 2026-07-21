import {
  VercelCloudBucketMountStrategy,
  VercelSandboxClient,
} from '@openai/agents-extensions/sandbox/vercel';
import { Manifest, s3Mount } from '@openai/agents/sandbox';

const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
if (!accessKeyId || !secretAccessKey) {
  throw new Error('AWS credentials are required.');
}

const manifest = new Manifest({
  entries: {
    'reference-data': s3Mount({
      bucket: 'my-agent-data',
      prefix: 'reference/',
      region: 'us-east-1',
      accessKeyId,
      secretAccessKey,
      sessionToken: process.env.AWS_SESSION_TOKEN,
      readOnly: true,
      mountStrategy: new VercelCloudBucketMountStrategy(),
    }),
  },
});

const client = new VercelSandboxClient({
  allowS3CredentialExposure: true,
});
const session = await client.create(manifest);

try {
  await session.execCommand({ cmd: 'ls -la reference-data' });
} finally {
  await session.close();
}
