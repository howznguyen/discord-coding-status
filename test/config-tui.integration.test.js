'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  createTestEnvironment,
  runCli
} = require('./helpers');

test('config preview reflects persisted display visibility controls', async (t) => {
  const { directory, env: baseEnv } = createTestEnvironment(t);
  const env = {
    ...baseEnv,
    HOME: directory,
    USERPROFILE: directory
  };
  const configDirectory = path.join(directory, 'discord-coding-status');
  fs.mkdirSync(configDirectory, { recursive: true });
  fs.writeFileSync(path.join(configDirectory, 'config.json'), `${JSON.stringify({
    showActivity: true,
    showProject: true,
    showModel: false,
    showQuota: false,
    showContext: true,
    activityStyle: 'normal',
    showPackage: true
  }, null, 2)}\n`);

  const preview = await runCli(['config', '--preview'], env);
  assert.match(preview.stdout, /Top: Running a command \| [^\r\n]+ @ [^\r\n]+/);
  assert.doesNotMatch(preview.stdout, /Bash survived the assignment/);
  assert.match(preview.stdout, /Bottom: ctx 42% \| pkg discord-coding-status/);
  assert.doesNotMatch(preview.stdout, /gpt-5\.6-sol|weekly 54%/);
  assert.equal(preview.stderr, '');

  const shown = await runCli(['config', '--show'], env);
  const config = JSON.parse(shown.stdout);
  assert.equal(config.showModel, false);
  assert.equal(config.showQuota, false);
  assert.equal(config.showContext, true);
  assert.equal(config.activityStyle, 'normal');
  assert.equal(config.showPackage, true);
});

test('config reset restarts an installed macOS launch agent unless disabled', {
  skip: process.platform !== 'darwin'
}, async (t) => {
  const { directory, env: baseEnv } = createTestEnvironment(t);
  const launchAgentsDirectory = path.join(directory, 'Library', 'LaunchAgents');
  const plistPath = path.join(
    launchAgentsDirectory,
    'io.github.discord-coding-status.daemon.plist'
  );
  const binDirectory = path.join(directory, 'bin');
  const restartLog = path.join(directory, 'restart.log');
  fs.mkdirSync(launchAgentsDirectory, { recursive: true });
  fs.mkdirSync(binDirectory, { recursive: true });
  fs.writeFileSync(plistPath, '<plist/>\n');

  const launchctlPath = path.join(binDirectory, 'launchctl');
  fs.writeFileSync(
    launchctlPath,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DCS_RESTART_LOG"\n'
  );
  fs.chmodSync(launchctlPath, 0o755);

  const env = {
    ...baseEnv,
    HOME: directory,
    PATH: `${binDirectory}${path.delimiter}${baseEnv.PATH || ''}`,
    DCS_RESTART_LOG: restartLog
  };
  const reset = await runCli(['config', '--reset'], env);
  assert.match(reset.stdout, /Daemon restarted\. Config is now active\./);
  assert.match(
    fs.readFileSync(restartLog, 'utf8'),
    new RegExp(`kickstart -k gui/${process.getuid()}/io\\.github\\.discord-coding-status\\.daemon`)
  );

  fs.writeFileSync(restartLog, '');
  const skipped = await runCli(['config', '--reset', '--no-restart'], env);
  assert.match(skipped.stdout, /Daemon restart skipped by --no-restart\./);
  assert.equal(fs.readFileSync(restartLog, 'utf8'), '');
});
