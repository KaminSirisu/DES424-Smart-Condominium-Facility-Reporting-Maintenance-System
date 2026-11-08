import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/cdk.out/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['frontend/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['backend/**/*.ts', 'tests/**/*.ts', 'infrastructure/aws/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['tests/smoke/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
);
