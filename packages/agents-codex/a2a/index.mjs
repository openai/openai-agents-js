import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
try {
  require.resolve('@a2a-js/sdk');
} catch (error) {
  if (error?.code === 'MODULE_NOT_FOUND')
    throw new Error(
      'A2A requires optional @a2a-js/sdk@1.0.1. Install it before importing @openai/agents/a2a.',
    );
  throw error;
}
export const {
  connectA2A,
  A2AError,
  A2AJobProvider,
  NativeA2AExecutor,
  a2aInput,
} = await import('../dist/a2a/index.mjs');
