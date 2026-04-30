import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export function defaultLocalSnapshotBaseDir(): string {
  const configured = process.env.OPENAI_AGENTS_SANDBOX_SNAPSHOT_DIR?.trim();
  if (configured) {
    return configured;
  }

  const home = homedir();
  if (process.platform === 'darwin' && home) {
    return join(
      home,
      'Library',
      'Application Support',
      'openai-agents-js',
      'sandbox-snapshots',
    );
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    return join(
      localAppData || (home ? join(home, 'AppData', 'Local') : tmpdir()),
      'openai-agents-js',
      'sandbox-snapshots',
    );
  }

  const stateHome = process.env.XDG_STATE_HOME?.trim();
  return join(
    stateHome || (home ? join(home, '.local', 'state') : tmpdir()),
    'openai-agents-js',
    'sandbox-snapshots',
  );
}
