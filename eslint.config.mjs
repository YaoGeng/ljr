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
      '**/test-results/**', // Playwright 输出（M3-W1 T5：失败现场快照，机器生成）
      '**/playwright-report/**',
      'docs/**',
      'prototype/**',
      '.superpowers/**',
      '.zcode/**',
      '.tools/**', // M0-3 portable 数据库工具栈（本地解压，已 gitignore）
      'skills/**', // M0-6 技能库：给 agent 读的（vendor 原样快照 + 自建 SKILL.md），非 tsc/eslint 编译对象
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
