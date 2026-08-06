/**
 * An OpenAI client resolved through either the ESM or CommonJS declaration graph.
 *
 * The `openai` package publishes separate declarations for its `import` and
 * `require` conditions. Because the client class has private members, TypeScript
 * treats those declarations as nominally distinct even though they represent the
 * same runtime client.
 */
export type OpenAIClient =
  | import('openai/index.mjs').OpenAI
  | import('openai').OpenAI;
