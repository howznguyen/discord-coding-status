'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CLAUDE_MANAGED_HOOK_MARKER,
  ClaudeSessionModelTracker,
  extractClaudeModelFromHookInput,
  extractClaudeModelFromTranscriptJsonl,
  extractClaudeModelFromTranscriptRecord,
  getManagedClaudeHookStatus,
  installManagedClaudeHooks,
  readClaudeModelFromTranscript,
  removeManagedClaudeHooks
} = require('../dist/claude-hooks');

function commandForEvent(eventName) {
  return `node cli.js claude-hook --event ${eventName} ${CLAUDE_MANAGED_HOOK_MARKER}`;
}

test('Claude model extraction returns only whitelisted raw model metadata', () => {
  const hookInput = {
    session_id: 'session-a',
    model: '  claude-sonnet-4-6  ',
    prompt: 'private prompt mentioning fabricated-model-from-content'
  };
  assert.equal(extractClaudeModelFromHookInput(hookInput), 'claude-sonnet-4-6');

  const transcriptRecord = {
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6',
      role: 'assistant',
      content: [{ type: 'text', text: 'private response' }]
    }
  };
  assert.equal(extractClaudeModelFromTranscriptRecord(transcriptRecord), 'claude-opus-4-6');
  assert.equal(extractClaudeModelFromTranscriptRecord({
    type: 'user',
    message: {
      content: [{ type: 'text', text: 'model: fabricated-model-from-content' }]
    }
  }), null);
});

test('transcript parsing keeps content private and treats a partial newest line as lag', () => {
  const privatePrompt = 'do-not-expose-this-prompt';
  const privateResponse = 'do-not-expose-this-response';
  const completeTranscript = [
    JSON.stringify({ type: 'user', message: { content: privatePrompt } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: privateResponse }]
      }
    })
  ].join('\n');

  const model = extractClaudeModelFromTranscriptJsonl(completeTranscript);
  assert.equal(model, 'claude-sonnet-4-6');
  assert.doesNotMatch(JSON.stringify({ model }), new RegExp(`${privatePrompt}|${privateResponse}`));

  const laggingTranscript = `${completeTranscript}\n{"type":"assistant","message":`;
  assert.equal(extractClaudeModelFromTranscriptJsonl(laggingTranscript), null);
  assert.equal(readClaudeModelFromTranscript('/injected/transcript.jsonl', {
    readTail: () => ({ text: laggingTranscript })
  }), null);
});

test('per-session tracker retains last-known model through lag and applies model changes', () => {
  const tracker = new ClaudeSessionModelTracker();
  const first = tracker.observe({
    sessionId: 'session-a',
    transcriptModel: 'claude-sonnet-4-6'
  });
  assert.deepEqual(first, {
    sessionId: 'session-a',
    model: 'claude-sonnet-4-6',
    source: 'transcript',
    changed: true
  });

  const lagging = tracker.observe({ sessionId: 'session-a' });
  assert.equal(lagging.model, 'claude-sonnet-4-6');
  assert.equal(lagging.source, 'last-known');
  assert.equal(lagging.changed, false);

  const changed = tracker.observe({
    sessionId: 'session-a',
    hookInput: { model: 'claude-opus-4-6' },
    transcriptModel: 'claude-sonnet-4-6'
  });
  assert.equal(changed.model, 'claude-opus-4-6');
  assert.equal(changed.source, 'hook');
  assert.equal(changed.changed, true);
  assert.equal(tracker.get('session-a'), 'claude-opus-4-6');
  assert.equal(tracker.get('session-b'), null);
});

test('managed hook install is pure, idempotent, and preserves unrelated Claude settings', () => {
  const original = {
    permissions: { allow: ['Read'] },
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: 'node unrelated.js' }]
        }
      ],
      Stop: [
        {
          hooks: [{ type: 'command', command: `node old.js ${CLAUDE_MANAGED_HOOK_MARKER}` }]
        }
      ],
      CustomValue: 'preserve-invalid-but-unrelated-value'
    }
  };
  const before = structuredClone(original);
  const first = installManagedClaudeHooks(original, {
    events: ['SessionStart', 'PreToolUse'],
    commandForEvent,
    timeout: 5
  });

  assert.deepEqual(original, before, 'install must not mutate caller-owned settings');
  assert.equal(first.installed, 2);
  assert.equal(first.removed, 1);
  assert.deepEqual(first.settings.permissions, original.permissions);
  assert.equal(first.settings.hooks.CustomValue, 'preserve-invalid-but-unrelated-value');
  assert.equal(first.settings.hooks.PreToolUse[0].hooks[0].command, 'node unrelated.js');

  const second = installManagedClaudeHooks(first.settings, {
    events: ['SessionStart', 'PreToolUse', 'PreToolUse'],
    commandForEvent,
    timeout: 5
  });
  const status = getManagedClaudeHookStatus(second.settings, ['SessionStart', 'PreToolUse']);
  assert.equal(status.installed, true);
  assert.equal(status.managedCount, 2);
  assert.deepEqual(status.missingEvents, []);
  assert.deepEqual(status.duplicateEvents, []);
  assert.deepEqual(status.unexpectedEvents, []);
});

test('managed hook uninstall removes only owned entries and reports clean status', () => {
  const installed = installManagedClaudeHooks({
    env: { KEEP: 'yes' },
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'node keep.js' }] }]
    }
  }, {
    events: ['SessionStart', 'Stop'],
    commandForEvent
  });
  const removed = removeManagedClaudeHooks(installed.settings);

  assert.equal(removed.removed, 2);
  assert.deepEqual(removed.settings.env, { KEEP: 'yes' });
  assert.equal(removed.settings.hooks.SessionStart.length, 1);
  assert.equal(removed.settings.hooks.SessionStart[0].hooks[0].command, 'node keep.js');
  assert.equal(Object.hasOwn(removed.settings.hooks, 'Stop'), false);

  const status = getManagedClaudeHookStatus(removed.settings, ['SessionStart', 'Stop']);
  assert.equal(status.installed, false);
  assert.equal(status.managedCount, 0);
  assert.deepEqual(status.missingEvents, ['SessionStart', 'Stop']);
});
