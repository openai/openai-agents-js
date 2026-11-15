import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { aggregate } from './aggregate-native-docker.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'native-gate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const put = (file, value) =>
    writeFileSync(join(directory, file), JSON.stringify(value));
  const repository = 'openai/openai-agents-js',
    sha = 'a'.repeat(40),
    name = 'agents-native-ci-123-1';
  const context = {
    repository,
    sha,
    runId: '123',
    runAttempt: '1',
    eventName: 'push',
    ref: 'refs/heads/feat/codex-harness',
    hosted: true,
  };
  const profile = {
    sourceCommit: sha,
    runId: '123',
    runAttempt: '1',
    diagnosticOnly: false,
    imageId: 'sha256:' + 'b'.repeat(64),
    recipeSha256: 'c'.repeat(64),
    apparmor: { name, sha256: 'd'.repeat(64) },
    seccomp: { sha256: 'e'.repeat(64) },
  };
  put('runner-profile.json', {
    profile,
    lineage: {
      repository,
      sourceCommit: sha,
      runId: '123',
      runAttempt: '1',
      eventName: 'push',
      ref: context.ref,
      parents: ['f'.repeat(40)],
    },
  });
  put('vitest.json', { numPassedTests: 2, numPendingTests: 0 });
  put('diagnostic-native-controls.json', {
    sdk: sha,
    image: { id: profile.imageId, dockerfileSha256: profile.recipeSha256 },
    passed: 2,
    skipped: 0,
    strictMappedShellAndApplyPatch: true,
    reportSha256: createHash('sha256')
      .update(readFileSync(join(directory, 'vitest.json')))
      .digest('hex'),
  });
  put('diagnostic-result.json', {
    diagnosticOnly: true,
    probesPassed: true,
    nativeControlsPassed: true,
  });
  const checks = [
    'uts-clone',
    'cgroup-unshare',
    'setns',
    'fsopen',
    'open-tree',
    'fsmount',
    'move-mount',
    'mount-setattr',
    'bpf',
    'keyctl',
  ].map((x) => ({ name: x + '-denied', passed: true }));
  checks.push({
    name: 'bwrap-positive-and-protected-access',
    passed: true,
    procMode: 'inherited',
    outerProcLinks: 'denied',
    inner: { pid: 9, apparmor: name + ' (enforce)' },
  });
  for (const location of ['workspace', 'oldroot', 'newroot'])
    for (const kind of ['proc', 'sys'])
      checks.push({
        name: `${location}-${kind}-bind-write-denied`,
        passed: true,
        denialStage: 'alias-bind-mount-denied',
        source: '/' + kind,
        alias:
          '/' +
          location +
          (location === 'workspace' ? '/policy-probe-test' : '') +
          '/' +
          kind,
        inner: null,
      });
  checks.push({
    name: 'metadata-within-root-bind-write-denied',
    passed: true,
    denialStage: 'alias-bind-mount-denied',
    source: '/tools/policy-probe-test/metadata',
    alias: '/tools/policy-probe-test/metadata-alias',
    inner: null,
  });
  put('probes.stdout', { passed: true, checks });
  writeFileSync(
    join(directory, 'containers.jsonl'),
    ['probe', 'native', 'native']
      .map((workload, i) =>
        JSON.stringify({
          id: String(i + 1).repeat(64),
          workload,
          inspectionPassed: true,
          sourceCommit: sha,
          runId: '123',
          runAttempt: '1',
          imageId: profile.imageId,
          labels: { 'agents-native-ci-profile': name },
        }),
      )
      .join('\n'),
  );
  put('installed-policy.json', {
    profile: name,
    sourceCommit: sha,
    runId: '123',
    runAttempt: '1',
    enforced: true,
  });
  put('cleanup.json', {
    profile: name,
    sourceCommit: sha,
    runId: '123',
    runAttempt: '1',
    failures: [],
    auditJournalExit: 0,
    auditMatchCount: 3,
    remaining: [],
    profileRemoved: true,
    profileAbsent: true,
    filesRemoved: true,
  });
  writeFileSync(
    join(directory, 'profile-audit.log'),
    ['/proc/sys/', '/sys/', '/tools/policy-probe-test/metadata/']
      .map(
        (target) =>
          `apparmor="DENIED" operation="mount" profile="${name}" name="${target}" flags="rw, remount, bind"`,
      )
      .join('\n'),
  );
  return {
    directory,
    context,
    change(file, update) {
      const value = JSON.parse(readFileSync(join(directory, file), 'utf8'));
      update(value);
      put(file, value);
    },
  };
}

test('same-job owners qualify only after cleanup', (t) => {
  const f = fixture(t);
  assert.equal(aggregate(f.directory, f.context).passed, 2);
  f.change('cleanup.json', (x) => {
    x.profileAbsent = false;
  });
  assert.throws(() => aggregate(f.directory, f.context));
});

test('diagnostic policy, stale source and unclassified controls remain red', (t) => {
  for (const [file, update] of [
    [
      'runner-profile.json',
      (x) => {
        x.profile.diagnosticOnly = true;
      },
    ],
    [
      'diagnostic-native-controls.json',
      (x) => {
        x.sdk = 'f'.repeat(40);
      },
    ],
    [
      'probes.stdout',
      (x) => {
        x.checks[11].denialStage = 'startup-failed';
      },
    ],
    [
      'probes.stdout',
      (x) => {
        const positive = x.checks.find(
          (check) => check.name === 'bwrap-positive-and-protected-access',
        );
        delete positive.outerProcLinks;
      },
    ],
  ]) {
    const f = fixture(t);
    f.change(file, update);
    assert.throws(() => aggregate(f.directory, f.context));
  }
  const f = fixture(t);
  f.context.sha = 'f'.repeat(40);
  assert.throws(() => aggregate(f.directory, f.context));
});

test('qualification requires strict mapped execution and the exact test report', (t) => {
  const basic = fixture(t);
  basic.change('diagnostic-native-controls.json', (value) => {
    delete value.strictMappedShellAndApplyPatch;
  });
  assert.throws(() => aggregate(basic.directory, basic.context));

  const changed = fixture(t);
  changed.change('vitest.json', (value) => {
    value.numPassedTests = 1;
  });
  assert.throws(
    () => aggregate(changed.directory, changed.context),
    /Native test report changed after validation/,
  );
});

test('positive probe requires explicit outer proc link denial', (t) => {
  for (const outerProcLinks of [undefined, 'allowed']) {
    const f = fixture(t);
    f.change('probes.stdout', (x) => {
      const positive = x.checks.find(
        (row) => row.name === 'bwrap-positive-and-protected-access',
      );
      positive.outerProcLinks = outerProcLinks;
    });
    assert.throws(() => aggregate(f.directory, f.context));
  }
});

test('startup or protected-source audit cannot replace protected-target remount denial', (t) => {
  const f = fixture(t),
    path = join(f.directory, 'profile-audit.log');
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace(
      'name="/sys/"',
      'name="/unrelated/" srcname="/sys/"',
    ),
  );
  assert.throws(() => aggregate(f.directory, f.context));
});

// Exercise the actual diagnosis owner rather than reconstructing its predicates.
function diagnoseLineage(eventName, event, ref, parents) {
  const source = readFileSync(
    new URL('./diagnose-native-docker.mjs', import.meta.url),
    'utf8',
  );
  const start = source.search(
    /assert\.equal\(\s*sdk,\s*process\.env\.GITHUB_SHA/,
  );
  const end = source.indexOf('const profile = JSON.parse', start);
  assert.ok(
    start >= 0 && end > start,
    'Diagnosis lineage block has been missing',
  );
  const block = source.slice(start, end);
  const sha = 'a'.repeat(40),
    repository = 'openai/openai-agents-js';
  return JSON.parse(
    runInNewContext(block + '\nJSON.stringify(lineage)', {
      assert,
      sdk: sha,
      process: {
        env: {
          GITHUB_SHA: sha,
          GITHUB_REPOSITORY: repository,
          GITHUB_RUN_ID: '123',
          GITHUB_RUN_ATTEMPT: '1',
          GITHUB_EVENT_NAME: eventName,
          GITHUB_REF: ref,
          GITHUB_EVENT_PATH: 'event.json',
        },
      },
      readFileSync: () => JSON.stringify(event),
      execFileSync: () =>
        'tree ' +
        'b'.repeat(40) +
        '\n' +
        parents.map((x) => 'parent ' + x).join('\n') +
        '\n\nmessage\n',
    }),
  );
}

test('diagnosis alone binds PR raw parents and push event source', () => {
  const repository = { full_name: 'openai/openai-agents-js' },
    sha = 'a'.repeat(40);
  const pr = {
    repository,
    number: 7,
    pull_request: {
      base: {
        repo: repository,
        ref: 'feat/codex-harness',
        sha: 'b'.repeat(40),
      },
      head: { repo: repository, sha: 'c'.repeat(40) },
    },
  };
  const parents = [pr.pull_request.base.sha, pr.pull_request.head.sha];
  assert.deepEqual(
    diagnoseLineage('pull_request', pr, 'refs/pull/7/merge', parents).parents,
    parents,
  );
  assert.throws(() =>
    diagnoseLineage(
      'pull_request',
      pr,
      'refs/pull/7/merge',
      [...parents].reverse(),
    ),
  );
  const push = {
    repository,
    ref: 'refs/heads/feat/codex-harness',
    after: sha,
    deleted: false,
  };
  assert.equal(
    diagnoseLineage('push', push, push.ref, parents).sourceCommit,
    sha,
  );
  assert.throws(() =>
    diagnoseLineage(
      'push',
      { ...push, after: 'f'.repeat(40) },
      push.ref,
      parents,
    ),
  );
  assert.throws(() =>
    diagnoseLineage('push', { ...push, deleted: true }, push.ref, parents),
  );
});
