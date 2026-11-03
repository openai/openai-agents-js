import process from 'node:process';
import { checkConditions } from './import-checks.mjs';
await checkConditions(
  (specifier) => import(specifier),
  import.meta.resolve,
  process.argv[2],
  'mjs',
);
