/* global exports */
// Keep native import() when the TypeScript CommonJS build rewrites it to require().
exports.loadOpenAIEntrypoint = () => import('openai/index.mjs');
