'use strict';

const fs = require('node:fs');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const originalLoad = Module._load;

function record(method, clientId, payload = {}) {
  const logFile = process.env.DISCORD_CODING_STATUS_RPC_LOG_FILE;
  if (!logFile) {
    return;
  }

  fs.appendFileSync(logFile, `${JSON.stringify({ method, clientId, ...payload })}\n`);
}

class MockClient extends EventEmitter {
  constructor() {
    super();
    this.clientId = null;
  }

  async login({ clientId }) {
    this.clientId = clientId;
    setImmediate(() => this.emit('ready'));
    return this;
  }

  async setActivity(activity) {
    record('setActivity', this.clientId, { activity });
  }

  async clearActivity() {
    record('clearActivity', this.clientId);
  }

  destroy() {}
}

const mockDiscordRpc = {
  Client: MockClient,
  register() {}
};

Module._load = function load(request, parent, isMain) {
  if (request === 'discord-rpc') {
    return mockDiscordRpc;
  }

  return originalLoad.call(this, request, parent, isMain);
};
