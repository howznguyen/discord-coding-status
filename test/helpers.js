'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const RPC_MOCK = path.join(__dirname, 'fixtures', 'mock-discord-rpc.cjs');

function createTestEnvironment(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-coding-status-'));
  const stateFile = path.join(directory, 'states.json');
  const rpcLogFile = path.join(directory, 'rpc.jsonl');
  const nodeOptions = [process.env.NODE_OPTIONS, `--require=${RPC_MOCK}`]
    .filter(Boolean)
    .join(' ');
  const env = {
    ...process.env,
    FORCE_COLOR: '0',
    NODE_OPTIONS: nodeOptions,
    DISCORD_CLIENT_ID: '',
    DISCORD_CODING_STATUS_DETAIL_LEVEL: 'full',
    DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE: 'off',
    DISCORD_CODING_STATUS_PROCESS_DETECTION: 'off',
    DISCORD_CODING_STATUS_POLL_INTERVAL_MS: '60000',
    DISCORD_CODING_STATUS_STATE_FILE: stateFile,
    DISCORD_CODING_STATUS_RPC_LOG_FILE: rpcLogFile,
    ...overrides
  };

  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, env, rpcLogFile, stateFile };
}

function runCli(args, env, timeoutMs = 15000, input = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env,
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(
        `CLI failed (${code ?? signal}): ${args.join(' ')}\n${stdout}\n${stderr}`
      ));
    });

    if (input !== null) {
      child.stdin.end(input);
    }
  });
}

function startDaemon(t, env) {
  const child = spawn(process.execPath, [CLI, 'daemon'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  });

  return {
    child,
    output() {
      return { stdout, stderr };
    }
  };
}

function readRpcEvents(logFile) {
  if (!fs.existsSync(logFile)) {
    return [];
  }

  return fs.readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitFor(predicate, description, timeoutMs = 8000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await predicate();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const suffix = lastError ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${description}.${suffix}`);
}

module.exports = {
  createTestEnvironment,
  readRpcEvents,
  runCli,
  startDaemon,
  waitFor
};
