module.exports = {
  extensionsToTreatAsEsm: [],

  // Find tests — simplified pattern to match your test files
  testMatch: [
    '**/test/**/*.test.mjs',
    '**/test/**/*.spec.mjs',
    '**/__tests__/**/*.mjs'
  ],

  transform: {},
  testEnvironment: 'node',
  moduleFileExtensions: ['mjs', 'js', 'cjs', 'json'],
  verbose: true,
  transformIgnorePatterns: ['/node_modules/']
};
