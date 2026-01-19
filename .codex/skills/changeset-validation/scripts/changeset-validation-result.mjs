#!/usr/bin/env node

import fs from 'fs';

const { console, process } = globalThis;

function printUsage() {
  console.log('Usage: pnpm changeset:validate-result -- <path-to-json>');
}

function readJson(filePath) {
  const contents = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(contents);
}

function validateShape(data) {
  if (typeof data?.ok !== 'boolean') return 'Missing ok boolean.';
  if (!Array.isArray(data?.errors)) return 'Missing errors array.';
  if (!Array.isArray(data?.warnings)) return 'Missing warnings array.';
  if (!['patch', 'minor', 'major', 'none'].includes(data?.required_bump)) {
    return 'Missing required_bump with value patch/minor/major/none.';
  }
  return null;
}

function printWarnings(warnings) {
  if (warnings.length === 0) return;
  console.warn('\nWarnings:');
  for (const warning of warnings) {
    console.warn(`- ${warning}`);
  }
}

function main() {
  const inputPath = process.argv
    .slice(2)
    .filter((arg) => arg !== '--')
    .find(Boolean);
  if (!inputPath) {
    printUsage();
    process.exit(1);
  }

  let data;
  try {
    data = readJson(inputPath);
  } catch (_error) {
    console.error(`Failed to read JSON from ${inputPath}.`);
    process.exit(1);
  }

  const shapeError = validateShape(data);
  if (shapeError) {
    console.error(`changeset-validation failed: ${shapeError}`);
    process.exit(1);
  }

  if (!data.ok) {
    console.error('changeset-validation failed.');
    for (const message of data.errors) {
      console.error(`- ${message}`);
    }
    printWarnings(data.warnings);
    process.exit(1);
  }

  console.log('changeset-validation passed.');
  printWarnings(data.warnings);
}

main();
