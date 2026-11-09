import hooks from 'eslint-plugin-react-hooks';
import tsParser from '@typescript-eslint/parser';

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.tmp/**', 'apps/dashboard/lib/material-icons/svg/**'] },
  {
    files: ['apps/dashboard/**/*.{ts,tsx}'],
    languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { 'react-hooks': hooks },
    // Official recommended checks apply to all dashboard code. Existing
    // diagnostics are accounted individually by check:react, never disabled.
    rules: hooks.configs.recommended.rules,
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
];
