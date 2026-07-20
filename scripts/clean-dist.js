'use strict';

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const distDirectory = path.join(projectRoot, 'dist');

if (path.dirname(distDirectory) !== projectRoot || path.basename(distDirectory) !== 'dist') {
  throw new Error(`Refusing to clean unexpected build directory: ${distDirectory}`);
}

fs.rmSync(distDirectory, { recursive: true, force: true });
