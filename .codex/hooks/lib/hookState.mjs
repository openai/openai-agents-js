import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function stateDir() {
  return path.join(tmpdir(), 'openai-agents-js-codex-hooks');
}

function statePath(sessionId, cwd) {
  const rootHash = createHash('sha256').update(cwd).digest('hex').slice(0, 12);
  const safeSessionId = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(stateDir(), `${safeSessionId}-${rootHash}.json`);
}

export function loadState(sessionId, cwd) {
  const filePath = statePath(sessionId, cwd);
  if (!existsSync(filePath)) {
    return {
      last_tidy_fingerprint: null,
    };
  }

  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return {
      last_tidy_fingerprint: null,
    };
  }
}

export function saveState(sessionId, cwd, state) {
  const filePath = statePath(sessionId, cwd);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2));
}
