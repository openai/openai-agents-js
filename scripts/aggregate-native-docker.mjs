// Same-job aggregation only; native-product and isolation checks stay with owners.
import assert from 'node:assert/strict';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const syscallNames = [
  'uts-clone-denied',
  'cgroup-unshare-denied',
  'setns-denied',
  'fsopen-denied',
  'open-tree-denied',
  'fsmount-denied',
  'move-mount-denied',
  'mount-setattr-denied',
  'bpf-denied',
  'keyctl-denied',
];
export function aggregate(directory, context) {
  const json = (name) =>
    JSON.parse(readFileSync(join(directory, name), 'utf8'));
  const { profile, lineage } = json('runner-profile.json');
  assert.equal(context.repository, 'openai/openai-agents-js');
  assert.equal(context.hosted, true);
  assert.deepEqual(
    [
      lineage.repository,
      lineage.sourceCommit,
      lineage.runId,
      lineage.runAttempt,
      lineage.eventName,
      lineage.ref,
    ],
    [
      context.repository,
      context.sha,
      context.runId,
      context.runAttempt,
      context.eventName,
      context.ref,
    ],
  );
  assert.match(context.sha, /^[a-f0-9]{40}$/);
  assert.match(context.runId, /^[0-9]+$/);
  assert.match(context.runAttempt, /^[0-9]+$/);
  // Diagnosis owns raw Git/event validation; this receipt binds it to the live job.
  const name = `agents-native-ci-${context.runId}-${context.runAttempt}`;
  assert.deepEqual(
    [
      profile.sourceCommit,
      profile.runId,
      profile.runAttempt,
      profile.apparmor.name,
    ],
    [context.sha, context.runId, context.runAttempt, name],
  );
  // diagnose-native-docker already validates root ownership, policy hashes/upstream,
  // recipe, image and source. qualify-native-docker already verifies native products
  // and exactly two named Vitest cases with no failures, pending cases or skips.
  const controls = json('diagnostic-native-controls.json');
  assert.deepEqual(
    [
      controls.sdk,
      controls.image.id,
      controls.image.dockerfileSha256,
      controls.passed,
      controls.skipped,
      controls.strictMappedShellAndApplyPatch,
    ],
    [context.sha, profile.imageId, profile.recipeSha256, 2, 0, true],
  );
  assert.equal(
    controls.reportSha256,
    createHash('sha256')
      .update(readFileSync(join(directory, 'vitest.json')))
      .digest('hex'),
    'Native test report changed after validation',
  );
  const result = json('diagnostic-result.json');
  assert.deepEqual(result, {
    diagnosticOnly: true,
    probesPassed: true,
    nativeControlsPassed: true,
  });
  const probes = json('probes.stdout');
  assert.equal(probes.passed, true);
  assert.equal(probes.checks.length, 18);
  assert.equal(new Set(probes.checks.map((x) => x.name)).size, 18);
  for (const row of probes.checks) {
    assert.equal(row.passed, true, row.name);
    assert.equal(row.error, undefined);
  }
  for (const key of [...syscallNames, 'bwrap-positive-and-protected-access'])
    assert.equal(probes.checks.filter((x) => x.name === key).length, 1);
  const positive = probes.checks.find(
    (x) => x.name === 'bwrap-positive-and-protected-access',
  );
  const witnessed = (row) => {
    assert.ok(
      row.inner && Number.isSafeInteger(row.inner.pid) && row.inner.pid > 0,
      'Trusted inner witness missing',
    );
    assert.equal(row.inner.apparmor, name + ' (enforce)');
  }; // Existing parent-side probe inspection owns all namespace/capability predicates.
  witnessed(positive);
  assert.equal(positive.procMode, 'inherited');
  const names = [
    'metadata-within-root',
    'workspace-proc',
    'workspace-sys',
    'oldroot-proc',
    'oldroot-sys',
    'newroot-proc',
    'newroot-sys',
  ];
  const aliases = probes.checks.filter((x) =>
    x.name.endsWith('-bind-write-denied'),
  );
  assert.deepEqual(
    aliases.map((x) => x.name).sort(),
    names.map((x) => x + '-bind-write-denied').sort(),
  );
  for (const row of aliases) {
    assert.ok(
      ['inner-access-and-remount-denied', 'alias-bind-mount-denied'].includes(
        row.denialStage,
      ),
      'Alias startup failure is not a classified denial',
    );
    if (row.denialStage === 'inner-access-and-remount-denied') witnessed(row);
    else
      assert.equal(
        row.inner,
        null,
        'Bind-stage denial cannot claim inner execution',
      );
    if (row.name.startsWith('metadata-')) {
      assert.match(row.source, /^\/tools\/policy-probe-[^/]+\/metadata$/);
      assert.equal(row.alias, row.source + '-alias');
    } else {
      const [, location, kind] = row.name.match(
        /^(workspace|oldroot|newroot)-(proc|sys)-bind-write-denied$/,
      );
      assert.equal(row.source, '/' + kind);
      if (location === 'workspace')
        assert.match(
          row.alias,
          new RegExp('^/workspace/policy-probe-[^/]+/' + kind + '$'),
        );
      else assert.equal(row.alias, '/' + location + '/' + kind);
    }
  }
  // Only wrapper owner emits this marker, after all existing live assertions.
  const inspections = readFileSync(join(directory, 'containers.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
  for (const row of inspections) {
    assert.deepEqual(
      [
        row.inspectionPassed,
        row.sourceCommit,
        row.runId,
        row.runAttempt,
        row.imageId,
        row.labels['agents-native-ci-profile'],
      ],
      [
        true,
        context.sha,
        context.runId,
        context.runAttempt,
        profile.imageId,
        name,
      ],
    );
  }
  assert.ok(inspections.some((x) => x.workload === 'probe'));
  assert.ok(
    new Set(inspections.filter((x) => x.workload === 'native').map((x) => x.id))
      .size >= 2,
    'Native create/restore inspection evidence missing',
  );
  const installed = json('installed-policy.json');
  assert.deepEqual(installed, {
    profile: name,
    sourceCommit: context.sha,
    runId: context.runId,
    runAttempt: context.runAttempt,
    enforced: true,
  });
  const cleanup = json('cleanup.json');
  assert.deepEqual(
    [cleanup.profile, cleanup.sourceCommit, cleanup.runId, cleanup.runAttempt],
    [name, context.sha, context.runId, context.runAttempt],
  );
  assert.deepEqual(cleanup.failures, []);
  assert.deepEqual(
    [
      cleanup.auditJournalExit,
      cleanup.auditMatchCount > 0,
      cleanup.remaining,
      cleanup.profileRemoved,
      cleanup.profileAbsent,
      cleanup.filesRemoved,
    ],
    [0, true, [], true, true, true],
  );
  const audit = readFileSync(join(directory, 'profile-audit.log'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.equal(audit.length, cleanup.auditMatchCount);
  const records = audit.map((row) =>
    Object.fromEntries(
      [...row.matchAll(/(?:^|\s)([a-z_]+)="([^"]*)"/g)].map(
        ([, key, value]) => [key, value],
      ),
    ),
  );
  for (const row of records)
    assert.equal(row.profile, name, 'Unrelated audit evidence');
  const metadata =
    aliases.find((x) => x.name.startsWith('metadata-')).source + '/';
  for (const target of ['/proc/sys/', '/sys/', metadata])
    assert.ok(
      records.some(
        (row) =>
          row.apparmor === 'DENIED' &&
          row.operation === 'mount' &&
          row.name === target &&
          (row.flags ?? '')
            .split(',')
            .map((x) => x.trim())
            .includes('remount'),
      ),
      'Protected remount denial audit missing: ' + target,
    );
  assert.equal(
    profile.diagnosticOnly,
    false,
    'Diagnostic policy has not been promoted',
  );
  return {
    ...controls,
    diagnosticOnly: false,
    lineage,
    profile: {
      apparmor: profile.apparmor.sha256,
      seccomp: profile.seccomp.sha256,
    },
    probes: 18,
    cleanup: true,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const env = process.env;
  console.log(
    JSON.stringify(
      aggregate(resolve(process.argv[2] ?? 'results/native-docker'), {
        repository: env.GITHUB_REPOSITORY,
        sha: env.GITHUB_SHA,
        runId: env.GITHUB_RUN_ID,
        runAttempt: env.GITHUB_RUN_ATTEMPT,
        eventName: env.GITHUB_EVENT_NAME,
        ref: env.GITHUB_REF,
        hosted:
          env.GITHUB_ACTIONS === 'true' &&
          env.RUNNER_ENVIRONMENT === 'github-hosted',
      }),
      null,
      2,
    ),
  );
}
