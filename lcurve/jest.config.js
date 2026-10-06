const unit = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  displayName: 'unit',
  testMatch: ['<rootDir>/test/unit/**/*.test.ts'],
};

const db = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  displayName: 'db',
  testMatch: ['<rootDir>/test/db/**/*.test.ts'],
  globalSetup: '<rootDir>/test/helpers/globalSetup.js',
  globalTeardown: '<rootDir>/test/helpers/globalTeardown.js',
};

// maxWorkers 只能全局设置：DB 测试共享一个库，必须串行
module.exports = { projects: [unit, db], testTimeout: 90000, maxWorkers: 1 };
