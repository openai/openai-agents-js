import assert from 'node:assert/strict';
import test from 'node:test';

import { inventorySource } from './inventory-logging.mjs';

test('inventories static and dynamic logger calls', () => {
  const findings = inventorySource(`
    const logger = getLogger('fixture');
    logger.debug('ready');
    logger.warn(\`Failed for \${requestId}\`);
    logger.error('Request failed', error, response);
  `);

  assert.deepEqual(
    findings.map(({ method, shape, policy }) => ({ method, shape, policy })),
    [
      { method: 'debug', shape: 'static-message', policy: 'none' },
      { method: 'warn', shape: 'dynamic-message', policy: 'none' },
      { method: 'error', shape: 'payload', policy: 'none' },
    ],
  );
});

test('recognizes model and tool policy boundaries', () => {
  const findings = inventorySource(`
    const logger = getLogger('fixture');
    if (!logger.dontLogModelData) {
      logger.debug('Response:', response);
    }
    if (logger.dontLogToolData) {
      logger.warn('Tool failed');
    } else {
      logger.warn('Tool failed', error);
    }
    logModelActionError(logger, 'Model failed', error, event);
    logModelAndToolActionWarning(logger, 'Run failed', error, item);
    logToolActionError(logger, 'Tool failed', error, toolCall);
  `);

  assert.deepEqual(
    findings.map(({ method, policy }) => ({ method, policy })),
    [
      { method: 'debug', policy: 'model-guard' },
      { method: 'warn', policy: 'tool-guard' },
      { method: 'warn', policy: 'tool-guard' },
      { method: 'logModelActionError', policy: 'model-helper' },
      {
        method: 'logModelAndToolActionWarning',
        policy: 'model+tool-helper',
      },
      { method: 'logToolActionError', policy: 'tool-helper' },
    ],
  );
});

test('reads policy conditions from conditional expressions', () => {
  const findings = inventorySource(`
    const logger = getLogger('fixture');
    logger.dontLogToolData
      ? logger.warn('Tool logging disabled')
      : logger.warn('Tool failed', error);
  `);

  assert.deepEqual(
    findings.map(({ method, policy }) => ({ method, policy })),
    [
      { method: 'warn', policy: 'tool-guard' },
      { method: 'warn', policy: 'tool-guard' },
    ],
  );
});

test('flags caught values passed to logger and console calls', () => {
  const findings = inventorySource(`
    const appLogger: Logger = getLogger('app');
    try {
      await run();
    } catch (reason) {
      appLogger.error('Run failed', reason);
      console.warn(\`Run failed: \${reason}\`);
    }
  `);

  assert.deepEqual(
    findings.map(({ kind, catchValue, policy }) => ({
      kind,
      catchValue,
      policy,
    })),
    [
      { kind: 'logger', catchValue: 'reason', policy: 'none' },
      { kind: 'console', catchValue: 'reason', policy: 'none' },
    ],
  );
});

test('flags promise rejection handler values as caught values', () => {
  const findings = inventorySource(`
    const logger = getLogger('fixture');
    run().catch((reason) => logger.warn('Run failed', reason));
    run().then(undefined, (error) => console.error('Run failed', error));
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled rejection', reason, promise);
    });
  `);

  assert.deepEqual(
    findings.map(({ catchValue }) => catchValue),
    ['reason', 'error', 'reason'],
  );
});

test('flags destructured rejection values as caught values', () => {
  const findings = inventorySource(`
    const logger = getLogger('fixture');
    try {
      await run();
    } catch ({ message, cause: nestedCause }) {
      logger.error('Run failed', message, nestedCause);
    }
    run().catch(({ reason }) => logger.warn('Run failed', reason));
  `);

  assert.deepEqual(
    findings.map(({ catchValue }) => catchValue),
    ['message, nestedCause', 'reason'],
  );
});

test('resolves logger factories, imports, aliases, properties, and types', () => {
  const findings = inventorySource(`
    import defaultSink from './logger';
    import * as core from '@openai/agents-core';
    import { getLogger as createSink, logger as sharedSink } from './logger';
    import type { Logger as Sink } from './logger';

    const audit = createSink('audit');
    const alias = audit;
    const namespaced = core.getLogger('namespaced');
    defaultSink.error('Default failed', response);
    sharedSink.warn('Shared failed', response);
    audit.error('Audit failed', response);
    alias.info('Alias failed', response);
    namespaced.error('Namespaced failed', response);

    class Service {
      private readonly sink = createSink('service');
      report(problem, injected: Sink) {
        this.sink.error('Service failed', problem);
        injected.error('Injected failed', problem);
      }
    }

    class InheritedService {
      report(problem) {
        this.logger.error('Inherited logger failed', problem);
      }
    }
  `);

  assert.deepEqual(
    findings.map(({ method }) => method),
    ['error', 'warn', 'error', 'info', 'error', 'error', 'error', 'error'],
  );
});

test('resolves logger instances stored in object literals', () => {
  const findings = inventorySource(`
    const audit = getLogger('audit');
    const sinks = {
      audit: getLogger('nested-audit'),
      auditAlias: audit,
      audit,
    };
    sinks.audit.error('Nested audit failed', response);
    sinks['audit'].warn('Bracket audit failed', response);
    sinks.auditAlias.warn('Audit alias failed', response);
    sinks.audit.info('Shorthand audit failed', response);
  `);

  assert.deepEqual(
    findings.map(({ method }) => method),
    ['error', 'warn', 'warn', 'info'],
  );
});

test('resolves extracted Logger method aliases', () => {
  const findings = inventorySource(`
    const logger = getLogger('fixture');
    const { error: report, warn } = logger;
    const debug = logger['debug'];
    const reportAlias = report;

    report('Report failed', secret);
    warn('Warning', secret);
    debug('Debug value', secret);
    reportAlias('Alias failed', secret);
  `);

  assert.deepEqual(
    findings.map(({ kind, method }) => ({ kind, method })),
    [
      { kind: 'logger', method: 'error' },
      { kind: 'logger', method: 'warn' },
      { kind: 'logger', method: 'debug' },
      { kind: 'logger', method: 'error' },
    ],
  );
});

test('resolves Logger-typed object members', () => {
  const findings = inventorySource(`
    type ReportOptions = { logger?: Logger };
    interface AuditOptions {
      sink: Readonly<Logger>;
    }

    function report(options: { logger: Logger }) {
      options.logger.error('Inline options failed', secret);
    }
    function reportAlias(options: ReportOptions) {
      options.logger?.warn('Alias options failed', secret);
    }
    function reportInterface(options: AuditOptions) {
      options.sink.info('Interface options failed', secret);
    }
    function reportDestructured({ logger }: { logger: Logger }) {
      logger.error('Destructured options failed', secret);
    }
    function reportAliased({ logger: sink }: ReportOptions) {
      sink.warn('Aliased destructuring failed', secret);
    }
  `);

  assert.deepEqual(
    findings.map(({ method }) => method),
    ['error', 'warn', 'info', 'error', 'warn'],
  );
});

test('resolves Logger subtypes declared with heritage clauses', () => {
  const findings = inventorySource(`
    interface AuditLogger extends Logger {}
    interface NestedAuditLogger extends AuditLogger {}
    class ServiceLogger implements Logger {}
    class NestedServiceLogger extends ServiceLogger {}

    function report(
      audit: NestedAuditLogger,
      service: NestedServiceLogger,
    ) {
      audit.error('Audit failed', secret);
      service.warn('Service failed', secret);
    }
  `);

  assert.deepEqual(
    findings.map(({ method }) => method),
    ['error', 'warn'],
  );
});

test('inventories every direct console method', () => {
  const findings = inventorySource(`
    console.dir(secret);
    console.table(payload);
    console.trace(error);
  `);

  assert.deepEqual(
    findings.map(({ kind, method, policy }) => ({ kind, method, policy })),
    [
      { kind: 'console', method: 'dir', policy: 'none' },
      { kind: 'console', method: 'table', policy: 'none' },
      { kind: 'console', method: 'trace', policy: 'none' },
    ],
  );
});

test('resolves console object and extracted method aliases', () => {
  const findings = inventorySource(`
    const sink = console;
    const nestedSink = sink;
    const { warn, log: emit } = nestedSink;
    const trace = console.trace;

    sink.error('Request failed', secret);
    warn(secret);
    emit(payload);
    trace(error);
  `);

  assert.deepEqual(
    findings.map(({ kind, method }) => ({ kind, method })),
    [
      { kind: 'console', method: 'error' },
      { kind: 'console', method: 'warn' },
      { kind: 'console', method: 'log' },
      { kind: 'console', method: 'trace' },
    ],
  );
});

test('method alias analysis converges across reassignments', () => {
  const findings = inventorySource(`
    let emit = console.log;
    emit = console.error;

    const logger = getLogger('fixture');
    let report = logger.warn;
    report = logger.error;

    emit(secret);
    report('Failed', secret);
  `);

  assert.deepEqual(
    findings.map(({ kind, method }) => ({ kind, method })),
    [
      { kind: 'console', method: 'error|log' },
      { kind: 'logger', method: 'error|warn' },
    ],
  );
});

test('resolves sensitive helper import aliases and namespace accesses', () => {
  const findings = inventorySource(`
    import { logToolActionError as reportFailure } from './logger';
    import * as logging from '@openai/agents-core/utils/internal';

    reportFailure(logger, 'Tool failed', error, payload);
    logging.logModelActionError(logger, 'Model failed', error, response);
  `);

  assert.deepEqual(
    findings.map(({ method, policy }) => ({ method, policy })),
    [
      { method: 'logToolActionError', policy: 'tool-helper' },
      { method: 'logModelActionError', policy: 'model-helper' },
    ],
  );
});

test('fingerprints distinguish call sites and survive unrelated line shifts', () => {
  const source = `
    const logger = getLogger('fixture');
    function logModel(error) {
      logger.error('Operation failed', error);
    }
    function logTool(error) {
      logger.error('Operation failed', error);
    }
  `;
  const shiftedSource = `
    const unrelated = true;
    ${source}
  `;
  const findings = inventorySource(source);
  const shiftedFindings = inventorySource(shiftedSource);

  assert.equal(new Set(findings.map(({ fingerprint }) => fingerprint)).size, 2);
  assert.deepEqual(
    shiftedFindings.map(({ fingerprint }) => fingerprint),
    findings.map(({ fingerprint }) => fingerprint),
  );
});

test('fingerprints identify switch branches without order-dependent reuse', () => {
  const source = `
    const logger = getLogger('fixture');
    switch (kind) {
      case 'model':
        logger.error('Operation failed', error);
        break;
      case 'tool':
        logger.error('Operation failed', error);
        break;
      default:
        logger.error('Operation failed', error);
    }
  `;
  const sourceWithEarlierCase = source.replace(
    "case 'model':",
    `case 'new':
        logger.error('Operation failed', error);
        break;
      case 'model':`,
  );
  const findings = inventorySource(source);
  const shiftedFindings = inventorySource(sourceWithEarlierCase);

  assert.equal(new Set(findings.map(({ fingerprint }) => fingerprint)).size, 3);
  assert.deepEqual(
    shiftedFindings.slice(1).map(({ fingerprint }) => fingerprint),
    findings.map(({ fingerprint }) => fingerprint),
  );
  assert.match(findings[0].context, /switch:kind>case:'model'/);
  assert.match(findings[1].context, /switch:kind>case:'tool'/);
  assert.match(findings[2].context, /switch:kind>case:default/);
});

test('normalizes path separators before recording and hashing', () => {
  const source = `
    const logger = getLogger('fixture');
    logger.error('Operation failed', error);
  `;
  const windowsFinding = inventorySource(
    source,
    'packages\\agents-core\\src\\fixture.ts',
  )[0];
  const posixFinding = inventorySource(
    source,
    'packages/agents-core/src/fixture.ts',
  )[0];

  assert.equal(windowsFinding.file, 'packages/agents-core/src/fixture.ts');
  assert.equal(windowsFinding.fingerprint, posixFinding.fingerprint);
});

test('ignores unrelated methods that happen to share logger method names', () => {
  const findings = inventorySource(`
    controller.error(problem);
    loggerLikeButNotExact.info(details);
  `);

  assert.equal(findings.length, 0);
});
