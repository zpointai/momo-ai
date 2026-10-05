import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['node_modules/**','dist/**','dist-electron/**','release/**','artifacts/**'] },
  ...tseslint.configs.recommended,
  { files: ['**/*.{ts,tsx,mjs}'], rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }], '@typescript-eslint/no-explicit-any': 'error' } },
  { files: ['src/desktop/**/*.{ts,tsx}','src/shared/**/*.ts'], rules: { 'no-restricted-imports': ['error', { patterns: ['electron','node:*','firebase*','@google/*','@react-oauth/*','*hooks*','*mocks*','*lib/firebase*','*electron/*'] }] } }
);

