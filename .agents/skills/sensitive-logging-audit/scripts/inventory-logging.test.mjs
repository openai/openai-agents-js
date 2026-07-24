import assert from 'node:assert/strict';
import test from 'node:test';

import { inventorySource } from './inventory-logging.mjs';

test('inventories static and dynamic logger calls', () => {
  const findings = inventorySource(`
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

test('flags caught values passed to logger and console calls', () => {
  const findings = inventorySource(`
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
    run().catch((reason) => logger.warn('Run failed', reason));
    run().then(undefined, (error) => console.error('Run failed', error));
  `);

  assert.deepEqual(
    findings.map(({ catchValue }) => catchValue),
    ['reason', 'error'],
  );
});

test('fingerprints distinguish call sites and survive unrelated line shifts', () => {
  const source = `
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

test('ignores unrelated methods that happen to share logger method names', () => {
  const findings = inventorySource(`
    controller.error(problem);
    loggerLikeButNotExact.info(details);
  `);

  assert.equal(findings.length, 0);
});
