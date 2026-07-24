#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const LOGGER_METHODS = new Set(['debug', 'error', 'info', 'log', 'warn']);
const SENSITIVE_HELPERS = new Map([
  ['logModelActionError', 'model-helper'],
  ['logModelActionWarning', 'model-helper'],
  ['logModelAndToolActionDebug', 'model+tool-helper'],
  ['logModelAndToolActionError', 'model+tool-helper'],
  ['logModelAndToolActionWarning', 'model+tool-helper'],
  ['logToolActionError', 'tool-helper'],
  ['logToolActionDebug', 'tool-helper'],
  ['logToolActionWarning', 'tool-helper'],
]);
const SOURCE_EXTENSIONS = new Set(['.cts', '.mts', '.ts', '.tsx']);

function parseArguments(argv) {
  const options = {
    format: 'markdown',
    roots: [],
    summaryOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--format') {
      const format = argv[index + 1];
      if (format !== 'json' && format !== 'markdown') {
        throw new Error('--format must be either json or markdown.');
      }
      options.format = format;
      index += 1;
    } else if (argument === '--summary-only') {
      options.summaryOnly = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      options.roots.push(argument);
    }
  }

  return options;
}

function extension(path) {
  const match = path.match(/(\.[^.]+)$/);
  return match?.[1] ?? '';
}

function collectSourceFiles(path) {
  const absolutePath = resolve(path);
  const stats = statSync(absolutePath);
  if (stats.isFile()) {
    return SOURCE_EXTENSIONS.has(extension(absolutePath)) ? [absolutePath] : [];
  }

  return readdirSync(absolutePath, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && entry.name !== 'dist')
    .flatMap((entry) => collectSourceFiles(resolve(absolutePath, entry.name)));
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyAccessParts(expression) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return {
      receiver: unwrapped.expression,
      method: unwrapped.name.text,
    };
  }
  if (
    ts.isElementAccessExpression(unwrapped) &&
    unwrapped.argumentExpression &&
    (ts.isStringLiteral(unwrapped.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(unwrapped.argumentExpression))
  ) {
    return {
      receiver: unwrapped.expression,
      method: unwrapped.argumentExpression.text,
    };
  }
  return null;
}

function isLoggerReceiver(expression, sourceFile) {
  const text = expression.getText(sourceFile);
  return /logger$/i.test(text);
}

function isConsoleReceiver(expression) {
  const unwrapped = unwrapExpression(expression);
  return ts.isIdentifier(unwrapped) && unwrapped.text === 'console';
}

function isStaticString(expression) {
  const unwrapped = unwrapExpression(expression);
  return (
    ts.isStringLiteral(unwrapped) ||
    ts.isNoSubstitutionTemplateLiteral(unwrapped)
  );
}

function hasDynamicMessage(call) {
  return call.arguments.length > 0 && !isStaticString(call.arguments[0]);
}

function referencesIdentifier(node, identifier) {
  let found = false;
  function visit(current) {
    if (found) {
      return;
    }
    if (ts.isIdentifier(current) && current.text === identifier) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function enclosingRejectedValueIdentifier(node) {
  let current = node.parent;
  while (current) {
    if (ts.isCatchClause(current)) {
      const declaration = current.variableDeclaration;
      return declaration && ts.isIdentifier(declaration.name)
        ? declaration.name.text
        : null;
    }
    if (ts.isFunctionLike(current)) {
      const callback = current;
      const call = callback.parent;
      if (ts.isCallExpression(call)) {
        const callbackIndex = call.arguments.indexOf(callback);
        const access = propertyAccessParts(call.expression);
        const isRejectionHandler =
          (access?.method === 'catch' && callbackIndex === 0) ||
          (access?.method === 'then' && callbackIndex === 1);
        if (isRejectionHandler) {
          const parameter = callback.parameters[0];
          return parameter && ts.isIdentifier(parameter.name)
            ? parameter.name.text
            : null;
        }
      }
    }
    current = current.parent;
  }
  return null;
}

function normalizeNodeText(node, sourceFile) {
  return node.getText(sourceFile).replace(/\s+/g, ' ').trim();
}

function declarationName(node, sourceFile) {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isPropertyDeclaration(node)) &&
    node.name
  ) {
    return normalizeNodeText(node.name, sourceFile);
  }
  if (ts.isConstructorDeclaration(node)) {
    return 'constructor';
  }
  if (ts.isVariableDeclaration(node)) {
    return normalizeNodeText(node.name, sourceFile);
  }
  if (ts.isPropertyAssignment(node)) {
    return normalizeNodeText(node.name, sourceFile);
  }
  return null;
}

function callSiteContext(node, sourceFile) {
  const parts = [];
  let child = node;
  let current = node.parent;
  while (current && !ts.isSourceFile(current)) {
    const name = declarationName(current, sourceFile);
    if (name) {
      parts.push(`${ts.SyntaxKind[current.kind]}:${name}`);
    }
    if (ts.isIfStatement(current)) {
      const branch = current.thenStatement === child ? 'then' : 'else';
      parts.push(
        `if:${normalizeNodeText(current.expression, sourceFile)}:${branch}`,
      );
    }
    if (ts.isCallExpression(current) && current.arguments.includes(child)) {
      const callbackIndex = current.arguments.indexOf(child);
      parts.push(
        `callback:${normalizeNodeText(current.expression, sourceFile)}:${callbackIndex}`,
      );
    }
    child = current;
    current = current.parent;
  }
  return parts.reverse().join('>') || '<module>';
}

function guardedPolicy(node, sourceFile) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) {
      break;
    }
    if (ts.isIfStatement(current) || ts.isConditionalExpression(current)) {
      const condition = current.expression.getText(sourceFile);
      const hasModelPolicy = condition.includes('dontLogModelData');
      const hasToolPolicy = condition.includes('dontLogToolData');
      if (hasModelPolicy && hasToolPolicy) {
        return 'model+tool-guard';
      }
      if (hasModelPolicy) {
        return 'model-guard';
      }
      if (hasToolPolicy) {
        return 'tool-guard';
      }
    }
    current = current.parent;
  }
  return 'none';
}

function normalizeCallText(call, sourceFile) {
  return call.getText(sourceFile).replace(/\s+/g, ' ').trim();
}

function fingerprint(path, context, normalizedCall, occurrence) {
  return createHash('sha256')
    .update(`${path}\0${context}\0${normalizedCall}\0${occurrence}`)
    .digest('hex')
    .slice(0, 12);
}

function signalsFor(text) {
  const normalized = text.toLowerCase();
  const signals = [];
  const groups = [
    ['model', /\b(model|response|request|completion|llm|realtime event)\b/],
    [
      'tool',
      /\b(tool|function call|arguments|computer action|shell action|apply_patch|mcp)\b/,
    ],
    ['error', /\b(error|err|exception|failure|failed|reason)\b/],
    ['payload', /\b(input|output|item|event|payload|data|trace|span)\b/],
  ];
  for (const [name, pattern] of groups) {
    if (pattern.test(normalized)) {
      signals.push(name);
    }
  }
  return signals;
}

export function inventorySource(sourceText, filePath = 'fixture.ts') {
  const scriptKind = filePath.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const findings = [];
  const occurrences = new Map();

  function recordCall(call, kind, method, policy) {
    const start = sourceFile.getLineAndCharacterOfPosition(call.getStart());
    const normalizedCall = normalizeCallText(call, sourceFile);
    const context = callSiteContext(call, sourceFile);
    const occurrenceKey = `${context}\0${normalizedCall}`;
    const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    const catchVariable = enclosingRejectedValueIdentifier(call);
    const referencesCatchValue = Boolean(
      catchVariable &&
      call.arguments.some((argument) =>
        referencesIdentifier(argument, catchVariable),
      ),
    );
    const dynamicMessage = hasDynamicMessage(call);
    const hasPayload = call.arguments.length > 1;
    findings.push({
      fingerprint: fingerprint(filePath, context, normalizedCall, occurrence),
      file: filePath,
      line: start.line + 1,
      column: start.character + 1,
      kind,
      method,
      shape: hasPayload
        ? 'payload'
        : dynamicMessage
          ? 'dynamic-message'
          : 'static-message',
      policy,
      catchValue: referencesCatchValue ? catchVariable : null,
      context,
      signals: signalsFor(normalizedCall),
      call: normalizedCall,
    });
  }

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const unwrappedExpression = unwrapExpression(node.expression);
      if (
        ts.isIdentifier(unwrappedExpression) &&
        SENSITIVE_HELPERS.has(unwrappedExpression.text)
      ) {
        recordCall(
          node,
          'sensitive-helper',
          unwrappedExpression.text,
          SENSITIVE_HELPERS.get(unwrappedExpression.text),
        );
      } else {
        const access = propertyAccessParts(node.expression);
        if (access && LOGGER_METHODS.has(access.method)) {
          if (isConsoleReceiver(access.receiver)) {
            recordCall(node, 'console', access.method, 'none');
          } else if (isLoggerReceiver(access.receiver, sourceFile)) {
            recordCall(
              node,
              'logger',
              access.method,
              guardedPolicy(node, sourceFile),
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

function summarize(findings) {
  const dynamic = findings.filter(
    (finding) => finding.shape !== 'static-message',
  );
  return {
    total: findings.length,
    dynamic: dynamic.length,
    unclassifiedDynamic: dynamic.filter((finding) => finding.policy === 'none')
      .length,
    catchValueLogs: findings.filter((finding) => finding.catchValue).length,
    unclassifiedCatchValueLogs: findings.filter(
      (finding) => finding.catchValue && finding.policy === 'none',
    ).length,
    rawConsoleCalls: findings.filter((finding) => finding.kind === 'console')
      .length,
  };
}

function markdown(findings, summary, summaryOnly) {
  const lines = [
    '# Sensitive logging inventory',
    '',
    `- Total logging calls: ${summary.total}`,
    `- Dynamic calls: ${summary.dynamic}`,
    `- Dynamic calls without an explicit model/tool policy: ${summary.unclassifiedDynamic}`,
    `- Calls that log a caught value: ${summary.catchValueLogs}`,
    `- Caught-value calls without an explicit model/tool policy: ${summary.unclassifiedCatchValueLogs}`,
    `- Raw console calls: ${summary.rawConsoleCalls}`,
  ];

  if (summaryOnly) {
    return `${lines.join('\n')}\n`;
  }

  lines.push(
    '',
    '| Location | Kind | Shape | Policy | Catch value | Signals | Fingerprint |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const finding of findings) {
    lines.push(
      `| ${finding.file}:${finding.line} | ${finding.kind}.${finding.method} | ${finding.shape} | ${finding.policy} | ${finding.catchValue ?? ''} | ${finding.signals.join(', ')} | ${finding.fingerprint} |`,
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function usage() {
  return `Usage: node .agents/skills/sensitive-logging-audit/scripts/inventory-logging.mjs [options] [roots...]

Inventory runtime logger and console calls so every dynamic payload can be
classified as model data, tool data, both, or operationally safe.

Options:
  --format <markdown|json>  Output format (default: markdown)
  --summary-only            Print counts without the per-call ledger
  -h, --help                Show this help

Default roots: packages/*/src
`;
}

export function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const cwd = process.cwd();
  const roots =
    options.roots.length > 0
      ? options.roots
      : readdirSync(resolve(cwd, 'packages'), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => resolve(cwd, 'packages', entry.name, 'src'))
          .filter((path) => {
            try {
              return statSync(path).isDirectory();
            } catch {
              return false;
            }
          });

  const findings = roots
    .flatMap(collectSourceFiles)
    .sort()
    .flatMap((absolutePath) => {
      const filePath = relative(cwd, absolutePath);
      return inventorySource(readFileSync(absolutePath, 'utf8'), filePath);
    });
  const summary = summarize(findings);

  if (options.format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        options.summaryOnly ? { summary } : { summary, findings },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(markdown(findings, summary, options.summaryOnly));
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  try {
    run();
  } catch (error) {
    process.stderr.write(
      `Sensitive logging audit failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
