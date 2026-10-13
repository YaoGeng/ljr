// @ts-check
// ESLint 9 flat config（ADR-0002）：typescript-eslint recommended 起步，格式交给 Prettier。
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.expo/**',
      'docs/**',
      'prototype/**',
      '.superpowers/**',
      '.zcode/**',
      '.tools/**', // M0-3 portable 数据库工具栈（本地解压，已 gitignore）
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 显式圈定 TS 后缀，保证 `eslint .` 覆盖各包 .ts/.tsx
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  prettier,
];
