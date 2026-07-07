import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `web/` is a standalone Vite sub-project with its own TypeScript toolchain.
    ignores: ['dist/', '.mastra/', 'data/', 'node_modules/', 'web/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Test fakes implement async interfaces with canned values, so an async method
    // with no await is the normal shape there, not a smell.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // The config file itself is plain JS, outside the type-aware project graph.
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
