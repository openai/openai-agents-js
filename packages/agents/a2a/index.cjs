'use strict';
/* global require, module */
try {
  require.resolve('@a2a-js/sdk');
} catch (error) {
  if (error?.code === 'MODULE_NOT_FOUND')
    throw new Error(
      'A2A requires optional @a2a-js/sdk@1.0.1. Install it before importing @openai/agents/a2a.',
    );
  throw error;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports -- This package entry point serves CommonJS consumers.
module.exports = require('../dist/a2a/index.js');
