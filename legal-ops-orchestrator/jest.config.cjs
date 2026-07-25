module.exports = {
  // Treat .js files as ESM (don't include .mjs here — .mjs is always ESM)
  extensionsToTreatAsEsm: ['.js'],

  // Find tests under test/ or __tests__ and any *.mjs test files
  testMatch: [
    '**/test/**/*.mjs',
    '**/__tests__/**/*.mjs',
    '**/?(*.)+(spec|test).mjs'
  ],

  // No transform (ESM files are executed natively via --experimental-vm-modules)
  transform: {},

  // Use the Node test environment
  testEnvironment: 'node',

  // Recognize these module extensions
  moduleFileExtensions: ['mjs', 'js', 'cjs', 'json'],

  // Helpful verbosity for CI logs
  verbose: true,

  // Keep node_modules ignored by default
  transformIgnorePatterns: ['/node_modules/']
};
