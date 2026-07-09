import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/'] },
  js.configs.recommended,
  // Type-aware linting, matching the root package's bar — `no-floating-promises`,
  // `no-misused-promises`, `await-thenable` et al. now cover the async event handlers
  // and stream consumers where a dropped promise would silently swallow a failure.
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
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    // Test fakes implement async interfaces with canned values, so an async method
    // with no await is the normal shape there, not a smell.
    files: ['**/*.test.{ts,tsx}', 'src/test/**'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // The build/lint config files sit outside the app's type-aware project graph.
    // `vite.config.ts` is still typechecked, under `tsconfig.node.json` (see the
    // `typecheck` script); here it is linted with the non-type-aware rules only.
    files: ['eslint.config.js', 'vite.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
);
