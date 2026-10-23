import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/dev-dist/**', '**/generated/**', 'docs/**', '**/*.config.{js,ts}'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  {
    files: ['apps/api/**/*.ts', 'packages/**/*.ts', 'infra/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // NestJS lit les types des paramètres du constructeur à l'exécution (injection de dépendances) :
    // ces imports ne doivent pas devenir des « import type ».
    files: ['apps/api/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}', 'apps/menu/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Absent des navigateurs anciens et des pages au certificat non reconnu : newId() de @tchop/shared.
      'no-restricted-properties': [
        'error',
        { object: 'crypto', property: 'randomUUID', message: 'Utiliser newId() de @tchop/shared.' },
      ],
    },
  },
);
