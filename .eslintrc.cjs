module.exports = {
  root: true,
  env: {
    browser: true,
    node: true,
    es2023: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'react-hooks', 'react-refresh'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
    'prettier',
  ],
  overrides: [
    {
      files: ['src/renderer/src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
      env: {
        browser: true,
      },
      rules: {
        'react-refresh/only-export-components': [
          'warn',
          { allowConstantExport: true },
        ],
      },
    },
    {
      files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/shared/**/*.ts'],
      env: {
        browser: false,
        node: true,
      },
    },
  ],
  ignorePatterns: ['dist', 'dist-electron', 'out', 'node_modules', 'coverage'],
};
