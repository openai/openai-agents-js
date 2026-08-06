import { homedir, tmpdir } from 'node:os';
import { posix, win32 } from 'node:path';

function isAbsoluteWindowsPath(value: string): boolean {
  const root = win32.parse(value).root;
  return win32.isAbsolute(value) && root.length > 1;
}

export function defaultLocalSnapshotBaseDir(): string {
  const configured = process.env.OPENAI_AGENTS_SANDBOX_SNAPSHOT_DIR?.trim();
  if (configured) {
    return configured;
  }

  const home = homedir();
  if (process.platform === 'darwin' && home) {
    return posix.join(
      home,
      'Library',
      'Application Support',
      'openai-agents-js',
      'sandbox-snapshots',
    );
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    return win32.join(
      localAppData && isAbsoluteWindowsPath(localAppData)
        ? localAppData
        : home
          ? win32.join(home, 'AppData', 'Local')
          : tmpdir(),
      'openai-agents-js',
      'sandbox-snapshots',
    );
  }

  const stateHome = process.env.XDG_STATE_HOME?.trim();
  return posix.join(
    stateHome && posix.isAbsolute(stateHome)
      ? stateHome
      : home
        ? posix.join(home, '.local', 'state')
        : tmpdir(),
    'openai-agents-js',
    'sandbox-snapshots',
  );
}
