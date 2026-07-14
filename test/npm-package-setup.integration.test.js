'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

test('setup from a packed npm install creates a self-contained runtime', {
  skip: process.platform !== 'darwin',
  timeout: 120000
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-coding-status-pack-'));
  const home = path.join(directory, 'home');
  const consumer = path.join(directory, 'consumer');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(consumer, { recursive: true });
  fs.writeFileSync(path.join(consumer, 'package.json'), '{"private":true}\n');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const packed = JSON.parse(execFileSync(NPM, [
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination', directory
  ], {
    cwd: ROOT,
    encoding: 'utf8'
  }));
  const tarball = path.join(directory, packed[0].filename);

  execFileSync(NPM, [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    tarball
  ], {
    cwd: consumer,
    stdio: 'pipe'
  });

  const packageRoot = path.join(consumer, 'node_modules', 'discord-coding-status');
  const packageCli = path.join(packageRoot, 'dist', 'cli.js');
  assert.equal(
    fs.existsSync(path.join(packageRoot, 'node_modules')),
    false,
    'fixture must use npm\'s hoisted dependency layout'
  );

  const env = {
    ...process.env,
    FORCE_COLOR: '0',
    HOME: home,
    USERPROFILE: home
  };
  execFileSync(process.execPath, [
    packageCli,
    'setup',
    '--no-start',
    '--no-codex-hooks'
  ], {
    cwd: consumer,
    env,
    stdio: 'pipe'
  });

  const runtimeRoot = path.join(
    home,
    'Library',
    'Application Support',
    'discord-coding-status',
    'app'
  );
  assert.ok(fs.existsSync(path.join(runtimeRoot, 'node_modules', 'chalk', 'package.json')));
  assert.ok(fs.existsSync(path.join(runtimeRoot, 'node_modules', 'discord-rpc', 'package.json')));

  const version = execFileSync(process.execPath, [
    path.join(runtimeRoot, 'dist', 'cli.js'),
    '--version'
  ], {
    env,
    encoding: 'utf8'
  }).trim();
  assert.equal(version, '1.0.1');
});
