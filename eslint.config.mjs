import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import tseslint from 'typescript-eslint';

export default defineConfig([
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.next/**',
      '**/.react-router/**',
    ],
  },
  {
    files: ['frontend/**/*.{ts,tsx}', 'backend/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended, prettier],
  },
]);
