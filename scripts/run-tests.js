'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDirectory = path.join(__dirname, '..', 'test');
const testFiles = fs
  .readdirSync(testDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
  .map((entry) => path.join(testDirectory, entry.name))
  .sort();

if (testFiles.length === 0) {
  throw new Error(`No test files found in ${testDirectory}`);
}

const result = spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=1', ...testFiles],
  { stdio: 'inherit' },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
