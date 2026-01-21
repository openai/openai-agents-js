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
    '**/docs/.astro/**',
    'examples/realtime-next/**',
    'examples/realtime-demo/**',
    'examples/nextjs/**',
    'examples/ai-sdk-ui/**',
    'integration-tests//**',
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
      files: ['examples/docs/**'],
      rules: {
        '@typescript-eslint/no-unused-vars': 'off',
      },
    },
  ],
);
