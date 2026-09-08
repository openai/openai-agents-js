import { describe, expect, test, vi } from 'vitest';
import * as contractSurface from './released-api-contract-surface.mjs';
import * as contractExecution from './released-api-contract-execution.mjs';
import { execFile as execFileCallback } from 'node:child_process';
import {
  access,
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import console from 'node:console';
import { URL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';

import {
  PUBLIC_PACKAGES,
  inspectPackageSet,
  comparePackageSets,
  normalizeSelectedPublicObjectProperties,
  validateSelectedPublicObjectProperties,
  compareConditionTrees,
  compareOptionalPeers,
  compareResolvedConditionSurfaces,
  compareSurfaceRecords,
  collectConditionTargets,
  collectExportLeaves,
  collectRuntimeConditionSets,
  describeOwnedSymbol,
  isPublicDeclaration,
  isDirectObjectTypeAliasDeclaration,
  isReadonlyDeclarations,
  normalizeSelectedPublicTypeAliases,
  preservedSelectionPolicies,
  resolveConditionalTarget,
  selectDeclarationSurface,
  validateExportLeafConditions,
  validatePackageExportTarget,
  validateExportTreeTerminals,
  validateSelectedProperties,
  validateSelectedPublicTypeAliases,
} from './released-api-contract-surface.mjs';
import {
  compareConvenienceBindingIdentity,
  compareNamespaceBindingIdentity,
  compareRuntimeBindings,
  installTarballs,
  isSafeWithoutOptionalPeers,
  isUnsupportedOptionalPeerFormat,
  withAcquiredResources,
} from './released-api-contract-execution.mjs';

describe('released API contract module boundaries', () => {
  test('preserves the original entrypoint exports and their identities', async () => {
    const entrypoint = await import('./released-api-contract.mjs');
    const surface = await import('./released-api-contract-surface.mjs');
    const execution = await import('./released-api-contract-execution.mjs');
    const originalExports = [
      'PUBLIC_PACKAGES',
      'collectConditionTargets',
      'collectExportLeaves',
      'validateExportLeafConditions',
      'validateExportTreeTerminals',
      'collectRuntimeConditionSets',
      'resolveConditionalTarget',
      'validatePackageExportTarget',
      'compareConditionTrees',
      'isPublicDeclaration',
      'isReadonlyDeclarations',
      'isDirectObjectTypeAliasDeclaration',
      'describeOwnedSymbol',
      'normalizeSelectedPublicTypeAliases',
      'preservedSelectionPolicies',
      'selectDeclarationSurface',
      'compareResolvedConditionSurfaces',
      'compareOwnedDescriptors',
      'compareSurfaceRecords',
      'validateSelectedProperties',
      'validateSelectedPublicTypeAliases',
      'compareOptionalPeers',
      'compareRuntimeBindings',
      'compareNamespaceBindingIdentity',
      'compareConvenienceBindingIdentity',
      'isUnsupportedOptionalPeerFormat',
      'isSafeWithoutOptionalPeers',
      'withAcquiredResources',
      'installTarballs',
    ];
    expect(Object.keys(entrypoint).sort()).toEqual(originalExports.sort());
    for (const name of originalExports) {
      expect(entrypoint[name]).toBe(surface[name] ?? execution[name]);
    }
  });

  test.each([
    './released-api-contract-surface.mjs',
    './released-api-contract-execution.mjs',
  ])(
    'imports %s without running the CLI or acquiring resources',
    async (file) => {
      const moduleUrl = new URL(file, import.meta.url);
      const env = { ...process.env };
      delete env.OPENAI_API_KEY;
      const { stdout, stderr } = await promisify(execFileCallback)(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const unexpected = () => { throw new Error('Unexpected import side effect'); };
childProcess.execFile = unexpected;
for (const name of ['mkdtemp', 'writeFile', 'rename', 'rm']) fs[name] = unexpected;
syncBuiltinESMExports();
process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(moduleUrl))}, 'source'];
await import(${JSON.stringify(moduleUrl.href)});
console.log('Imported without side effects');`,
        ],
        { env },
      );
      expect(stdout.trim()).toBe('Imported without side effects');
      expect(stderr).toBe('');
    },
  );
});

const functionRecord = {
  name: 'run',
  spaces: ['value'],
  sdkOwned: true,
  kind: 'function',
};

const member = (name, callable = false) => ({
  name,
  optional: false,
  readonly: false,
  callable,
});

function describeDeclaration(sourceText, kind = 'type', symbolOptions) {
  const fileName = '/released-api-contract-literal.ts';
  const options = {
    strict: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    noLib: true,
  };
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    options.target,
    true,
  );
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (requested) =>
    requested === fileName ? sourceFile : undefined;
  host.fileExists = (requested) => requested === fileName;
  host.readFile = (requested) =>
    requested === fileName ? sourceText : undefined;
  const program = ts.createProgram([fileName], options, host);
  const checker = program.getTypeChecker();
  const declaration =
    sourceFile.statements.find(
      (statement) => statement.name?.text === 'Formatter',
    ) ?? sourceFile.statements[0];
  const symbol = checker.getSymbolAtLocation(declaration.name);
  return describeOwnedSymbol(checker, symbol, kind, symbolOptions);
}

describe('released API contract comparisons', () => {
  test('limits structural type aliases to direct SDK object declarations', () => {
    const source = ts.createSourceFile(
      'types.ts',
      `type Direct = { value: string };
type Imported = import('dependency').Client;
type Combined = Imported & { value: string };`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(source.statements.map(isDirectObjectTypeAliasDeclaration)).toEqual([
      true,
      false,
      false,
    ]);
  });

  test('describes only selected direct callable type aliases', () => {
    const source = `type Promise<T> = { value: T };
    type Formatter<TContext = unknown> = (
      args: Args<TContext>,
    ) => Promise<string | undefined> | string | undefined;
    type Args<TContext> = { context: TContext };`;
    expect(describeDeclaration(source)).toEqual({});
    expect(
      describeDeclaration(source, 'type', {
        selectedTypeAliasKind: 'callable',
      }),
    ).toEqual({
      callableSignature: {
        typeParameters: [{ constraint: null, default: 'unknown' }],
        parameters: [
          {
            optional: false,
            rest: false,
            type: 'Args<[[type-parameter:0]]>',
          },
        ],
        returnType: 'string | Promise<string | undefined> | undefined',
      },
    });
  });

  test('normalizes callable type parameter and parameter names', () => {
    const first = describeDeclaration(
      'type Formatter<TContext = unknown> = (args: TContext) => TContext;',
      'type',
      { selectedTypeAliasKind: 'callable' },
    );
    const renamed = describeDeclaration(
      'type Formatter<TValue = unknown> = (value: TValue) => TValue;',
      'type',
      { selectedTypeAliasKind: 'callable' },
    );
    expect(renamed).toEqual(first);
  });

  test('normalizes only callable type parameter references', () => {
    const collidingNames = describeDeclaration(
      'type Formatter<T, T0> = (first: T, second: T0) => [T, T0];',
      'type',
      { selectedTypeAliasKind: 'callable' },
    );
    const renamed = describeDeclaration(
      'type Formatter<Left, Right> = (left: Left, right: Right) => [Left, Right];',
      'type',
      { selectedTypeAliasKind: 'callable' },
    );
    const swapped = describeDeclaration(
      'type Formatter<T, T0> = (first: T0, second: T) => [T, T0];',
      'type',
      { selectedTypeAliasKind: 'callable' },
    );
    const propertyName = describeDeclaration(
      'type Formatter<value> = (arg: { value: string; data: value }) => value;',
      'type',
      { selectedTypeAliasKind: 'callable' },
    );
    const renamedPropertyType = describeDeclaration(
      'type Formatter<other> = (arg: { value: string; data: other }) => other;',
      'type',
      { selectedTypeAliasKind: 'callable' },
    );
    const externalSymbol = describeDeclaration(
      'interface T0 { value: string } type Formatter<T> = (first: T0, second: T) => T;',
      'type',
      { selectedTypeAliasKind: 'callable' },
    );
    const swappedExternalSymbol = describeDeclaration(
      'interface T0 { value: string } type Formatter<T> = (first: T, second: T0) => T;',
      'type',
      { selectedTypeAliasKind: 'callable' },
    );

    expect(renamed).toEqual(collidingNames);
    expect(swapped).not.toEqual(collidingNames);
    expect(renamedPropertyType).toEqual(propertyName);
    expect(swappedExternalSymbol).not.toEqual(externalSymbol);
  });

  test('rejects unsupported selected callable alias shapes', () => {
    expect(() =>
      describeDeclaration('type Formatter = string | (() => string);', 'type', {
        selectedTypeAliasKind: 'callable',
      }),
    ).toThrow('must be declared as a direct function type alias');
    expect(() =>
      describeDeclaration('type Formatter = <T>(value: T) => T;', 'type', {
        selectedTypeAliasKind: 'callable',
      }),
    ).toThrow('must not declare call-signature type parameters');
    expect(() =>
      describeDeclaration(
        'type Formatter = (this: { value: string }) => string;',
        'type',
        { selectedTypeAliasKind: 'callable' },
      ),
    ).toThrow('must not declare a this parameter');
    expect(() =>
      describeDeclaration(
        'type Formatter<in T> = (value: T) => string;',
        'type',
        {
          selectedTypeAliasKind: 'callable',
        },
      ),
    ).toThrow('must not declare type parameter modifiers');
    expect(() =>
      describeDeclaration(
        'type Formatter = (value: string) => Formatter;',
        'type',
        { selectedTypeAliasKind: 'callable' },
      ),
    ).toThrow('must not recursively reference itself');
  });

  test('rejects removed and moved exports', () => {
    expect(compareSurfaceRecords([functionRecord], [], '@openai/test')).toEqual(
      ['@openai/test.run was removed'],
    );
  });

  test('rejects removed export conditions and accepts additions', () => {
    const released = {
      types: './dist/index.d.ts',
      require: './dist/index.js',
      import: './dist/index.mjs',
    };
    expect(
      compareConditionTrees(released, {
        types: './new/index.d.ts',
        import: './new/index.mjs',
      }),
    ).toEqual(['exports.require was removed']);
    expect(
      compareConditionTrees(released, {
        browser: { import: './dist/browser.mjs' },
        ...released,
      }),
    ).toEqual([]);
    expect(
      compareConditionTrees(released, {
        types: released.types,
        import: released.import,
        require: released.require,
      }),
    ).toEqual(['exports changed released condition precedence']);
    expect(
      compareConditionTrees(released.import, {
        development: './dist/development.mjs',
        default: './dist/index.mjs',
      }),
    ).toEqual([]);
    expect(
      compareConditionTrees(released.import, {
        development: './dist/development.mjs',
      }),
    ).toEqual(['exports no longer resolves to a file target']);
  });

  test('discovers every conditional declaration target', () => {
    expect(
      collectConditionTargets(
        {
          browser: { types: './browser.d.ts' },
          workerd: { types: './workerd.d.ts' },
          types: './index.d.ts',
        },
        'types',
      ),
    ).toEqual([
      { condition: 'browser.types', target: './browser.d.ts' },
      { condition: 'workerd.types', target: './workerd.d.ts' },
      { condition: 'types', target: './index.d.ts' },
    ]);
  });

  test('accepts valid direct condition leaves and rejects invalid targets', () => {
    expect(collectExportLeaves('./dist/direct.mjs')).toEqual([
      { condition: '', target: './dist/direct.mjs' },
    ]);
    expect(
      validateExportLeafConditions(
        {
          browser: './dist/browser.mjs',
          types: './dist/index.d.ts',
          require: './dist/index.js',
          import: './dist/index.mjs',
        },
        '@openai/test',
      ),
    ).toEqual([]);
    expect(
      validateExportLeafConditions(
        { import: 'dist/index.mjs' },
        '@openai/test',
      ),
    ).toEqual([
      '@openai/test has invalid package export target dist/index.mjs: target must start with ./',
    ]);
  });

  test('collects custom condition sets for public package resolution', () => {
    expect(
      collectRuntimeConditionSets([
        {
          browser: './dist/browser.mjs',
          workerd: { import: './dist/workerd.mjs' },
          'react-native': { development: './dist/react-native.mjs' },
          node: { import: './dist/node.mjs' },
          default: './dist/default.mjs',
        },
      ]),
    ).toEqual([['browser'], ['react-native', 'development'], ['workerd']]);
  });

  test('matches direct custom runtime targets with their declaration surface', () => {
    const exportNode = {
      browser: './dist/browser.mjs',
      types: './dist/index.d.ts',
      require: './dist/index.js',
      import: './dist/index.mjs',
    };
    expect(resolveConditionalTarget(exportNode, 'import', ['browser'])).toEqual(
      {
        condition: 'browser',
        target: './dist/browser.mjs',
      },
    );
    const variants = {
      types: [functionRecord],
      'workerd.types': [{ ...functionRecord, name: 'workerdRun' }],
    };
    expect(selectDeclarationSurface(variants, 'browser', 'import')).toBe(
      variants.types,
    );
    expect(selectDeclarationSurface(variants, 'workerd.import', 'import')).toBe(
      variants['workerd.types'],
    );
    expect(
      compareRuntimeBindings(
        selectDeclarationSurface(variants, 'browser', 'import'),
        {},
        '@openai/test browser',
      ),
    ).toEqual(['@openai/test browser.run has no runtime binding']);
  });

  test('preserves surfaces on released runtime condition routes', () => {
    const releasedExport = {
      types: './dist/index.d.ts',
      require: './dist/index.js',
      import: './dist/index.mjs',
    };
    const releasedVariants = { types: [functionRecord] };
    const nodeExport = {
      node: {
        types: './dist/node.d.ts',
        require: './dist/node.js',
        import: './dist/node.mjs',
      },
      ...releasedExport,
    };
    expect(
      compareResolvedConditionSurfaces(
        releasedExport,
        nodeExport,
        releasedVariants,
        { types: [functionRecord], 'node.types': [] },
        '@openai/test',
      ),
    ).toEqual([
      '@openai/test [default import].run was removed',
      '@openai/test [default require].run was removed',
    ]);

    const releasedBrowserExport = {
      browser: {
        types: './dist/browser.d.ts',
        require: './dist/browser.js',
        import: './dist/browser.mjs',
      },
      ...releasedExport,
    };
    expect(
      compareResolvedConditionSurfaces(
        releasedBrowserExport,
        releasedBrowserExport,
        {
          types: [functionRecord],
          'browser.types': [functionRecord],
        },
        { types: [functionRecord], 'browser.types': [] },
        '@openai/test',
      ),
    ).toEqual([
      '@openai/test [browser import].run was removed',
      '@openai/test [browser require].run was removed',
    ]);

    expect(
      compareResolvedConditionSurfaces(
        releasedExport,
        releasedBrowserExport,
        releasedVariants,
        { types: [functionRecord], 'browser.types': [] },
        '@openai/test',
      ),
    ).toEqual([]);
  });

  test('rejects resolution-blocking non-file condition terminals', () => {
    expect(
      validateExportTreeTerminals(
        {
          browser: null,
          workerd: { import: null },
          'react-native': null,
          custom: false,
        },
        '@openai/test',
      ),
    ).toEqual([
      '@openai/test condition browser has unsupported null export target',
      '@openai/test condition workerd.import has unsupported null export target',
      '@openai/test condition react-native has unsupported null export target',
      '@openai/test condition custom has unsupported boolean export target',
    ]);
    expect(
      validateExportTreeTerminals(
        { browser: ['./dist/first.mjs', './dist/fallback.mjs'] },
        '@openai/test',
      ),
    ).toEqual([
      '@openai/test condition browser has unsupported array export target',
    ]);
  });

  test('rejects Node-invalid package export target segments', () => {
    expect(validatePackageExportTarget('./dist/index.mjs')).toBeNull();
    expect(validatePackageExportTarget('./dist/../index.mjs')).toContain(
      'segment .. is not allowed',
    );
    expect(validatePackageExportTarget('./dist/%2e%2e/index.mjs')).toContain(
      'segment %2e%2e is not allowed',
    );
    expect(
      validatePackageExportTarget('./node_modules/pkg/index.mjs'),
    ).toContain('segment node_modules is not allowed');
    expect(validatePackageExportTarget('./dist\\index.mjs')).toBe(
      'backslashes are not allowed',
    );
    expect(validatePackageExportTarget('./dist%2Findex.mjs')).toBe(
      'encoded path separators are not allowed',
    );
  });

  test('rejects declaration kind and type/value-space changes', () => {
    expect(
      compareSurfaceRecords(
        [functionRecord],
        [{ ...functionRecord, kind: 'class' }],
        '@openai/test',
      ),
    ).toEqual([
      '@openai/test.run changed declaration kind from function to class',
    ]);
    expect(
      compareSurfaceRecords(
        [functionRecord],
        [{ ...functionRecord, spaces: ['type'] }],
        '@openai/test',
      ),
    ).toContain('@openai/test.run lost its value binding');
  });

  test('accepts new exports without freezing callable signatures', () => {
    expect(
      compareSurfaceRecords(
        [functionRecord],
        [
          functionRecord,
          {
            name: 'newExport',
            spaces: ['value'],
            sdkOwned: true,
            kind: 'variable',
          },
        ],
        '@openai/test',
      ),
    ).toEqual([]);
  });

  test('skips unsupported require routes owned by optional peers', () => {
    const error = {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
      message:
        'No "exports" main defined in /tmp/node_modules/@openai/codex-sdk/package.json',
    };
    const manifest = {
      peerDependenciesMeta: {
        '@openai/codex-sdk': { optional: true },
      },
    };
    expect(
      isUnsupportedOptionalPeerFormat(
        error,
        manifest,
        'require',
        '@openai/agents-extensions/experimental/codex',
      ),
    ).toBe(true);
    expect(
      isUnsupportedOptionalPeerFormat(
        error,
        manifest,
        'import',
        '@openai/agents-extensions/experimental/codex',
      ),
    ).toBe(false);
    for (const specifier of [
      '@openai/agents-extensions',
      '@openai/agents-extensions/sandbox/runloop',
    ]) {
      expect(
        isUnsupportedOptionalPeerFormat(error, manifest, 'require', specifier),
      ).toBe(false);
    }
    expect(
      isUnsupportedOptionalPeerFormat(
        {
          ...error,
          message:
            'Package subpath ./internal is not defined by exports in /tmp/node_modules/@openai/codex-sdk/package.json',
        },
        manifest,
        'require',
        '@openai/agents-extensions/experimental/codex',
      ),
    ).toBe(false);
  });

  test('uses stable member descriptors for generic types', () => {
    const released = {
      name: 'Output',
      spaces: ['type'],
      sdkOwned: true,
      kind: 'type',
      members: [member('value')],
    };
    const candidate = {
      ...released,
      members: [],
    };
    expect(
      compareSurfaceRecords([released], [candidate], '@openai/test'),
    ).toEqual(['@openai/test.Output.value was removed']);
  });

  test('rejects enum member removal and value changes but accepts additions', () => {
    const released = {
      name: 'Mode',
      spaces: ['type', 'value'],
      sdkOwned: true,
      kind: 'enum',
      enumMembers: [
        { name: 'Fast', value: 'fast' },
        { name: 'Safe', value: 'safe' },
      ],
    };
    const candidate = {
      ...released,
      enumMembers: [
        { name: 'Fast', value: 'quick' },
        { name: 'New', value: 'new' },
      ],
    };
    expect(
      compareSurfaceRecords([released], [candidate], '@openai/test'),
    ).toEqual([
      '@openai/test.Mode.Fast enum value changed',
      '@openai/test.Mode.Safe enum member was removed',
    ]);
  });

  test('rejects replacing single literal aliases and accepts widening', () => {
    const released = {
      name: 'TextOutput',
      spaces: ['type'],
      sdkOwned: true,
      kind: 'type',
      literals: ["'text'"],
    };
    expect(
      compareSurfaceRecords(
        [released],
        [{ ...released, literals: ["'markdown'"] }],
        '@openai/test',
      ),
    ).toEqual(["@openai/test.TextOutput removed literal 'text'"]);
    expect(
      compareSurfaceRecords(
        [released],
        [{ ...released, literals: ["'markdown'", "'text'"] }],
        '@openai/test',
      ),
    ).toEqual([]);
  });

  test('preserves boolean members in released literal unions', () => {
    const released = {
      name: 'E2BWorkspacePersistence',
      spaces: ['type'],
      sdkOwned: true,
      kind: 'type',
      ...describeDeclaration(
        "type E2BWorkspacePersistence = true | 'tar' | 'snapshot';",
      ),
    };
    expect(released.literals).toEqual(['"snapshot"', '"tar"', 'true']);
    expect(
      compareSurfaceRecords(
        [released],
        [
          {
            ...released,
            literals: released.literals.filter((item) => item !== 'true'),
          },
        ],
        '@openai/agents-extensions/sandbox/e2b',
      ),
    ).toEqual([
      '@openai/agents-extensions/sandbox/e2b.E2BWorkspacePersistence removed literal true',
    ]);
    expect(
      compareSurfaceRecords(
        [released],
        [
          {
            ...released,
            literals: [...released.literals, 'false'],
          },
        ],
        '@openai/agents-extensions/sandbox/e2b',
      ),
    ).toEqual([]);
  });

  test('rejects selected callable signature changes in shallow comparisons', () => {
    const callableSignature = {
      typeParameters: [{ constraint: null, default: 'unknown' }],
      parameters: [
        {
          optional: false,
          rest: false,
          type: 'OutputGuardrailBlockedMessageArgs<T0>',
        },
      ],
      returnType: 'string | Promise<string | undefined> | undefined',
    };
    const released = {
      name: 'OutputGuardrailBlockedMessageFormatter',
      spaces: ['type'],
      sdkOwned: true,
      kind: 'type',
      callableSignature,
    };
    const candidate = {
      ...released,
      callableSignature: {
        typeParameters: [{ constraint: 'object', default: null }],
        parameters: [
          {
            optional: true,
            rest: true,
            type: 'OutputGuardrailBlockedMessageArgs<unknown>',
          },
        ],
        returnType: 'string',
      },
    };
    expect(
      compareSurfaceRecords([released], [candidate], '@openai/agents-core', {
        deep: false,
      }),
    ).toEqual([
      '@openai/agents-core.OutputGuardrailBlockedMessageFormatter callable type parameter 0 changed constraint',
      '@openai/agents-core.OutputGuardrailBlockedMessageFormatter callable type parameter 0 changed default',
      '@openai/agents-core.OutputGuardrailBlockedMessageFormatter callable parameter 0 changed optionality',
      '@openai/agents-core.OutputGuardrailBlockedMessageFormatter callable parameter 0 changed rest kind',
      '@openai/agents-core.OutputGuardrailBlockedMessageFormatter callable parameter 0 changed type',
      '@openai/agents-core.OutputGuardrailBlockedMessageFormatter changed callable return type',
    ]);
  });

  test('rejects losing a selected callable signature', () => {
    const released = {
      name: 'Formatter',
      spaces: ['type'],
      sdkOwned: true,
      kind: 'type',
      callableSignature: {
        typeParameters: [],
        parameters: [],
        returnType: 'string',
      },
    };
    expect(
      compareSurfaceRecords(
        [released],
        [{ ...released, callableSignature: undefined }],
        '@openai/test',
      ),
    ).toEqual(['@openai/test.Formatter lost its selected callable signature']);
  });

  test('rejects missing namespace members and changed convenience identity', () => {
    const released = {
      name: 'realtime',
      spaces: ['value'],
      sdkOwned: true,
      kind: 'namespace',
      namespaceMembers: [{ name: 'RealtimeAgent', spaces: ['type', 'value'] }],
    };
    expect(
      compareSurfaceRecords(
        [released],
        [{ ...released, namespaceMembers: [] }],
        '@openai/agents',
      ),
    ).toEqual([
      '@openai/agents.realtime.RealtimeAgent namespace member was removed',
    ]);
    expect(
      compareRuntimeBindings([released], { realtime: {} }, '@openai/agents'),
    ).toEqual(['@openai/agents.realtime.RealtimeAgent has no runtime binding']);
    const ownerBinding = {};
    expect(
      compareNamespaceBindingIdentity(
        { RealtimeAgent: ownerBinding },
        { RealtimeAgent: ownerBinding },
        '@openai/agents.realtime',
        '@openai/agents-realtime',
        'import',
      ),
    ).toEqual([]);
    expect(
      compareNamespaceBindingIdentity(
        { RealtimeAgent: {} },
        { RealtimeAgent: ownerBinding },
        '@openai/agents.realtime',
        '@openai/agents-realtime',
        'import',
      ),
    ).toEqual([
      '@openai/agents.realtime.RealtimeAgent is not the @openai/agents-realtime runtime binding in import',
    ]);

    const identityPairs = [
      {
        bundle: '@openai/agents/realtime',
        bundleLabel: '@openai/agents/realtime',
        owner: '@openai/agents-realtime',
        ownerLabel: '@openai/agents-realtime',
      },
    ];
    expect(
      compareConvenienceBindingIdentity(
        {
          '@openai/agents/realtime': { RealtimeAgent: ownerBinding },
          '@openai/agents-realtime': { RealtimeAgent: ownerBinding },
        },
        identityPairs,
        'import',
        ' conditions react-native',
      ),
    ).toEqual([]);
    expect(
      compareConvenienceBindingIdentity(
        {
          '@openai/agents/realtime': { RealtimeAgent: {} },
          '@openai/agents-realtime': { RealtimeAgent: ownerBinding },
        },
        identityPairs,
        'import',
        ' conditions browser',
      ),
    ).toEqual([
      '@openai/agents/realtime.RealtimeAgent is not the @openai/agents-realtime runtime binding in import conditions browser',
    ]);
  });

  test('does not freeze third-party callable signatures', () => {
    const released = { ...functionRecord, sdkOwned: false };
    const candidate = { ...released, kind: 'class' };
    expect(
      compareSurfaceRecords([released], [candidate], '@openai/test'),
    ).toEqual([]);
  });

  test('rejects removing an SDK-owned object property', () => {
    const released = {
      name: 'Settings',
      spaces: ['type'],
      sdkOwned: true,
      kind: 'type',
      members: [member('model')],
    };
    expect(
      compareSurfaceRecords(
        [released],
        [{ ...released, members: [] }],
        '@openai/test',
      ),
    ).toEqual(['@openai/test.Settings.model was removed']);
  });

  test('rejects optional member removal even when types are assignable', () => {
    const released = {
      name: 'Settings',
      spaces: ['type'],
      sdkOwned: true,
      kind: 'interface',
      members: [{ ...member('model'), optional: true }],
    };
    const candidate = {
      ...released,
      members: [],
    };
    expect(
      compareSurfaceRecords([released], [candidate], '@openai/test'),
    ).toEqual(['@openai/test.Settings.model was removed']);
  });

  test('rejects required object members but accepts optional additions', () => {
    const released = {
      name: 'Settings',
      spaces: ['type'],
      sdkOwned: true,
      kind: 'interface',
      members: [member('model')],
    };
    const candidate = {
      ...released,
      members: [
        member('model'),
        member('requiredProperty'),
        member('requiredCallableProperty', true),
        { ...member('optionalProperty'), optional: true },
      ],
    };
    expect(
      compareSurfaceRecords([released], [candidate], '@openai/test'),
    ).toEqual([
      '@openai/test.Settings.requiredProperty added required member',
      '@openai/test.Settings.requiredCallableProperty added required member',
    ]);
  });

  test('rejects required members added to empty object types', () => {
    const released = {
      name: 'Settings',
      spaces: ['type'],
      sdkOwned: true,
      kind: 'type',
      members: [],
    };
    expect(
      compareSurfaceRecords(
        [released],
        [{ ...released, members: [member('requiredProperty')] }],
        '@openai/test',
      ),
    ).toEqual(['@openai/test.Settings.requiredProperty added required member']);
    expect(
      compareSurfaceRecords(
        [released],
        [
          {
            ...released,
            members: [{ ...member('optionalProperty'), optional: true }],
          },
        ],
        '@openai/test',
      ),
    ).toEqual([]);
  });

  test('accepts public class member additions', () => {
    const released = {
      name: 'Agent',
      spaces: ['type', 'value'],
      sdkOwned: true,
      kind: 'class',
      members: [],
      staticMembers: [],
    };
    const candidate = {
      ...released,
      members: [member('newProperty')],
      staticMembers: [member('newFactory', true)],
    };
    expect(
      compareSurfaceRecords([released], [candidate], '@openai/test'),
    ).toEqual([]);
  });

  test('rejects removing public class constructibility', () => {
    const released = {
      name: 'Client',
      spaces: ['type', 'value'],
      sdkOwned: true,
      kind: 'class',
      ...describeDeclaration(
        'export class Client { constructor(value: string); }',
        'class',
      ),
    };
    expect(released.constructible).toBe(true);
    for (const accessibility of ['private', 'protected']) {
      const candidate = {
        ...released,
        ...describeDeclaration(
          `export class Client { ${accessibility} constructor(value: string); }`,
          'class',
        ),
      };
      expect(candidate.constructible).toBe(false);
      expect(
        compareSurfaceRecords([released], [candidate], '@openai/test'),
      ).toEqual(['@openai/test.Client is no longer publicly constructible']);
    }
    const changedSignature = {
      ...released,
      ...describeDeclaration(
        'export class Client { constructor(value: number, extra: boolean); }',
        'class',
      ),
    };
    expect(
      compareSurfaceRecords([released], [changedSignature], '@openai/test'),
    ).toEqual([]);
  });

  test('rejects removing a public static class member', () => {
    const released = {
      name: 'Agent',
      spaces: ['type', 'value'],
      sdkOwned: true,
      kind: 'class',
      members: [],
      staticMembers: [member('create', true)],
    };
    expect(
      compareSurfaceRecords(
        [released],
        [{ ...released, staticMembers: [] }],
        '@openai/test',
      ),
    ).toEqual(['@openai/test.Agent static.create was removed']);
  });

  test('rejects changing a class member between callable and property', () => {
    const released = {
      name: 'Agent',
      spaces: ['type', 'value'],
      sdkOwned: true,
      kind: 'class',
      members: [member('run', true)],
      staticMembers: [],
    };
    expect(
      compareSurfaceRecords(
        [released],
        [{ ...released, members: [member('run', false)] }],
        '@openai/test',
      ),
    ).toEqual(['@openai/test.Agent.run changed callable kind']);
  });

  test('delegates methods while retaining callable-valued properties', () => {
    const interfaceDescriptor = describeDeclaration(
      `export interface Settings {
        method(): void;
        callableProperty: () => void;
        value: string;
      }`,
      'interface',
    );
    expect(interfaceDescriptor.members).toEqual([
      member('callableProperty', true),
      member('value'),
    ]);
    expect(interfaceDescriptor.methodNames).toEqual(['method']);

    const classDescriptor = describeDeclaration(
      `export class Client {
        method(): void {}
        callableProperty = () => {};
        static factory(): Client { return new Client(); }
        static callableFactory = () => new Client();
      }`,
      'class',
    );
    expect(classDescriptor.members).toEqual([member('callableProperty', true)]);
    expect(classDescriptor.methodNames).toEqual(['method']);
    expect(classDescriptor.staticMembers).toEqual([
      member('callableFactory', true),
    ]);
  });

  test('excludes ECMAScript private identifiers from public members', () => {
    const source = ts.createSourceFile(
      'fixture.ts',
      'class Example { #secret = 1; public value = 1; }',
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const classDeclaration = source.statements[0];
    expect(ts.isClassDeclaration(classDeclaration)).toBe(true);
    expect(isPublicDeclaration(classDeclaration.members[0])).toBe(false);
    expect(isPublicDeclaration(classDeclaration.members[1])).toBe(true);
  });

  test('normalizes get-only accessors as readonly members', () => {
    const source = ts.createSourceFile(
      'fixture.ts',
      `class Example {
        get getterOnly(): string { return 'x'; }
        get writableAccessor(): string { return 'x'; }
        set writableAccessor(value: string) {}
        readonly readonlyField = 'x';
        mutableField = 'x';
      }`,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const classDeclaration = source.statements[0];
    expect(ts.isClassDeclaration(classDeclaration)).toBe(true);
    expect(isReadonlyDeclarations([classDeclaration.members[0]])).toBe(true);
    expect(
      isReadonlyDeclarations([
        classDeclaration.members[1],
        classDeclaration.members[2],
      ]),
    ).toBe(false);
    expect(isReadonlyDeclarations([classDeclaration.members[3]])).toBe(true);
    expect(isReadonlyDeclarations([classDeclaration.members[4]])).toBe(false);
  });

  test('limits the no-extra profile to optional-provider-safe imports', () => {
    expect(isSafeWithoutOptionalPeers('@openai/agents-core', '.')).toBe(true);
    expect(isSafeWithoutOptionalPeers('@openai/agents-extensions', '.')).toBe(
      true,
    );
    expect(
      isSafeWithoutOptionalPeers(
        '@openai/agents-extensions',
        './sandbox/runloop',
      ),
    ).toBe(false);
  });

  test('rejects optional peer metadata drift', () => {
    expect(
      compareOptionalPeers(
        { optionalPeers: ['provider'] },
        {
          peerDependencies: { provider: '^1.0.0' },
          peerDependenciesMeta: {},
        },
        '@openai/test',
      ),
    ).toEqual(['@openai/test peer provider is no longer optional']);
  });

  test('rejects missing selected class properties', () => {
    const surfaces = {
      '@openai/test': {
        './platform': {
          types: [
            {
              name: 'Platform',
              members: [{ name: 'blueprints' }],
              methodNames: ['platform'],
            },
          ],
        },
      },
    };
    expect(
      validateSelectedProperties(surfaces, [
        {
          package: '@openai/test',
          subpath: './platform',
          export: 'Platform',
          properties: ['blueprints', 'platform', 'secrets'],
        },
      ]),
    ).toEqual(['@openai/test/platform.Platform.secrets was removed']);
  });

  test('validates selected public type aliases across declaration conditions', () => {
    const callableRecord = {
      name: 'Formatter',
      spaces: ['type'],
      sdkOwned: true,
      kind: 'type',
      callableSignature: {
        typeParameters: [],
        parameters: [],
        returnType: 'string',
      },
    };
    const policy = [
      {
        package: '@openai/test',
        subpath: '.',
        export: 'Formatter',
        kind: 'callable',
      },
    ];
    expect(
      validateSelectedPublicTypeAliases(
        {
          '@openai/test': {
            '.': {
              types: [callableRecord],
              'browser.types': [
                { ...callableRecord, callableSignature: undefined },
              ],
            },
          },
        },
        policy,
      ),
    ).toEqual([
      '@openai/test.Formatter selected public type alias has no callable definition in browser.types',
    ]);
    expect(validateSelectedPublicTypeAliases({}, policy)).toEqual([
      '@openai/test.Formatter selected public type alias is missing',
    ]);
  });

  test('normalizes selected public type alias policy', () => {
    const policy = [
      {
        package: '@openai/agents-core',
        subpath: '.',
        export: 'OutputGuardrailBlockedMessageFormatter',
        kind: 'callable',
      },
    ];
    expect(normalizeSelectedPublicTypeAliases(policy)).toEqual(policy);
    expect(() =>
      normalizeSelectedPublicTypeAliases([...policy, { ...policy[0] }]),
    ).toThrow(
      'selectedPublicTypeAliases repeats @openai/agents-core.OutputGuardrailBlockedMessageFormatter',
    );
    expect(() =>
      normalizeSelectedPublicTypeAliases([{ ...policy[0], kind: 'union' }]),
    ).toThrow('has unsupported kind union');
  });

  test('preserves selection policies during promotion', () => {
    const selectedPublicProperties = [{ export: 'Client' }];
    const selectedPublicTypeAliases = [{ export: 'Formatter' }];
    const selectedPublicObjectProperties = [{ export: 'webSearchTool' }];
    expect(
      preservedSelectionPolicies({
        selectedPublicProperties,
        selectedPublicTypeAliases,
        selectedPublicObjectProperties,
      }),
    ).toEqual({
      selectedPublicProperties,
      selectedPublicTypeAliases,
      selectedPublicObjectProperties,
    });
  });

  test('rejects missing runtime and convenience bindings', () => {
    expect(
      compareRuntimeBindings(
        [functionRecord],
        {},
        '@openai/agents convenience export',
      ),
    ).toEqual(['@openai/agents convenience export.run has no runtime binding']);
  });

  test('removes temporary installs when npm installation fails', async () => {
    let installRoot;
    await expect(
      installTarballs({}, 'https://registry.npmjs.org', async (_args, cwd) => {
        installRoot = cwd;
        throw new Error('installation failed');
      }),
    ).rejects.toThrow('installation failed');
    await expect(access(installRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('cleans acquired package resources when a sibling acquisition fails', async () => {
    const cleaned = [];
    await expect(
      withAcquiredResources(
        [
          async () => ({
            async cleanup() {
              cleaned.push('first');
            },
          }),
          async () => {
            throw new Error('second acquisition failed');
          },
        ],
        async () => {},
      ),
    ).rejects.toThrow('second acquisition failed');
    expect(cleaned).toEqual(['first']);

    await expect(
      withAcquiredResources(
        [
          async () => ({
            async cleanup() {
              cleaned.push('cleanup failure');
              throw new Error('cleanup failed');
            },
          }),
          async () => ({
            async cleanup() {
              cleaned.push('second');
            },
          }),
        ],
        async () => {},
      ),
    ).rejects.toThrow('cleanup failed');
    expect(cleaned).toContain('second');

    const operationCleaned = [];
    await expect(
      withAcquiredResources(
        [
          async () => ({
            async cleanup() {
              operationCleaned.push('released');
              throw new Error('released cleanup failed');
            },
          }),
          async () => ({
            async cleanup() {
              operationCleaned.push('baseline');
            },
          }),
        ],
        async () => {
          throw new Error('promotion validation failed');
        },
      ),
    ).rejects.toThrow('promotion validation failed');
    expect(operationCleaned).toEqual(['baseline', 'released']);
  });
});

const imageObjectPolicy = {
  package: '@openai/agents-openai',
  subpath: '.',
  export: 'webSearchTool',
  parameter: 0,
  property: 'imageSettings',
  optional: true,
  readonly: false,
  fields: [
    { name: 'maxResults', type: 'number', optional: true, readonly: false },
    { name: 'caption', type: 'boolean', optional: true, readonly: false },
  ],
};
const imagePolicies = [
  imageObjectPolicy,
  { ...imageObjectPolicy, package: '@openai/agents' },
];
const imageFields = 'maxResults?: number; caption?: boolean;';
function webSearchDeclaration(fields = imageFields, outer = 'imageSettings?') {
  return `type WebSearchTool = { type: 'web_search'; ${outer}: { ${fields} }; filters?: { arbitrary?: Date } };
  export declare function webSearchTool(options?: Partial<Omit<WebSearchTool, 'type'>>): unknown;`;
}

// Public entrypoint fixtures exercise compiler utility-type resolution and re-exports without builds.
async function withObjectFixture(source, callback, browserSource = source) {
  const root = await mkdtemp(path.join(tmpdir(), 'agents-selected-object-'));
  const packages = {};
  try {
    for (const [name, directory] of PUBLIC_PACKAGES) {
      const packageRoot = path.join(root, directory);
      const entries = {};
      const exportNode = {
        types: './dist/index.d.ts',
        import: './dist/index.mjs',
        require: './dist/index.js',
      };
      for (const mode of ['src', 'dist']) {
        const suffix = mode === 'src' ? '.ts' : '.d.ts';
        const dir = path.join(packageRoot, mode);
        await mkdir(dir, { recursive: true });
        const entryText =
          name === '@openai/agents-openai'
            ? "export { webSearchTool } from './tools';"
            : name === '@openai/agents'
              ? `export * from '../../agents-openai/${mode}/index';`
              : 'export {};';
        // ES5 includes the real utility types used here; unrelated DOM/ESNext libraries slow fixture compilation.
        await writeFile(
          path.join(dir, `index${suffix}`),
          `/// <reference no-default-lib="true"/>\n/// <reference lib="es5"/>\n${entryText}`,
        );
        await writeFile(path.join(dir, `tools${suffix}`), source);
        await writeFile(
          path.join(dir, `browser${suffix}`),
          name === '@openai/agents-openai' ? browserSource : entryText,
        );
      }
      entries['.'] = {
        exportNode,
        declarations: ['types', 'browser.types'].map((condition) => ({
          condition,
          target:
            condition === 'types' ? './dist/index.d.ts' : './dist/browser.d.ts',
          entryFile: path.join(
            packageRoot,
            'dist',
            condition === 'types' ? 'index.d.ts' : 'browser.d.ts',
          ),
        })),
      };
      packages[name] = {
        packageRoot,
        manifest: { exports: { '.': exportNode } },
        entries,
      };
    }
    const inspect = (policies = imagePolicies, mode = 'dist') =>
      inspectPackageSet(
        Object.fromEntries(
          Object.entries(packages).map(([name, info]) => [
            name,
            {
              ...info,
              entries: {
                '.': {
                  ...info.entries['.'],
                  declarations: info.entries['.'].declarations.map((entry) => ({
                    ...entry,
                    entryFile:
                      mode === 'source'
                        ? entry.entryFile
                            .replace('/dist/', '/src/')
                            .replace(/\.d\.ts$/, '.ts')
                        : entry.entryFile,
                  })),
                },
              },
            },
          ]),
        ),
        mode,
        [],
        policies,
      );
    const contract = {
      packages: Object.fromEntries(
        Object.entries(packages).map(([name, info]) => [
          name,
          {
            exports: info.manifest.exports,
            optionalPeers: [],
          },
        ]),
      ),
      selectedPublicObjectProperties: imagePolicies,
    };
    await callback({ inspect, packages, contract, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function inspectObjects(
  source = webSearchDeclaration(),
  policies = imagePolicies,
) {
  let surfaces;
  await withObjectFixture(source, async ({ inspect }) => {
    surfaces = await inspect(policies);
  });
  return surfaces;
}

// Compiler fixtures also run alongside the full repository verification stack.
describe(
  'selected public object property contracts',
  { timeout: 15_000 },
  () => {
    test('extracts the complete public argument through utility types and convenience exports', async () => {
      await withObjectFixture(webSearchDeclaration(), async ({ inspect }) => {
        for (const mode of ['source', 'dist']) {
          const surfaces = await inspect(imagePolicies, mode);
          expect(
            validateSelectedPublicObjectProperties(surfaces, imagePolicies),
          ).toEqual([]);
          for (const policy of imagePolicies) {
            expect(
              surfaces[policy.package]['.'].types[0].objectProperties,
            ).toEqual([
              {
                parameter: 0,
                property: 'imageSettings',
                optional: true,
                readonly: false,
                fields: [
                  imageObjectPolicy.fields[1],
                  imageObjectPolicy.fields[0],
                ],
              },
            ]);
          }
        }
      });
    });

    test('requires complete policy for a fresh selection, including optional additions', async () => {
      const incomplete = [
        { ...imageObjectPolicy, fields: [imageObjectPolicy.fields[0]] },
      ];
      const surfaces = await inspectObjects(undefined, incomplete);
      expect(
        validateSelectedPublicObjectProperties(surfaces, incomplete),
      ).toContain(
        '@openai/agents-openai.webSearchTool [types].parameter[0].imageSettings.caption is missing from the complete selected object policy',
      );
      const added = await inspectObjects(
        webSearchDeclaration(`${imageFields} enabled?: boolean;`),
      );
      expect(
        validateSelectedPublicObjectProperties(added, imagePolicies).join('\n'),
      ).toContain(
        'enabled is missing from the complete selected object policy',
      );
      const enrolled = imagePolicies.map((policy) => ({
        ...policy,
        fields: [
          ...policy.fields,
          { name: 'enabled', type: 'boolean', optional: true, readonly: false },
        ],
      }));
      expect(validateSelectedPublicObjectProperties(added, enrolled)).toEqual(
        [],
      );
    });

    test.each([
      ['maxResults?: number;', 'caption was removed'],
      [
        'maxResults: number; caption?: boolean;',
        'maxResults changed optionality',
      ],
      ['maxResults?: string; caption?: boolean;', 'maxResults changed type'],
      [
        'readonly maxResults?: number; caption?: boolean;',
        'maxResults changed readonly status',
      ],
    ])('rejects candidate drift: %s', async (fields, error) => {
      const surfaces = await inspectObjects(webSearchDeclaration(fields));
      expect(
        validateSelectedPublicObjectProperties(surfaces, imagePolicies).join(
          '\n',
        ),
      ).toContain(error);
    });

    test('preserves the outer property shape', async () => {
      const source =
        'export declare function webSearchTool(options?: { readonly imageSettings: { maxResults?: number; caption?: boolean } }): unknown;';
      const errors = validateSelectedPublicObjectProperties(
        await inspectObjects(source),
        imagePolicies,
      ).join('\n');
      expect(errors).toContain('imageSettings changed optionality');
      expect(errors).toContain('imageSettings changed readonly status');
    });

    test.each([false, true])(
      'uses effective mapped readonly (original readonly: %s)',
      async (originalReadonly) => {
        const declaration = webSearchDeclaration(
          imageFields,
          originalReadonly ? 'readonly imageSettings?' : 'imageSettings?',
        );
        const baselinePolicies = imagePolicies.map((policy) => ({
          ...policy,
          readonly: originalReadonly,
        }));
        const baseline = await inspectObjects(declaration, baselinePolicies);
        const changed =
          'type Mutable<T> = { -readonly [K in keyof T]: T[K] };\n' +
          declaration.replace(
            "Partial<Omit<WebSearchTool, 'type'>>",
            `${originalReadonly ? 'Mutable' : 'Readonly'}<Partial<Omit<WebSearchTool, 'type'>>>`,
          );
        await withObjectFixture(
          changed,
          async ({ inspect, root, packages, contract }) => {
            const candidate = await inspect(baselinePolicies);
            expect(
              validateSelectedPublicObjectProperties(
                candidate,
                baselinePolicies,
              ).join('\n'),
            ).toContain('imageSettings changed readonly status');
            expect(
              comparePackageSets(
                {
                  ...contract,
                  selectedPublicObjectProperties: baselinePolicies,
                },
                baseline,
                packages,
                candidate,
                false,
              ).join('\n'),
            ).toContain('imageSettings changed readonly status');
            // A consumer assignment is the independent oracle for the effective public property.
            const consumer = path.join(root, 'consumer.ts');
            await writeFile(
              consumer,
              `import { webSearchTool } from './agents-openai/dist/index';
        declare let options: NonNullable<Parameters<typeof webSearchTool>[0]>;
        options.imageSettings = {};`,
            );
            const program = ts.createProgram([consumer], {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              types: [],
            });
            const diagnostics = ts
              .getPreEmitDiagnostics(program)
              .filter((diagnostic) => diagnostic.file?.fileName === consumer);
            expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
              originalReadonly ? [] : [2540],
            );
          },
        );
      },
    );

    test('compares released fields independently of edited policy in shallow and deep modes', async () => {
      const baseline = await inspectObjects();
      const edited = imagePolicies.map((policy) => ({
        ...policy,
        fields: [policy.fields[0]],
      }));
      await withObjectFixture(
        webSearchDeclaration('maxResults?: number;'),
        async ({ inspect, contract, packages }) => {
          const candidate = await inspect(edited);
          expect(
            validateSelectedPublicObjectProperties(candidate, edited),
          ).toEqual([]);
          for (const deep of [false, true]) {
            expect(
              comparePackageSets(
                { ...contract, selectedPublicObjectProperties: edited },
                baseline,
                packages,
                candidate,
                deep,
              ).join('\n'),
            ).toContain('caption was removed');
          }
        },
      );
    });

    test('accepts an absent old baseline and rejects newly required released fields', async () => {
      const old = await inspectObjects(
        'export declare function webSearchTool(options?: { filters?: unknown }): unknown;',
      );
      const released = await inspectObjects();
      await withObjectFixture(
        webSearchDeclaration(),
        async ({ inspect, contract, packages }) => {
          expect(
            comparePackageSets(contract, old, packages, await inspect(), false),
          ).toEqual([]);
        },
      );
      const required = imagePolicies.map((policy) => ({
        ...policy,
        fields: [
          ...policy.fields,
          {
            name: 'enabled',
            type: 'boolean',
            optional: false,
            readonly: false,
          },
        ],
      }));
      await withObjectFixture(
        webSearchDeclaration(`${imageFields} enabled: boolean;`),
        async ({ inspect, contract, packages }) => {
          expect(
            comparePackageSets(
              { ...contract, selectedPublicObjectProperties: required },
              released,
              packages,
              await inspect(required),
              true,
            ).join('\n'),
          ).toContain('enabled added required member');
        },
      );
    });

    test('validates every declaration condition and missing selections', async () => {
      await withObjectFixture(
        webSearchDeclaration(),
        async ({ inspect }) => {
          expect(
            validateSelectedPublicObjectProperties(
              await inspect(),
              imagePolicies,
            ).join('\n'),
          ).toContain(
            '[browser.types].parameter[0].imageSettings.caption was removed',
          );
        },
        webSearchDeclaration('maxResults?: number;'),
      );
      for (const source of [
        'export declare function webSearchTool(): unknown;',
        'export declare function webSearchTool(options?: {}): unknown;',
      ]) {
        expect(
          validateSelectedPublicObjectProperties(
            await inspectObjects(source),
            imagePolicies,
          ).join('\n'),
        ).toContain('selected object property is missing');
      }
      expect(
        validateSelectedPublicObjectProperties({}, imagePolicies).join('\n'),
      ).toContain('selected object property is missing');
    });

    test.each([
      [
        'export declare function webSearchTool<T>(options: T): unknown;',
        'single non-generic',
      ],
      [
        'export declare function webSearchTool(options: string): unknown; export declare function webSearchTool(options: number): unknown;',
        'single non-generic',
      ],
      [
        'export declare function webSearchTool(...options: unknown[]): unknown;',
        'rest parameter',
      ],
      [
        'export declare function webSearchTool(options: { imageSettings?: { caption?: boolean } | { maxResults?: number } }): unknown;',
        'direct object literal',
      ],
      [
        webSearchDeclaration('[name: string]: number;'),
        'only property signatures',
      ],
      [webSearchDeclaration('caption(): boolean;'), 'only property signatures'],
      [webSearchDeclaration('maxResults?: { value: number };'), 'primitive'],
      [webSearchDeclaration('caption?: () => boolean;'), 'primitive'],
      [webSearchDeclaration('caption?: boolean | null;'), 'primitive'],
    ])(
      'rejects unsupported selected declarations without recursive enrollment',
      async (source, error) => {
        await expect(inspectObjects(source)).rejects.toThrow(error);
        const unselected = await inspectObjects(source, []);
        expect(
          unselected['@openai/agents-openai']['.'].types[0],
        ).not.toHaveProperty('objectProperties');
      },
    );

    test('validates policy schema and duplicate selections before acquisition', () => {
      expect(normalizeSelectedPublicObjectProperties(imagePolicies)).toEqual(
        imagePolicies,
      );
      expect(normalizeSelectedPublicObjectProperties()).toEqual([]);
      for (const value of [
        null,
        {},
        [{ ...imageObjectPolicy, fields: undefined }],
        [{ ...imageObjectPolicy, parameter: -1 }],
        [{ ...imageObjectPolicy, unknown: true }],
      ]) {
        expect(() => normalizeSelectedPublicObjectProperties(value)).toThrow();
      }
      expect(() =>
        normalizeSelectedPublicObjectProperties([
          imageObjectPolicy,
          imageObjectPolicy,
        ]),
      ).toThrow('repeats');
      expect(() =>
        normalizeSelectedPublicObjectProperties([
          {
            ...imageObjectPolicy,
            fields: [imageObjectPolicy.fields[0], imageObjectPolicy.fields[0]],
          },
        ]),
      ).toThrow('exactly once');
    });
  },
);

// Replace acquisition and inspection; validate real policy against declaration fixtures and write only temporary artifacts.
test('the CLI validates complete selections in package profiles and promotion before writing', async () => {
  await withObjectFixture(
    webSearchDeclaration(),
    async ({ inspect, packages, contract, root }) => {
      const surfaces = await inspect();
      const brokenPolicy = imagePolicies.map((entry) => ({
        ...entry,
        fields: [entry.fields[0]],
      }));
      for (const [command, hasBaseline, invalid] of [
        ['source', true, true],
        ['dist', true, true],
        ['package', true, true],
        ['package', true, false],
        ['promote', false, true],
        ['promote', true, true],
        ['promote', false, false],
        ['promote', true, false],
      ]) {
        const input = {
          ...contract,
          packages: hasBaseline ? contract.packages : {},
          selectedPublicObjectProperties: invalid
            ? brokenPolicy
            : imagePolicies,
        };
        const artifact = path.join(
          root,
          `contract-${command}-${hasBaseline}-${invalid}.json`,
        );
        const inspections = [];
        const cleaned = vi.fn();
        const loaded = {
          roots: {},
          packed: Object.fromEntries(
            PUBLIC_PACKAGES.map(([name]) => [
              name,
              { integrity: 'fixture-integrity' },
            ]),
          ),
          installRoot: '/fixture',
          cleanup: cleaned,
        };
        const compare = async (policy) => ({
          errors: contractSurface.comparePackageSets(
            policy,
            surfaces,
            packages,
            surfaces,
            true,
          ),
          candidateSurfaces: surfaces,
        });
        vi.resetModules();
        vi.doMock('./released-api-contract-surface.mjs', () => ({
          ...contractSurface,
          readJson: async () => input,
          loadPackageSet: async () => packages,
          inspectPackageSet: async (...args) => {
            inspections.push(args);
            return surfaces;
          },
          inspectAndComparePackageSets: compare,
          assertAllTargetsExist: async () => [],
        }));
        vi.doMock('./released-api-contract-execution.mjs', () => ({
          ...contractExecution,
          materializePublished: async () => loaded,
          installFromRegistry: async () => loaded,
          installOptionalPeers: async () => {},
          validateRuntime: async () => [],
          validatePublicSpecifiers: async () => [],
          execFile: async () => ({ stdout: 'fixture-commit' }),
        }));
        const savedArgv = process.argv;
        const savedExit = process.exitCode;
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          process.argv = [
            process.execPath,
            fileURLToPath(
              new URL('./released-api-contract.mjs', import.meta.url),
            ),
            command,
            '--contract',
            artifact,
            '--version',
            '1.0.0',
          ];
          await import('./released-api-contract.mjs');
          await vi.waitFor(() =>
            expect(log.mock.calls.length + error.mock.calls.length).toBe(1),
          );
          if (invalid) {
            expect(error.mock.calls[0][0]).toContain(
              'caption is missing from the complete selected object policy',
            );
            await expect(access(artifact)).rejects.toMatchObject({
              code: 'ENOENT',
            });
          } else if (command === 'package') {
            expect(error).not.toHaveBeenCalled();
            expect(log.mock.calls[0][0]).toContain(
              'no-extra and all-optionals',
            );
          } else {
            expect(error).not.toHaveBeenCalled();
            expect(
              JSON.parse(await readFile(artifact, 'utf8'))
                .selectedPublicObjectProperties,
            ).toEqual(imagePolicies);
          }
          for (const args of inspections)
            expect(args[3]).toEqual(input.selectedPublicObjectProperties);
          expect(cleaned).toHaveBeenCalled();
        } finally {
          process.argv = savedArgv;
          process.exitCode = savedExit;
          log.mockRestore();
          error.mockRestore();
          vi.doUnmock('./released-api-contract-surface.mjs');
          vi.doUnmock('./released-api-contract-execution.mjs');
          vi.resetModules();
        }
      }
    },
  );
});
