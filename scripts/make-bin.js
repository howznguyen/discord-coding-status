#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const binPath = path.join(__dirname, '..', 'dist', 'cli.js');

if (!fs.existsSync(binPath)) {
  throw new Error(`Missing build output: ${binPath}`);
}

const content = fs.readFileSync(binPath, 'utf8');
const withShebang = content.startsWith('#!/usr/bin/env node')
  ? content
  : `#!/usr/bin/env node\n${content.replace(/^#!.*\n/, '')}`;

fs.writeFileSync(binPath, withShebang);
fs.chmodSync(binPath, 0o755);
