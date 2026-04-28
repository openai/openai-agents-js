import { Manifest } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';

const manifest = new Manifest();
const client = new UnixLocalSandboxClient({
  snapshot: { type: 'local', baseDir: '/tmp/my-sandbox-snapshots' },
});

const session = await client.create({ manifest });
const state = await client.serializeSessionState?.(session.state);
await session.close?.();

if (state) {
  const restored = await client.resume?.(
    await client.deserializeSessionState!(state),
  );
  await restored?.close?.();
}
