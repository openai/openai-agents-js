// export default {
//   parser: '@typescript-eslint/parser',
//   plugins: ['@typescript-eslint', 'unused-imports', 'prettier'],
//   rules: {
//     'no-unused-vars': 'off',
//     'prettier/prettier': 'error',
//     'unused-imports/no-unused-imports': 'error',
//   },
//   root: true,
// };

import eslint from '@eslint/js';
// import someOtherConfig from 'eslint-config-other-configuration-that-enables-formatting-rules';
import prettierConfig from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';
import { globalIgnores } from 'eslint/config';

export default tseslint.config(
  globalIgnores([
    '**/dist/**',
    '**/node_modules/**',
    '**/.tmp/**',
    '**/.cache/**',
    '**/docs/.astro/**',
    'examples/classic/realtime-next/**',
    'examples/classic/realtime-demo/**',
    'examples/classic/nextjs/**',
    'examples/classic/ai-sdk-ui/**',
    'integration-tests//**',
    'packages/agents-codex/native/.upstream/**',
    'packages/agents-codex/native/target/**',
    'tsc-multi.json',
  ]),
  eslint.configs.recommended,
  tseslint.configs.recommended,
  prettierConfig,
  [
    {
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrorsIgnorePattern: '^_',
          },
        ],
      },
    },
    {
      files: [
        'packages/agents-codex/experimental/*.cjs',
        'packages/agents/test/classic/fixtures/*.cjs',
      ],
      rules: {
        '@typescript-eslint/no-require-imports': 'off',
      },
    },
    {
      files: ['examples/classic/docs/**'],
      rules: {
        '@typescript-eslint/no-unused-vars': 'off',
      },
    },
  ],
);
