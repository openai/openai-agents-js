#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stdout } from 'node:process';
import { fingerprintForPaths, gitRoot } from './lib/gitState.mjs';
import { loadState, saveState } from './lib/hookState.mjs';
import { MAX_LINT_FIX_FILES, lintFixPaths } from './lib/stopTidyPolicy.mjs';

function writeStopBlock(reason, systemMessage) {
  stdout.write(
    JSON.stringify({
      decision: 'block',
      reason,
      systemMessage,
    }),
  );
}

function main() {
  const payload = JSON.parse(readFileSync(0, 'utf8') || 'null');
  const sessionId = payload?.session_id;
  const cwd = payload?.cwd;
  if (!sessionId || !cwd) {
    return;
  }

  if (payload.stop_hook_active) {
    return;
  }

  const currentPaths = lintFixPaths(cwd);
  if (currentPaths.length === 0 || currentPaths.length > MAX_LINT_FIX_FILES) {
    return;
  }

  const state = loadState(sessionId, cwd);
  const currentFingerprint = fingerprintForPaths(cwd, currentPaths);
  if (
    !currentFingerprint ||
    state.last_tidy_fingerprint === currentFingerprint
  ) {
    return;
  }

  const repoRoot = gitRoot(cwd);
  const lintResult = spawnSync('pnpm', ['lint:fix', '--', ...currentPaths], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  let formatResult = null;
  if (lintResult.status === 0) {
    formatResult = spawnSync('pnpm', ['format:changed'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  }

  const updatedPaths = lintFixPaths(cwd);
  const updatedFingerprint = fingerprintForPaths(cwd, updatedPaths);

  if (lintResult.status !== 0) {
    writeStopBlock(
      '`pnpm lint:fix` failed for the touched lintable files. Review the lint output before wrapping up.',
      'Repo hook: targeted lint fix failed.',
    );
    return;
  }

  if (formatResult && formatResult.status !== 0) {
    writeStopBlock(
      'Targeted formatting failed after `pnpm lint:fix`. Review the formatting step before wrapping up.',
      'Repo hook: targeted formatting failed.',
    );
    return;
  }

  // Failed tidy runs must not cache the fingerprint, or the same broken diff
  // would skip future closeout checks without any code changes.
  state.last_tidy_fingerprint = updatedFingerprint;
  saveState(sessionId, cwd, state);

  if (updatedFingerprint !== currentFingerprint) {
    writeStopBlock(
      'I ran targeted tidy steps on the touched files (`pnpm lint:fix` and, when applicable, Prettier). Review the updated diff, then continue or wrap up.',
      'Repo hook: ran targeted tidy steps on touched files.',
    );
  }
}

main();
