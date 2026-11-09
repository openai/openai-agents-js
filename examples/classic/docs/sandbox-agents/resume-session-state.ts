import { Manifest } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';

const manifest = new Manifest();
const client = new UnixLocalSandboxClient({
  snapshot: { type: 'local', baseDir: '/tmp/my-sandbox-snapshots' },
});

const session = await client.create({ manifest });
const state = await client.serializeSessionState?.(session.state);
// Retain this binding in trusted application storage, separately from saved state.
const resumeAuthority = {
  workspaceRootPath: session.state.workspaceRootPath,
  workspaceRootOwned: true,
  localSnapshotPath:
    session.state.snapshot?.type === 'local'
      ? session.state.snapshot.path
      : undefined,
};
await session.close?.();

if (state) {
  const restored = await client.resume?.(
    await client.deserializeSessionState!(state),
    { clientOptions: { resumeAuthority } },
  );
  await restored?.close?.();
}
