#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const LOGGER_METHODS = new Set(['debug', 'error', 'info', 'log', 'warn']);
const COMPUTED_METHOD = 'computed';
const LOGGER_TYPE_PROPERTIES = [
  'debug',
  'dontLogModelData',
  'dontLogToolData',
  'error',
  'namespace',
  'warn',
];
const STANDARD_GLOBALS = new Set(['global', 'globalThis', 'window']);
const SENSITIVE_HELPERS = new Map([
  ['logModelActionError', 'model-helper'],
  ['logToolActionError', 'tool-helper'],
]);
const SENSITIVE_HELPER_MODULES = new Set([
  '@openai/agents-core/utils/internal',
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
      computed: false,
      receiver: unwrapped.expression,
      method: unwrapped.name.text,
    };
  }
  if (ts.isElementAccessExpression(unwrapped) && unwrapped.argumentExpression) {
    const isStatic =
      ts.isStringLiteral(unwrapped.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(unwrapped.argumentExpression);
    return {
      computed: !isStatic,
      receiver: unwrapped.expression,
      method: isStatic ? unwrapped.argumentExpression.text : COMPUTED_METHOD,
    };
  }
  return null;
}

function isGloballyQualifiedConsole(expression) {
  const access = propertyAccessParts(expression);
  if (!access || access.method !== 'console') {
    return false;
  }
  const receiver = unwrapExpression(access.receiver);
  return ts.isIdentifier(receiver) && STANDARD_GLOBALS.has(receiver.text);
}

function checkerRecognizesLogger(expression, checker) {
  if (!checker) {
    return false;
  }
  try {
    const type = checker.getApparentType(
      checker.getNonNullableType(checker.getTypeAtLocation(expression)),
    );
    return LOGGER_TYPE_PROPERTIES.every((property) =>
      checker.getPropertyOfType(type, property),
    );
  } catch {
    return false;
  }
}

function normalizeFilePath(path) {
  return path.replace(/\\/g, '/');
}

function importName(specifier) {
  return specifier.propertyName?.text ?? specifier.name.text;
}

function isLoggerModule(moduleName) {
  return /(?:^|\/)logger(?:\.[cm]?[jt]s)?$/.test(moduleName);
}

function isSensitiveHelperModule(moduleName) {
  return isLoggerModule(moduleName) || SENSITIVE_HELPER_MODULES.has(moduleName);
}

function propertyNameText(name, sourceFile) {
  if (!name) {
    return null;
  }
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return normalizeNodeText(name, sourceFile);
}

function typeIsLoggerValue(typeNode, loggerTypeBindings) {
  if (!typeNode) {
    return false;
  }
  if (ts.isParenthesizedTypeNode(typeNode) || ts.isTypeOperatorNode(typeNode)) {
    return typeIsLoggerValue(typeNode.type, loggerTypeBindings);
  }
  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.some((type) =>
      typeIsLoggerValue(type, loggerTypeBindings),
    );
  }
  if (!ts.isTypeReferenceNode(typeNode)) {
    return false;
  }
  if (
    (ts.isIdentifier(typeNode.typeName) &&
      loggerTypeBindings.has(typeNode.typeName.text)) ||
    (ts.isQualifiedName(typeNode.typeName) &&
      typeNode.typeName.right.text === 'Logger')
  ) {
    return true;
  }
  return (
    ts.isIdentifier(typeNode.typeName) &&
    ['Partial', 'Readonly', 'Required'].includes(typeNode.typeName.text) &&
    typeNode.typeArguments?.some((type) =>
      typeIsLoggerValue(type, loggerTypeBindings),
    ) === true
  );
}

function heritageReferencesLogger(node, loggerTypeBindings) {
  return Boolean(
    node.heritageClauses?.some((clause) =>
      clause.types.some((heritageType) => {
        const expression = unwrapExpression(heritageType.expression);
        if (
          (ts.isIdentifier(expression) &&
            loggerTypeBindings.has(expression.text)) ||
          (ts.isPropertyAccessExpression(expression) &&
            expression.name.text === 'Logger')
        ) {
          return true;
        }
        return (
          heritageType.typeArguments?.some((type) =>
            typeIsLoggerValue(type, loggerTypeBindings),
          ) === true
        );
      }),
    ),
  );
}

function collectLoggingSymbols(sourceFile, checker) {
  const consoleBindings = new Set(['console']);
  const consoleMethodBindings = new Map();
  const consolePropertyNames = new Set();
  const loggerBindings = new Set();
  const loggerFactoryBindings = new Set(['getLogger']);
  const loggerMethodBindings = new Map();
  const loggerNamespaceBindings = new Set();
  const loggerObjectTypeProperties = new Map();
  const loggerPropertyNames = new Set();
  const loggerTypeBindings = new Set(['Logger']);
  const sensitiveHelperBindings = new Map();
  const sensitiveHelperNamespaceBindings = new Set();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const moduleName = ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : '';
    const trustedSensitiveHelperModule = isSensitiveHelperModule(moduleName);
    const clause = statement.importClause;
    if (!clause) {
      continue;
    }
    if (clause.name && isLoggerModule(moduleName)) {
      loggerBindings.add(clause.name.text);
    }
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      loggerNamespaceBindings.add(bindings.name.text);
      if (trustedSensitiveHelperModule) {
        sensitiveHelperNamespaceBindings.add(bindings.name.text);
      }
      continue;
    }
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const specifier of bindings.elements) {
      const imported = importName(specifier);
      const local = specifier.name.text;
      if (imported === 'getLogger') {
        loggerFactoryBindings.add(local);
      } else if (imported === 'logger') {
        loggerBindings.add(local);
      } else if (imported === 'Logger') {
        loggerTypeBindings.add(local);
      }
      const sensitivePolicy = SENSITIVE_HELPERS.get(imported);
      if (sensitivePolicy && trustedSensitiveHelperModule) {
        sensitiveHelperBindings.set(local, {
          method: imported,
          policy: sensitivePolicy,
        });
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    function add(set, value) {
      if (value && !set.has(value)) {
        set.add(value);
        changed = true;
      }
    }
    function addMappings(map, key, values) {
      if (!key) {
        return;
      }
      for (const value of values) {
        if (!value) {
          continue;
        }
        let mapped = map.get(key);
        if (!mapped) {
          mapped = new Set();
          map.set(key, mapped);
        }
        if (!mapped.has(value)) {
          mapped.add(value);
          changed = true;
        }
      }
    }
    function loggerPropertiesForType(typeNode) {
      if (!typeNode) {
        return new Set();
      }
      if (
        ts.isParenthesizedTypeNode(typeNode) ||
        ts.isTypeOperatorNode(typeNode)
      ) {
        return loggerPropertiesForType(typeNode.type);
      }
      if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
        return new Set(
          typeNode.types.flatMap((type) => [...loggerPropertiesForType(type)]),
        );
      }
      if (ts.isTypeLiteralNode(typeNode)) {
        return new Set(
          typeNode.members.flatMap((member) =>
            ts.isPropertySignature(member) &&
            typeIsLoggerValue(member.type, loggerTypeBindings)
              ? [propertyNameText(member.name, sourceFile)]
              : [],
          ),
        );
      }
      if (!ts.isTypeReferenceNode(typeNode)) {
        return new Set();
      }
      const properties = new Set();
      if (ts.isIdentifier(typeNode.typeName)) {
        for (const property of loggerObjectTypeProperties.get(
          typeNode.typeName.text,
        ) ?? []) {
          properties.add(property);
        }
      }
      for (const typeArgument of typeNode.typeArguments ?? []) {
        for (const property of loggerPropertiesForType(typeArgument)) {
          properties.add(property);
        }
      }
      return properties;
    }
    function isKnownConsoleExpression(expression) {
      const current = unwrapExpression(expression);
      if (ts.isIdentifier(current)) {
        return consoleBindings.has(current.text);
      }
      if (isGloballyQualifiedConsole(current)) {
        return true;
      }
      const access = propertyAccessParts(current);
      if (access && consolePropertyNames.has(access.method)) {
        return true;
      }
      if (ts.isConditionalExpression(current)) {
        return (
          isKnownConsoleExpression(current.whenTrue) ||
          isKnownConsoleExpression(current.whenFalse)
        );
      }
      if (
        ts.isBinaryExpression(current) &&
        current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return (
          isKnownConsoleExpression(current.left) ||
          isKnownConsoleExpression(current.right)
        );
      }
      return false;
    }
    function resolveConsoleMethods(expression) {
      const current = unwrapExpression(expression);
      if (ts.isIdentifier(current)) {
        return consoleMethodBindings.get(current.text) ?? [];
      }
      const access = propertyAccessParts(current);
      return access && isKnownConsoleExpression(access.receiver)
        ? [access.method]
        : [];
    }
    function recordConsoleDeclaration(declaration) {
      if (!declaration.initializer) {
        return;
      }
      if (ts.isIdentifier(declaration.name)) {
        if (isKnownConsoleExpression(declaration.initializer)) {
          add(consoleBindings, declaration.name.text);
        }
        addMappings(
          consoleMethodBindings,
          declaration.name.text,
          resolveConsoleMethods(declaration.initializer),
        );
        return;
      }
      if (
        !ts.isObjectBindingPattern(declaration.name) ||
        !isKnownConsoleExpression(declaration.initializer)
      ) {
        return;
      }
      for (const element of declaration.name.elements) {
        if (element.dotDotDotToken || !ts.isIdentifier(element.name)) {
          continue;
        }
        addMappings(consoleMethodBindings, element.name.text, [
          propertyNameText(element.propertyName ?? element.name, sourceFile),
        ]);
      }
    }
    function isLoggerFactoryCall(expression) {
      const current = unwrapExpression(expression);
      if (!ts.isCallExpression(current)) {
        return false;
      }
      const callee = unwrapExpression(current.expression);
      if (ts.isIdentifier(callee) && loggerFactoryBindings.has(callee.text)) {
        return true;
      }
      const access = propertyAccessParts(callee);
      return Boolean(
        access &&
        access.method === 'getLogger' &&
        ts.isIdentifier(unwrapExpression(access.receiver)) &&
        loggerNamespaceBindings.has(unwrapExpression(access.receiver).text),
      );
    }
    function isKnownLoggerExpression(expression) {
      const current = unwrapExpression(expression);
      if (checkerRecognizesLogger(current, checker)) {
        return true;
      }
      if (ts.isIdentifier(current)) {
        return loggerBindings.has(current.text);
      }
      if (isLoggerFactoryCall(current)) {
        return true;
      }
      const access = propertyAccessParts(current);
      if (access) {
        const receiver = unwrapExpression(access.receiver);
        return (
          loggerPropertyNames.has(access.method) ||
          (ts.isIdentifier(receiver) &&
            loggerNamespaceBindings.has(receiver.text) &&
            access.method === 'logger')
        );
      }
      if (ts.isConditionalExpression(current)) {
        return (
          isKnownLoggerExpression(current.whenTrue) ||
          isKnownLoggerExpression(current.whenFalse)
        );
      }
      if (
        ts.isBinaryExpression(current) &&
        current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return (
          isKnownLoggerExpression(current.left) ||
          isKnownLoggerExpression(current.right)
        );
      }
      return false;
    }
    function resolveLoggerMethods(expression) {
      const current = unwrapExpression(expression);
      if (ts.isIdentifier(current)) {
        return loggerMethodBindings.get(current.text) ?? [];
      }
      const access = propertyAccessParts(current);
      return access &&
        (access.computed || LOGGER_METHODS.has(access.method)) &&
        isKnownLoggerExpression(access.receiver)
        ? [access.method]
        : [];
    }
    function recordLoggerMethodDeclaration(declaration) {
      if (!declaration.initializer) {
        return;
      }
      if (ts.isIdentifier(declaration.name)) {
        addMappings(
          loggerMethodBindings,
          declaration.name.text,
          resolveLoggerMethods(declaration.initializer),
        );
        return;
      }
      if (
        !ts.isObjectBindingPattern(declaration.name) ||
        !isKnownLoggerExpression(declaration.initializer)
      ) {
        return;
      }
      for (const element of declaration.name.elements) {
        if (element.dotDotDotToken || !ts.isIdentifier(element.name)) {
          continue;
        }
        const method = propertyNameText(
          element.propertyName ?? element.name,
          sourceFile,
        );
        if (LOGGER_METHODS.has(method)) {
          addMappings(loggerMethodBindings, element.name.text, [method]);
        }
      }
    }
    function recordDeclaration(declaration) {
      if (ts.isObjectBindingPattern(declaration.name)) {
        const loggerProperties = loggerPropertiesForType(declaration.type);
        for (const element of declaration.name.elements) {
          if (element.dotDotDotToken || !ts.isIdentifier(element.name)) {
            continue;
          }
          const propertyName = propertyNameText(
            element.propertyName ?? element.name,
            sourceFile,
          );
          if (loggerProperties.has(propertyName)) {
            add(loggerBindings, element.name.text);
          }
        }
      }
      if (typeIsLoggerValue(declaration.type, loggerTypeBindings)) {
        if (ts.isPropertyDeclaration(declaration)) {
          add(
            loggerPropertyNames,
            propertyNameText(declaration.name, sourceFile),
          );
        } else if (ts.isIdentifier(declaration.name)) {
          add(loggerBindings, declaration.name.text);
          if (ts.isParameter(declaration) && declaration.modifiers?.length) {
            add(
              loggerPropertyNames,
              propertyNameText(declaration.name, sourceFile),
            );
          }
        }
      }
      if (
        !declaration.initializer ||
        !isKnownLoggerExpression(declaration.initializer)
      ) {
        return;
      }
      if (ts.isPropertyDeclaration(declaration)) {
        add(
          loggerPropertyNames,
          propertyNameText(declaration.name, sourceFile),
        );
      } else if (ts.isIdentifier(declaration.name)) {
        add(loggerBindings, declaration.name.text);
      } else {
        add(
          loggerPropertyNames,
          propertyNameText(declaration.name, sourceFile),
        );
      }
    }
    function visit(current) {
      if (
        ts.isTypeAliasDeclaration(current) &&
        typeIsLoggerValue(current.type, loggerTypeBindings)
      ) {
        add(loggerTypeBindings, current.name.text);
      }
      if (ts.isTypeAliasDeclaration(current)) {
        addMappings(
          loggerObjectTypeProperties,
          current.name.text,
          loggerPropertiesForType(current.type),
        );
      }
      if (ts.isInterfaceDeclaration(current)) {
        const properties = current.members.flatMap((member) =>
          ts.isPropertySignature(member) &&
          typeIsLoggerValue(member.type, loggerTypeBindings)
            ? [propertyNameText(member.name, sourceFile)]
            : [],
        );
        for (const clause of current.heritageClauses ?? []) {
          for (const heritageType of clause.types) {
            const expression = unwrapExpression(heritageType.expression);
            if (ts.isIdentifier(expression)) {
              properties.push(
                ...(loggerObjectTypeProperties.get(expression.text) ?? []),
              );
            }
          }
        }
        addMappings(loggerObjectTypeProperties, current.name.text, properties);
      }
      if (
        (ts.isInterfaceDeclaration(current) ||
          ts.isClassDeclaration(current)) &&
        current.name &&
        heritageReferencesLogger(current, loggerTypeBindings)
      ) {
        add(loggerTypeBindings, current.name.text);
      }
      if (
        ts.isPropertySignature(current) &&
        typeIsLoggerValue(current.type, loggerTypeBindings)
      ) {
        add(loggerPropertyNames, propertyNameText(current.name, sourceFile));
      }
      if (
        ts.isVariableDeclaration(current) ||
        ts.isParameter(current) ||
        ts.isPropertyDeclaration(current)
      ) {
        recordDeclaration(current);
      }
      if (ts.isVariableDeclaration(current)) {
        recordConsoleDeclaration(current);
        recordLoggerMethodDeclaration(current);
      }
      if (
        ts.isPropertyAssignment(current) &&
        isKnownConsoleExpression(current.initializer)
      ) {
        add(consolePropertyNames, propertyNameText(current.name, sourceFile));
      }
      if (
        ts.isShorthandPropertyAssignment(current) &&
        consoleBindings.has(current.name.text)
      ) {
        add(consolePropertyNames, current.name.text);
      }
      if (
        ts.isPropertyAssignment(current) &&
        isKnownLoggerExpression(current.initializer)
      ) {
        add(loggerPropertyNames, propertyNameText(current.name, sourceFile));
      }
      if (
        ts.isShorthandPropertyAssignment(current) &&
        loggerBindings.has(current.name.text)
      ) {
        add(loggerPropertyNames, current.name.text);
      }
      if (
        ts.isBinaryExpression(current) &&
        current.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const target = unwrapExpression(current.left);
        if (isKnownLoggerExpression(current.right)) {
          if (ts.isIdentifier(target)) {
            add(loggerBindings, target.text);
          } else {
            const targetAccess = propertyAccessParts(target);
            if (targetAccess) {
              add(loggerPropertyNames, targetAccess.method);
            }
          }
        }
        if (ts.isIdentifier(target)) {
          if (isKnownConsoleExpression(current.right)) {
            add(consoleBindings, target.text);
          }
          addMappings(
            consoleMethodBindings,
            target.text,
            resolveConsoleMethods(current.right),
          );
          addMappings(
            loggerMethodBindings,
            target.text,
            resolveLoggerMethods(current.right),
          );
        } else if (isKnownConsoleExpression(current.right)) {
          const targetAccess = propertyAccessParts(target);
          if (targetAccess) {
            add(consolePropertyNames, targetAccess.method);
          }
        }
      }
      ts.forEachChild(current, visit);
    }
    visit(sourceFile);
  }

  function isLoggerReceiver(expression) {
    const current = unwrapExpression(expression);
    if (checkerRecognizesLogger(current, checker)) {
      return true;
    }
    if (ts.isIdentifier(current)) {
      return loggerBindings.has(current.text);
    }
    if (ts.isCallExpression(current)) {
      const callee = unwrapExpression(current.expression);
      if (ts.isIdentifier(callee) && loggerFactoryBindings.has(callee.text)) {
        return true;
      }
      const access = propertyAccessParts(callee);
      return Boolean(
        access &&
        access.method === 'getLogger' &&
        ts.isIdentifier(unwrapExpression(access.receiver)) &&
        loggerNamespaceBindings.has(unwrapExpression(access.receiver).text),
      );
    }
    const access = propertyAccessParts(current);
    if (access) {
      const receiver = unwrapExpression(access.receiver);
      return (
        loggerPropertyNames.has(access.method) ||
        (receiver.kind === ts.SyntaxKind.ThisKeyword &&
          access.method === 'logger') ||
        (ts.isIdentifier(receiver) &&
          loggerNamespaceBindings.has(receiver.text) &&
          access.method === 'logger')
      );
    }
    return false;
  }

  function resolveSensitiveHelper(expression) {
    const current = unwrapExpression(expression);
    if (ts.isIdentifier(current)) {
      return sensitiveHelperBindings.get(current.text) ?? null;
    }
    const access = propertyAccessParts(current);
    if (!access) {
      return null;
    }
    const receiver = unwrapExpression(access.receiver);
    if (
      !ts.isIdentifier(receiver) ||
      !sensitiveHelperNamespaceBindings.has(receiver.text)
    ) {
      return null;
    }
    const policy = SENSITIVE_HELPERS.get(access.method);
    return policy ? { method: access.method, policy } : null;
  }

  function resolveConsoleMethod(expression) {
    const current = unwrapExpression(expression);
    if (ts.isIdentifier(current)) {
      const methods = consoleMethodBindings.get(current.text);
      return methods ? [...methods].sort().join('|') : null;
    }
    const access = propertyAccessParts(current);
    if (!access) {
      return null;
    }
    const receiver = unwrapExpression(access.receiver);
    const receiverAccess = propertyAccessParts(receiver);
    return (ts.isIdentifier(receiver) && consoleBindings.has(receiver.text)) ||
      isGloballyQualifiedConsole(receiver) ||
      (receiverAccess && consolePropertyNames.has(receiverAccess.method))
      ? access.method
      : null;
  }

  function resolveLoggerMethod(expression) {
    const current = unwrapExpression(expression);
    if (ts.isIdentifier(current)) {
      const methods = loggerMethodBindings.get(current.text);
      return methods ? [...methods].sort().join('|') : null;
    }
    const access = propertyAccessParts(current);
    return access &&
      (access.computed || LOGGER_METHODS.has(access.method)) &&
      isLoggerReceiver(access.receiver)
      ? access.method
      : null;
  }

  return {
    isLoggerReceiver,
    resolveConsoleMethod,
    resolveLoggerMethod,
    resolveSensitiveHelper,
  };
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

function bindingIdentifiers(name) {
  const identifiers = [];

  function visit(current) {
    if (ts.isIdentifier(current)) {
      identifiers.push(current.text);
      return;
    }
    if (
      ts.isObjectBindingPattern(current) ||
      ts.isArrayBindingPattern(current)
    ) {
      for (const element of current.elements) {
        if (ts.isBindingElement(element)) {
          visit(element.name);
        }
      }
    }
  }

  visit(name);
  return identifiers;
}

function isRejectionCallbackArgument(call, callbackIndex) {
  const access = propertyAccessParts(call.expression);
  return (
    (access?.method === 'catch' && callbackIndex === 0) ||
    (access?.method === 'then' && callbackIndex === 1) ||
    ((access?.method === 'on' ||
      access?.method === 'once' ||
      access?.method === 'addListener') &&
      callbackIndex === 1 &&
      ts.isStringLiteral(call.arguments[0]) &&
      call.arguments[0].text === 'unhandledRejection')
  );
}

function enclosingRejectedValueIdentifiers(node) {
  const identifiers = new Set();
  let current = node.parent;
  while (current) {
    if (ts.isCatchClause(current)) {
      const declaration = current.variableDeclaration;
      if (declaration) {
        for (const identifier of bindingIdentifiers(declaration.name)) {
          identifiers.add(identifier);
        }
      }
    }
    if (ts.isFunctionLike(current)) {
      const callback = current;
      const call = callback.parent;
      if (ts.isCallExpression(call)) {
        const callbackIndex = call.arguments.indexOf(callback);
        if (isRejectionCallbackArgument(call, callbackIndex)) {
          const parameter = callback.parameters[0];
          if (parameter) {
            for (const identifier of bindingIdentifiers(parameter.name)) {
              identifiers.add(identifier);
            }
          }
        }
      }
    }
    current = current.parent;
  }
  return [...identifiers];
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
      const branch =
        current.expression === child
          ? 'condition'
          : current.thenStatement === child
            ? 'then'
            : 'else';
      parts.push(
        `if:${normalizeNodeText(current.expression, sourceFile)}:${branch}`,
      );
    }
    if (ts.isConditionalExpression(current)) {
      const branch =
        current.condition === child
          ? 'condition'
          : current.whenTrue === child
            ? 'true'
            : 'false';
      parts.push(
        `conditional:${normalizeNodeText(current.condition, sourceFile)}:${branch}`,
      );
    }
    if (ts.isCaseClause(current)) {
      parts.push(`case:${normalizeNodeText(current.expression, sourceFile)}`);
    } else if (ts.isDefaultClause(current)) {
      parts.push('case:default');
    }
    if (ts.isSwitchStatement(current)) {
      parts.push(`switch:${normalizeNodeText(current.expression, sourceFile)}`);
    }
    if (ts.isTryStatement(current)) {
      const branch =
        current.tryBlock === child
          ? 'try'
          : current.catchClause === child
            ? 'catch'
            : 'finally';
      parts.push(`try:${branch}`);
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

function possibleBooleanResults(expression, flagName, flagValue) {
  const current = unwrapExpression(expression);
  if (
    referencesIdentifier(current, flagName) &&
    ((ts.isIdentifier(current) && current.text === flagName) ||
      propertyAccessParts(current)?.method === flagName)
  ) {
    return new Set([flagValue]);
  }
  if (current.kind === ts.SyntaxKind.TrueKeyword) {
    return new Set([true]);
  }
  if (current.kind === ts.SyntaxKind.FalseKeyword) {
    return new Set([false]);
  }
  if (
    ts.isPrefixUnaryExpression(current) &&
    current.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return new Set(
      [...possibleBooleanResults(current.operand, flagName, flagValue)].map(
        (value) => !value,
      ),
    );
  }
  if (ts.isBinaryExpression(current)) {
    const operator = current.operatorToken.kind;
    const left = possibleBooleanResults(current.left, flagName, flagValue);
    const right = possibleBooleanResults(current.right, flagName, flagValue);
    if (
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.BarBarToken
    ) {
      const results = new Set();
      for (const leftValue of left) {
        for (const rightValue of right) {
          results.add(
            operator === ts.SyntaxKind.AmpersandAmpersandToken
              ? leftValue && rightValue
              : leftValue || rightValue,
          );
        }
      }
      return results;
    }
    if (
      operator === ts.SyntaxKind.EqualsEqualsToken ||
      operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      const negated =
        operator === ts.SyntaxKind.ExclamationEqualsToken ||
        operator === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      const results = new Set();
      for (const leftValue of left) {
        for (const rightValue of right) {
          results.add(
            negated ? leftValue !== rightValue : leftValue === rightValue,
          );
        }
      }
      return results;
    }
  }
  return new Set([false, true]);
}

function branchGuaranteesFlagDisabled(condition, branchValue, flagName) {
  return (
    referencesIdentifier(condition, flagName) &&
    !possibleBooleanResults(condition, flagName, true).has(branchValue)
  );
}

function guardedPolicy(node) {
  let child = node;
  let current = node.parent;
  let modelGuard = false;
  let toolGuard = false;
  while (current) {
    if (ts.isFunctionLike(current)) {
      break;
    }
    if (ts.isIfStatement(current) || ts.isConditionalExpression(current)) {
      const conditionNode = ts.isIfStatement(current)
        ? current.expression
        : current.condition;
      const trueBranch = ts.isIfStatement(current)
        ? current.thenStatement
        : current.whenTrue;
      const falseBranch = ts.isIfStatement(current)
        ? current.elseStatement
        : current.whenFalse;
      const branchValue =
        child === trueBranch ? true : child === falseBranch ? false : null;
      if (branchValue !== null) {
        modelGuard ||= branchGuaranteesFlagDisabled(
          conditionNode,
          branchValue,
          'dontLogModelData',
        );
        toolGuard ||= branchGuaranteesFlagDisabled(
          conditionNode,
          branchValue,
          'dontLogToolData',
        );
      }
    }
    child = current;
    current = current.parent;
  }
  if (modelGuard && toolGuard) {
    return 'model+tool-guard';
  }
  if (modelGuard) {
    return 'model-guard';
  }
  if (toolGuard) {
    return 'tool-guard';
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

function inventoryParsedSource(sourceFile, filePath, checker = null) {
  const findings = [];
  const occurrences = new Map();
  const {
    isLoggerReceiver,
    resolveConsoleMethod,
    resolveLoggerMethod,
    resolveSensitiveHelper,
  } = collectLoggingSymbols(sourceFile, checker);

  function recordFinding(
    node,
    normalizedCall,
    kind,
    method,
    shape,
    policy,
    catchValue,
  ) {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    const context = callSiteContext(node, sourceFile);
    const occurrenceKey = `${context}\0${normalizedCall}`;
    const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    findings.push({
      fingerprint: fingerprint(filePath, context, normalizedCall, occurrence),
      file: filePath,
      line: start.line + 1,
      column: start.character + 1,
      kind,
      method,
      shape,
      policy,
      catchValue,
      context,
      signals: signalsFor(normalizedCall),
      call: normalizedCall,
    });
  }

  function recordCall(call, kind, method, policy) {
    const normalizedCall = normalizeCallText(call, sourceFile);
    const catchValues = enclosingRejectedValueIdentifiers(call);
    const referencedCatchValues = catchValues.filter((catchValue) =>
      call.arguments.some((argument) =>
        referencesIdentifier(argument, catchValue),
      ),
    );
    const dynamicMessage = hasDynamicMessage(call);
    const hasPayload = call.arguments.length > 1;
    recordFinding(
      call,
      normalizedCall,
      kind,
      method,
      hasPayload
        ? 'payload'
        : dynamicMessage
          ? 'dynamic-message'
          : 'static-message',
      policy,
      referencedCatchValues.length > 0
        ? referencedCatchValues.join(', ')
        : null,
    );
  }

  function recordCallbackReference(
    reference,
    kind,
    method,
    policy,
    parentCall,
    callbackIndex,
  ) {
    recordFinding(
      reference,
      normalizeNodeText(reference, sourceFile),
      kind,
      method,
      'dynamic-message',
      policy,
      isRejectionCallbackArgument(parentCall, callbackIndex)
        ? 'rejection reason'
        : null,
    );
  }

  function recordCallbackReferences(call, parentIsSink) {
    if (parentIsSink) {
      return;
    }
    for (const [callbackIndex, argument] of call.arguments.entries()) {
      const consoleMethod = resolveConsoleMethod(argument);
      if (consoleMethod) {
        recordCallbackReference(
          argument,
          'console',
          consoleMethod,
          'none',
          call,
          callbackIndex,
        );
        continue;
      }
      const loggerMethod = resolveLoggerMethod(argument);
      if (loggerMethod) {
        recordCallbackReference(
          argument,
          'logger',
          loggerMethod,
          guardedPolicy(argument),
          call,
          callbackIndex,
        );
      }
    }
  }

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const consoleMethod = resolveConsoleMethod(node.expression);
      const loggerMethod = resolveLoggerMethod(node.expression);
      const sensitiveHelper = resolveSensitiveHelper(node.expression);
      const parentIsSink = Boolean(
        consoleMethod || loggerMethod || sensitiveHelper,
      );
      if (consoleMethod) {
        recordCall(node, 'console', consoleMethod, 'none');
      } else if (loggerMethod) {
        recordCall(node, 'logger', loggerMethod, guardedPolicy(node));
      } else if (sensitiveHelper) {
        recordCall(
          node,
          'sensitive-helper',
          sensitiveHelper.method,
          sensitiveHelper.policy,
        );
      } else {
        const access = propertyAccessParts(node.expression);
        if (access) {
          if (
            (access.computed || LOGGER_METHODS.has(access.method)) &&
            isLoggerReceiver(access.receiver)
          ) {
            recordCall(node, 'logger', access.method, guardedPolicy(node));
          }
        }
      }
      recordCallbackReferences(node, parentIsSink);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

export function inventorySource(sourceText, filePath = 'fixture.ts') {
  filePath = normalizeFilePath(filePath);
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
  return inventoryParsedSource(sourceFile, filePath);
}

export function inventorySources(sources) {
  const virtualRoot = resolve('/__sensitive_logging_inventory__');
  const entries = Object.entries(sources).map(([filePath, sourceText]) => {
    const normalizedPath = normalizeFilePath(filePath).replace(/^\/+/, '');
    return {
      absolutePath: resolve(virtualRoot, normalizedPath),
      filePath: normalizedPath,
      sourceText,
    };
  });
  const sourceByPath = new Map(
    entries.map((entry) => [entry.absolutePath, entry.sourceText]),
  );
  const options = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = ts.createCompilerHost(options);
  const defaultDirectoryExists = host.directoryExists?.bind(host);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  const defaultRealpath = host.realpath?.bind(host);
  const defaultReadFile = host.readFile.bind(host);
  host.directoryExists = (directoryName) => {
    const absoluteDirectory = resolve(directoryName);
    return (
      absoluteDirectory === virtualRoot ||
      [...sourceByPath.keys()].some((fileName) =>
        fileName.startsWith(`${absoluteDirectory}/`),
      ) ||
      defaultDirectoryExists?.(directoryName) === true
    );
  };
  host.fileExists = (fileName) =>
    sourceByPath.has(resolve(fileName)) || defaultFileExists(fileName);
  host.realpath = (fileName) =>
    sourceByPath.has(resolve(fileName))
      ? resolve(fileName)
      : (defaultRealpath?.(fileName) ?? fileName);
  host.readFile = (fileName) =>
    sourceByPath.get(resolve(fileName)) ?? defaultReadFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError) => {
    const sourceText = sourceByPath.get(resolve(fileName));
    return sourceText === undefined
      ? defaultGetSourceFile(fileName, languageVersion, onError)
      : ts.createSourceFile(
          fileName,
          sourceText,
          languageVersion,
          true,
          fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        );
  };
  host.getCurrentDirectory = () => virtualRoot;
  const program = ts.createProgram({
    rootNames: entries.map((entry) => entry.absolutePath),
    options,
    host,
  });
  const checker = program.getTypeChecker();
  return entries.flatMap((entry) => {
    const sourceFile = program.getSourceFile(entry.absolutePath);
    return sourceFile
      ? inventoryParsedSource(sourceFile, entry.filePath, checker)
      : [];
  });
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

function createInventoryProgram(cwd, absolutePaths) {
  let compilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
  };
  const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, 'tsconfig.json');
  if (configPath) {
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!loaded.error) {
      const parsed = ts.parseJsonConfigFileContent(
        loaded.config,
        ts.sys,
        dirname(configPath),
      );
      compilerOptions = {
        ...parsed.options,
        noEmit: true,
        skipLibCheck: true,
      };
    }
  }
  return ts.createProgram({
    rootNames: absolutePaths,
    options: compilerOptions,
  });
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

  const absolutePaths = roots.flatMap(collectSourceFiles).sort();
  const program = createInventoryProgram(cwd, absolutePaths);
  const checker = program.getTypeChecker();
  const findings = absolutePaths.flatMap((absolutePath) => {
    const filePath = normalizeFilePath(relative(cwd, absolutePath));
    const sourceFile = program.getSourceFile(absolutePath);
    return sourceFile
      ? inventoryParsedSource(sourceFile, filePath, checker)
      : inventorySource(readFileSync(absolutePath, 'utf8'), filePath);
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
