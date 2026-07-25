module.exports = {
  // Treat .mjs files as ESM modules
  extensionsToTreatAsEsm: ['.mjs'],

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
  moduleFileExtensions: ['js', 'mjs', 'cjs', 'json'],

  // Helpful verbosity for CI logs
  verbose: true
};
