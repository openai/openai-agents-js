import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const native = createRequire(import.meta.url)(process.argv[2]);
const home = process.argv[3];
const file = join(home, 'config.toml');
const config = JSON.stringify({
  model: 'gpt-5',
  model_provider: 'fixture',
  'model_providers.fixture': {
    name: 'fixture',
    base_url: 'http://127.0.0.1:1/v1',
    wire_api: 'responses',
    requires_openai_auth: true,
    supports_websockets: false,
  },
  mcp_servers: {},
  'agents.enabled': false,
  'features.apps': false,
  'features.plugins': false,
});
let sequence = 0;
const engines = new Set(),
  threads = new Set();
const valid = () => writeFile(file, 'projects = {}\n');
const broken = () => writeFile(file, '[broken');
async function create(prepared, loader) {
  const cwd = join(home, `workspace-${++sequence}`);
  await mkdir(cwd);
  const runtime = JSON.stringify({
    _sdk_native_config: true,
    codex_home: cwd,
    cwd,
    ...(loader ? { loader } : {}),
  });
  const engine = await (
    prepared ? native._create_first_root_engine : native.create_engine
  )(config, runtime, 'fixture');
  engines.add(engine);
  return engine;
}
async function close(thread) {
  assert.equal(await thread._close_report(), null);
  threads.delete(thread);
}
try {
  await valid();
  const prepared = await create(true),
    raw = await create(false);
  await broken();
  const thread = await prepared._start_first_root('{}', '[]');
  threads.add(thread);
  await close(thread);
  await assert.rejects(prepared._start_first_root('{}', '[]'), /configuration/);
  await assert.rejects(
    raw.start_replaceable_thread('{}', '[]'),
    /configuration/,
  );
  await assert.rejects(create(true), /configuration/);

  await valid();
  const changed = await create(true);
  await broken();
  await assert.rejects(
    changed._start_first_root(
      JSON.stringify({ config: { model: 'another-model' } }),
      '[]',
    ),
    /configuration/,
  );

  await valid();
  const malformed = await create(true);
  await assert.rejects(malformed._start_first_root('{', '[]'));
  await broken();
  await assert.rejects(
    malformed._start_first_root('{}', '[]'),
    /configuration/,
  );

  await valid();
  const closed = await create(true);
  assert.equal(await closed._close_report(), null);
  await assert.rejects(closed._start_first_root('{}', '[]'), /closed/);
  await valid();
  const managed = await create(true, { ignore_managed_requirements: false });
  await broken();
  await assert.rejects(managed._start_first_root('{}', '[]'), /configuration/);

  await valid();
  const ordinaryStart = await create(true);
  await broken();
  await assert.rejects(
    ordinaryStart.start_replaceable_thread('{}', '[]'),
    /configuration/,
  );
  await assert.rejects(
    ordinaryStart._start_first_root('{}', '[]'),
    /configuration/,
  );
  console.log(
    JSON.stringify({
      status: 'pass',
      coherentFirstRoot: true,
      laterAndRawReload: true,
      changedOverrideReload: true,
      parseFailureInvalidates: true,
      closedRejects: true,
      managedPolicyReload: true,
      rawStartInvalidates: true,
      freshOpeningReload: true,
    }),
  );
} finally {
  const results = await Promise.allSettled(
    [...threads].map((t) => t._close_report()),
  );
  const owners = await Promise.allSettled([...engines].map((e) => e.close()));
  const failures = [...results, ...owners].filter(
    (r) => r.status === 'rejected',
  );
  if (failures.length)
    throw new AggregateError(
      failures.map((r) => r.reason),
      'Fixture cleanup failed',
    );
}
