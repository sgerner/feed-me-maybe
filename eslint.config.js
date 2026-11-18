import js from '@eslint/js';
import tsPlugin from 'typescript-eslint';
import globals from 'globals';
import svelte from 'eslint-plugin-svelte';

export default [
  { ignores: ['build/', '.svelte-kit/', 'dist/', '.opencode/'] },
  js.configs.recommended,
  ...tsPlugin.configs.recommended,
  ...svelte.configs.base,
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parserOptions: { parser: tsPlugin.parser },
    },
  },
  {
    files: ['**/*.svelte'],
    rules: {
      'svelte/no-dupe-else-if-blocks': 'error',
      'svelte/no-dupe-on-directives': 'error',
      'svelte/no-dynamic-slot-name': 'error',
      'svelte/no-immutable-reactive-statements': 'error',
      'svelte/valid-compile': 'error',
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
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
