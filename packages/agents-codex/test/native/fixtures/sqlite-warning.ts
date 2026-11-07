import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Load the real SQLite builtin while accounting only for its Node 22 import warning. */
export function loadSqliteForTest() {
  const emitWarning = process.emitWarning;
  process.emitWarning = (...args: unknown[]) => {
    if (
      args[0] ===
        'SQLite is an experimental feature and might change at any time' &&
      args[1] === 'ExperimentalWarning' &&
      args.slice(2).every((argument) => argument === undefined)
    )
      return;
    Reflect.apply(emitWarning, process, args);
  };
  try {
    const sqlite: typeof import('node:sqlite') = require('node:sqlite');
    return sqlite;
  } finally {
    process.emitWarning = emitWarning;
  }
}
