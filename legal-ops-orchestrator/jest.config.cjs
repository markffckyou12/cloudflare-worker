module.exports = {
  // .js is auto-inferred as ESM when "type": "module" is in package.json
  // So we don't need to include it here
  extensionsToTreatAsEsm: [],

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
