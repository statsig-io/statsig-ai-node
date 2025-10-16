const tseslint = require('@typescript-eslint/eslint-plugin');
const tsparser = require('@typescript-eslint/parser');
const simpleImportSort = require('eslint-plugin-simple-import-sort');

module.exports = [
  // Global ignores
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.test.ts',
      '**/__tests__/**',
    ],
  },
  // Base configuration for all TypeScript files
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: './tsconfig.json',
        ecmaVersion: 2020,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      // ESLint recommended rules
      ...require('@eslint/js').configs.recommended.rules,
      // TypeScript ESLint recommended rules
      ...tseslint.configs['eslint-recommended'].overrides[0].rules,
      ...tseslint.configs.recommended.rules,
      ...tseslint.configs['recommended-requiring-type-checking'].rules,
      
      // Custom rules
      'simple-import-sort/imports': 'off', // Disabled to prevent conflicts with editor formatting
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['off', { varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-for-in-array': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksVoidReturn: false,
        },
      ],
      '@typescript-eslint/no-floating-promises': ['warn', { ignoreVoid: true }],
      '@typescript-eslint/restrict-plus-operands': 'warn',
    },
  },
  // Override for specific files - safeFetch.ts and StatsigContext.ts
  {
    files: ['**/safeFetch.ts', '**/StatsigContext.ts'],
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
    },
  },
  // Override for core.ts
  {
    files: ['**/core.ts'],
    rules: {
      '@typescript-eslint/no-var-requires': 'off',
    },
  },
  // Override for DynamicConfig.ts and Layer.ts
  {
    files: ['**/DynamicConfig.ts', '**/Layer.ts'],
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
    },
  },
];

