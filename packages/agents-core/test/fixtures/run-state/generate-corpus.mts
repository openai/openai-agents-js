import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';

type FixtureRecord = {
  scenario: string;
  kind: 'minimal' | 'feature' | 'resume';
  path: string;
  sha256: string;
};

type WriterSchema = {
  schemaVersion: string;
  status: 'published_writer';
  packageVersion: string;
  tag: string;
  commit: string;
  npmIntegrity: string;
  fixtures: FixtureRecord[];
};

type PolicySchema = {
  schemaVersion: string;
  status: 'published_reader_only' | 'current_unreleased';
};

type Manifest = {
  formatVersion: number;
  currentSchemaAtCreation: string;
  schemas: Array<WriterSchema | PolicySchema>;
  negativeFixtures?: Array<{
    scenario: string;
    path: string;
    sha256: string;
    expectedError: string;
  }>;
};

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(fixtureRoot, '../../../../..');
const manifestPath = join(fixtureRoot, 'sources.json');
const args = new Set(process.argv.slice(2));
const promote = args.has('--promote');
const all = args.has('--all');
const schemaArgumentIndex = process.argv.indexOf('--schema');
const requestedSchema =
  schemaArgumentIndex >= 0 ? process.argv[schemaArgumentIndex + 1] : undefined;

if (!all && !requestedSchema) {
  throw new Error('Pass --all or --schema <version>.');
}
if (all && requestedSchema) {
  throw new Error('Pass either --all or --schema <version>, not both.');
}
if (process.env.OPENAI_API_KEY) {
  throw new Error(
    'Refusing to generate fixtures while OPENAI_API_KEY is present. Remove it with env -u OPENAI_API_KEY.',
  );
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
const selected = manifest.schemas.filter(
  (entry): entry is WriterSchema =>
    entry.status === 'published_writer' &&
    (all || entry.schemaVersion === requestedSchema),
);
if (selected.length === 0) {
  throw new Error(
    `No published writer is recorded for schema ${requestedSchema}.`,
  );
}

const candidateRoot = mkdtempSync(
  join(tmpdir(), 'runstate-corpus-candidates-'),
);
const outputRoot = candidateRoot;

for (const source of selected) {
  const npmArtifact = verifySource(source);
  const generated = await generateReleasedPayloads(source, npmArtifact);
  const fixtureRecords: FixtureRecord[] = [];
  for (const [scenario, payload] of Object.entries(generated)) {
    if (
      (payload as Record<string, unknown>).$schemaVersion !==
      source.schemaVersion
    ) {
      throw new Error(
        `${source.tag} emitted ${(payload as Record<string, unknown>).$schemaVersion} for ${scenario}, expected ${source.schemaVersion}.`,
      );
    }
    const kind = fixtureKind(scenario);
    const relativePath = `historical/v${source.schemaVersion}-${scenario}.json`;
    const absolutePath = join(outputRoot, relativePath);
    const bytes = await format(JSON.stringify(payload, null, 2), {
      parser: 'json',
    });
    execFileSync('mkdir', ['-p', dirname(absolutePath)]);
    writeFileSync(absolutePath, bytes);
    fixtureRecords.push({
      scenario,
      kind,
      path: relativePath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  fixtureRecords.sort((left, right) => left.path.localeCompare(right.path));
  source.fixtures = fixtureRecords;
}

if (all) {
  manifest.negativeFixtures = generateNegativeFixtures(outputRoot);
}

if (promote) {
  for (const source of selected) {
    for (const fixture of source.fixtures) {
      promoteFixture(fixture.path);
    }
  }
  if (all) {
    for (const fixture of manifest.negativeFixtures ?? []) {
      promoteFixture(fixture.path);
    }
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  rmSync(candidateRoot, { recursive: true, force: true });
  console.log(
    `Promoted ${selected.length} released writer source(s) into ${fixtureRoot}.`,
  );
} else {
  writeFileSync(
    join(candidateRoot, 'sources.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(`Wrote candidates to ${candidateRoot}.`);
  console.log(
    'Review them, then rerun with --promote to replace checked-in fixtures.',
  );
}

function verifySource(source: WriterSchema): { tarballUrl: string } {
  const tagCommit = execFileSync('git', ['rev-list', '-n', '1', source.tag], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim();
  if (tagCommit !== source.commit) {
    throw new Error(
      `${source.tag} resolves to ${tagCommit}, expected ${source.commit}.`,
    );
  }

  const npmMetadata = JSON.parse(
    execFileSync(
      'npm',
      [
        'view',
        `@openai/agents-core@${source.packageVersion}`,
        'version',
        'dist.integrity',
        'dist.tarball',
        '--json',
      ],
      { encoding: 'utf8', env: withoutOpenAIKey(process.env) },
    ),
  ) as {
    version: string;
    'dist.integrity': string;
    'dist.tarball': string;
  };
  if (npmMetadata.version !== source.packageVersion) {
    throw new Error(
      `Registry returned version ${npmMetadata.version}, expected ${source.packageVersion}.`,
    );
  }
  if (npmMetadata['dist.integrity'] !== source.npmIntegrity) {
    throw new Error(
      `Registry integrity changed for @openai/agents-core@${source.packageVersion}.`,
    );
  }
  if (!npmMetadata['dist.tarball']) {
    throw new Error(
      `Registry returned no tarball for @openai/agents-core@${source.packageVersion}.`,
    );
  }
  return { tarballUrl: npmMetadata['dist.tarball'] };
}

type PackageExportTarget =
  | string
  | {
      import?: PackageExportTarget;
      node?: PackageExportTarget;
      default?: string;
    };

type PublishedPackageJson = {
  version: string;
  module?: string;
  main?: string;
  exports?: { '.'?: PackageExportTarget };
};

async function generateReleasedPayloads(
  source: WriterSchema,
  npmArtifact: { tarballUrl: string },
): Promise<Record<string, Record<string, unknown>>> {
  const sourceRoot = mkdtempSync(
    join(tmpdir(), `runstate-${source.schemaVersion}-`),
  );
  try {
    const archivePath = join(sourceRoot, 'source.tar');
    execFileSync(
      'git',
      ['archive', '--format=tar', '--output', archivePath, source.commit],
      { cwd: repositoryRoot, env: withoutOpenAIKey(process.env) },
    );
    execFileSync('tar', ['-xf', archivePath, '-C', sourceRoot]);
    rmSync(archivePath);

    const packageRoot = join(sourceRoot, 'packages', 'agents-core');
    const sourcePackageJson = JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8'),
    ) as { version: string };
    if (sourcePackageJson.version !== source.packageVersion) {
      throw new Error(
        `Tagged source package version ${sourcePackageJson.version}, expected ${source.packageVersion}.`,
      );
    }
    const rootPackageJson = JSON.parse(
      readFileSync(join(sourceRoot, 'package.json'), 'utf8'),
    ) as { packageManager?: string };
    if (!rootPackageJson.packageManager?.startsWith('pnpm@')) {
      throw new Error(
        `${source.tag} does not pin a pnpm packageManager version.`,
      );
    }
    execFileSync(
      'corepack',
      ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'],
      {
        cwd: sourceRoot,
        stdio: 'inherit',
        env: withoutOpenAIKey(process.env),
      },
    );

    const artifactArchivePath = join(sourceRoot, 'published-package.tgz');
    await downloadAndVerifyArtifact(
      npmArtifact.tarballUrl,
      source.npmIntegrity,
      artifactArchivePath,
    );
    const artifactRoot = join(sourceRoot, 'published-package');
    mkdirSync(artifactRoot);
    execFileSync('tar', ['-xzf', artifactArchivePath, '-C', artifactRoot], {
      cwd: sourceRoot,
      env: withoutOpenAIKey(process.env),
    });

    const artifactPackageRoot = join(artifactRoot, 'package');
    const artifactPackageJson = JSON.parse(
      readFileSync(join(artifactPackageRoot, 'package.json'), 'utf8'),
    ) as PublishedPackageJson;
    if (artifactPackageJson.version !== source.packageVersion) {
      throw new Error(
        `Published package version ${artifactPackageJson.version}, expected ${source.packageVersion}.`,
      );
    }
    const packageNodeModules = join(packageRoot, 'node_modules');
    const rootNodeModules = join(sourceRoot, 'node_modules');
    const historicalNodeModules = existsSync(packageNodeModules)
      ? packageNodeModules
      : rootNodeModules;
    if (!existsSync(historicalNodeModules)) {
      throw new Error(
        `Historical dependencies were not installed for ${source.tag}.`,
      );
    }
    symlinkSync(
      historicalNodeModules,
      join(artifactPackageRoot, 'node_modules'),
      'dir',
    );

    const entry = resolvePublishedEntrypoint(artifactPackageJson);
    if (!entry) {
      throw new Error(
        `Cannot resolve the published entrypoint for ${source.packageVersion}.`,
      );
    }
    const workerOutput = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        releasedWriterProgram(),
        join(artifactPackageRoot, entry),
        sourceRoot,
        source.schemaVersion,
      ],
      {
        encoding: 'utf8',
        env: withoutOpenAIKey(process.env),
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    return JSON.parse(workerOutput) as Record<string, Record<string, unknown>>;
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
  }
}

async function downloadAndVerifyArtifact(
  tarballUrl: string,
  expectedIntegrity: string,
  destinationPath: string,
): Promise<void> {
  const response = await fetch(tarballUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${tarballUrl}: ${response.status} ${response.statusText}.`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const separator = expectedIntegrity.indexOf('-');
  if (separator < 1) {
    throw new Error(`Unsupported npm integrity value ${expectedIntegrity}.`);
  }
  const algorithm = expectedIntegrity.slice(0, separator);
  const expectedDigest = expectedIntegrity.slice(separator + 1);
  const actualDigest = createHash(algorithm).update(bytes).digest('base64');
  if (actualDigest !== expectedDigest) {
    throw new Error(
      `Downloaded npm artifact integrity mismatch: expected ${expectedIntegrity}, got ${algorithm}-${actualDigest}.`,
    );
  }
  writeFileSync(destinationPath, bytes);
}

function resolvePublishedEntrypoint(
  packageJson: PublishedPackageJson,
): string | undefined {
  return (
    resolveExportTarget(packageJson.exports?.['.']) ??
    packageJson.module ??
    packageJson.main
  );
}

function resolveExportTarget(
  target: PackageExportTarget | undefined,
): string | undefined {
  if (typeof target === 'string') {
    return target;
  }
  if (!target) {
    return undefined;
  }
  return (
    resolveExportTarget(target.import) ??
    resolveExportTarget(target.node) ??
    target.default
  );
}

function promoteFixture(relativePath: string): void {
  const sourcePath = join(candidateRoot, relativePath);
  const destinationPath = join(fixtureRoot, relativePath);
  mkdirSync(dirname(destinationPath), { recursive: true });
  copyFileSync(sourcePath, destinationPath);
}

function fixtureKind(scenario: string): FixtureRecord['kind'] {
  if (scenario === 'minimal') {
    return 'minimal';
  }
  if (scenario.includes('approval') || scenario.includes('side-effect')) {
    return 'resume';
  }
  return 'feature';
}

function generateNegativeFixtures(outputRoot: string) {
  const readHistorical = (schemaVersion: string) =>
    JSON.parse(
      readFileSync(
        join(outputRoot, `historical/v${schemaVersion}-minimal.json`),
        'utf8',
      ),
    ) as Record<string, unknown>;
  const envelope = (version: number) => ({
    version,
    backendId: 'fixture-sandbox',
    manifest: {},
    workspaceReady: true,
    providerState: {},
  });
  const sandbox = (version: number) => ({
    backendId: 'fixture-sandbox',
    currentAgentKey: 'HistoricalAgent',
    currentAgentName: 'HistoricalAgent',
    sessionState: envelope(version),
    sessionsByAgent: {},
  });

  const missingSchema = readHistorical('1.0');
  delete missingSchema.$schemaVersion;
  const futureSchema = readHistorical('1.17');
  futureSchema.$schemaVersion = '99.0';
  const malformedSchema = readHistorical('1.17');
  malformedSchema.$schemaVersion = 117;
  const preToolSearch = readHistorical('1.7');
  preToolSearch.generatedItems = [
    {
      type: 'tool_search_call_item',
      rawItem: {
        type: 'tool_search_call',
        id: 'tool-search-negative',
        status: 'completed',
        arguments: { query: 'sentinel' },
      },
      agent: { name: 'HistoricalAgent' },
    },
  ];
  const sandboxV2 = readHistorical('1.14');
  sandboxV2.sandbox = sandbox(2);
  const sandboxV3 = readHistorical('1.17');
  sandboxV3.sandbox = sandbox(3);
  const protoKey = readHistorical('1.0');
  const protoContext = JSON.parse(
    '{"__proto__":{"polluted":"sentinel-not-a-secret"}}',
  ) as Record<string, unknown>;
  (protoKey.context as { context: Record<string, unknown> }).context =
    protoContext;

  const fixtures = [
    ['missing-schema', missingSchema, 'schema version'],
    ['future-schema', futureSchema, 'schema version'],
    ['malformed-schema', malformedSchema, 'schema version'],
    [
      'pre-1.8-tool-search',
      preToolSearch,
      'does not support tool_search items',
    ],
    [
      'v1.14-sandbox-v2',
      sandboxV2,
      'does not support sandbox session state version 2',
    ],
    [
      'v1.17-sandbox-v3',
      sandboxV3,
      'does not support sandbox session state version 3',
    ],
  ] as const;
  const records = fixtures.map(([scenario, payload, expectedError]) => {
    const path = `negative/${scenario}.json`;
    const bytes = `${JSON.stringify(payload, null, 2)}\n`;
    const absolutePath = join(outputRoot, path);
    execFileSync('mkdir', ['-p', dirname(absolutePath)]);
    writeFileSync(absolutePath, bytes);
    return {
      scenario,
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      expectedError,
    };
  });

  const protoPath = 'negative/prototype-key.json';
  const protoBytes = `${JSON.stringify(protoKey, null, 2)}\n`;
  execFileSync('mkdir', ['-p', dirname(join(outputRoot, protoPath))]);
  writeFileSync(join(outputRoot, protoPath), protoBytes);
  records.push({
    scenario: 'prototype-key',
    path: protoPath,
    sha256: createHash('sha256').update(protoBytes).digest('hex'),
    expectedError: '',
  });
  return records;
}

function withoutOpenAIKey(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  delete sanitized.OPENAI_API_KEY;
  return sanitized;
}

function releasedWriterProgram(): string {
  return String.raw`
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [entryPath, installRoot, schemaVersion] = process.argv.slice(1);
const sdk = await import(pathToFileURL(entryPath).href);
const require = createRequire(installRoot + '/package.json');
const { z } = require('zod');
sdk.setDefaultModelProvider({
  getModel() {
    throw new Error('Historical fixture agents must provide an explicit fake model.');
  },
});
if (typeof sdk.setTracingDisabled === 'function') {
  sdk.setTracingDisabled(true);
}

class QueueModel {
  constructor(outputs) {
    this.outputs = [...outputs];
  }
  async getResponse() {
    if (this.outputs.length === 0) {
      throw new Error('No queued historical model output.');
    }
    return {
      output: this.outputs.shift(),
      usage: new sdk.Usage(),
      responseId: 'fixture-response',
    };
  }
  async *getStreamedResponse() {
    throw new Error('Historical fixture generation does not stream.');
  }
}

function functionCall(name, callId, args = '{}') {
  return {
    id: 'fc_' + callId,
    type: 'function_call',
    name,
    callId,
    status: 'completed',
    arguments: args,
    providerData: {},
  };
}

const outputs = {};
const minimalAgent = new sdk.Agent({ name: 'HistoricalAgent' });
const minimalState = new sdk.RunState(
  new sdk.RunContext({ fixture: 'minimal' }),
  'hello',
  minimalAgent,
  3,
);
outputs.minimal = JSON.parse(minimalState.toString());

if (schemaVersion === '1.1') {
  const continuation = new sdk.RunState(
    new sdk.RunContext({ fixture: 'continuation' }),
    'continue',
    minimalAgent,
    4,
  );
  continuation._currentTurnInProgress = true;
  continuation._conversationId = 'conversation-historical';
  continuation._previousResponseId = 'response-historical';
  outputs['server-continuation'] = JSON.parse(continuation.toString());
}

if (schemaVersion === '1.2') {
  const approvalTool = sdk.tool({
    name: 'secure_tool',
    description: 'Requires approval.',
    parameters: z.object({ text: z.string() }),
    needsApproval: true,
    execute: async ({ text }) => 'approved:' + text,
  });
  const nestedModel = new QueueModel([
    [functionCall('secure_tool', 'nested-call', JSON.stringify({ text: 'sentinel' }))],
  ]);
  const nestedAgent = new sdk.Agent({
    name: 'NestedAgent',
    model: nestedModel,
    tools: [approvalTool],
    modelSettings: { toolChoice: 'required' },
  });
  const nestedTool = nestedAgent.asTool({
    toolName: 'nested_tool',
    toolDescription: 'Nested agent tool.',
    runOptions: { context: { nested: true } },
  });
  const outerAgent = new sdk.Agent({
    name: 'OuterAgent',
    model: new QueueModel([
      [functionCall('nested_tool', 'outer-call', JSON.stringify({ input: 'hello' }))],
    ]),
    tools: [nestedTool],
    modelSettings: { toolChoice: 'required' },
  });
  const interrupted = await new sdk.Runner({
    traceId: 'trace_11111111111111111111111111111111',
    tracingDisabled: true,
  }).run(outerAgent, 'start');
  if (interrupted.interruptions.length !== 1) {
    throw new Error('Historical nested approval scenario did not interrupt.');
  }
  interrupted.state._trace = null;
  interrupted.state._currentAgentSpan = undefined;
  for (const [key, serializedNestedState] of interrupted.state
    ._pendingAgentToolRuns) {
    const nestedState = await sdk.RunState.fromString(
      nestedAgent,
      serializedNestedState,
    );
    nestedState._trace = null;
    nestedState._currentAgentSpan = undefined;
    interrupted.state._pendingAgentToolRuns.set(key, nestedState.toString());
  }
  outputs['nested-approval'] = JSON.parse(interrupted.state.toString());
}

if (schemaVersion === '1.17') {
  const sideEffectTool = sdk.tool({
    name: 'side_effect_tool',
    description: 'Runs once.',
    parameters: z.object({}).strict(),
    execute: async () => 'side effect completed',
  });
  const sideEffectAgent = new sdk.Agent({
    name: 'SideEffectAgent',
    model: new QueueModel([]),
    tools: [sideEffectTool],
  });
  const sideEffectState = new sdk.RunState(
    new sdk.RunContext({ fixture: 'side-effect' }),
    'run once',
    sideEffectAgent,
    3,
  );
  const sideEffectCall = functionCall('side_effect_tool', 'side-effect-call');
  const sideEffectResult = {
    type: 'function_call_result',
    name: 'side_effect_tool',
    callId: 'side-effect-call',
    status: 'completed',
    output: 'side effect completed',
  };
  sideEffectState._currentTurn = 1;
  sideEffectState._currentTurnInProgress = true;
  sideEffectState._noActiveAgentRun = false;
  sideEffectState._lastTurnResponse = {
    output: [sideEffectCall],
    usage: new sdk.Usage(),
    responseId: 'side-effect-response',
  };
  sideEffectState._modelResponses = [sideEffectState._lastTurnResponse];
  sideEffectState._generatedItems = [
    new sdk.RunToolCallItem(sideEffectCall, sideEffectAgent),
    new sdk.RunToolCallOutputItem(
      sideEffectResult,
      sideEffectAgent,
      'side effect completed',
    ),
  ];
  sideEffectState._currentStep = { type: 'next_step_run_again' };
  outputs['side-effect-committed'] = JSON.parse(sideEffectState.toString());
}

process.stdout.write(JSON.stringify(outputs));
`;
}
