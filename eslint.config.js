import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `web/` is a standalone Vite sub-project with its own TypeScript toolchain.
    ignores: ['dist/', '.mastra/', 'data/', 'node_modules/', 'web/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
