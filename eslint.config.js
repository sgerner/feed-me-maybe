import js from '@eslint/js';
import tsPlugin from 'typescript-eslint';
import globals from 'globals';
import svelte from 'eslint-plugin-svelte';

export default [
  { ignores: ['build/', '.svelte-kit/', 'dist/', '.opencode/'] },
  js.configs.recommended,
  ...tsPlugin.configs.recommended,
  ...svelte.configs.recommended,
  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parserOptions: {
        extraFileExtensions: ['.svelte'],
        parser: tsPlugin.parser,
      },
    },
    rules: {
      'no-undef': 'off',
    },
  },
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
