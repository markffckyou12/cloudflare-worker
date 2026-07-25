module.exports = {
  extensionsToTreatAsEsm: [],
  testMatch: [
    '**/test/**/*.test.mjs',
    '**/test/**/*.spec.mjs',
  ],
  transform: {},
  testEnvironment: 'node',
  moduleFileExtensions: ['mjs', 'js', 'cjs', 'json'],
  verbose: true,
  transformIgnorePatterns: ['/node_modules/']
};
