import process from 'node:process';
import { checkMixedImports } from './import-checks.mjs';
await checkMixedImports((specifier) => import(specifier), process.argv[2]);
