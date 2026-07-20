'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const sourceRoot = path.join(__dirname, '..', 'src');
const distRoot = path.join(__dirname, '..', 'dist');

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(target);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [target] : [];
  });
}

function sourceLayer(file) {
  return path.relative(sourceRoot, file).split(path.sep)[0];
}

function importedLayer(file, specifier) {
  if (!specifier.startsWith('.')) {
    return null;
  }

  const resolved = path.resolve(path.dirname(file), specifier);
  return path.relative(sourceRoot, resolved).split(path.sep)[0];
}

test('source uses TypeScript imports and keeps declarations out of the CLI entrypoint', () => {
  const files = sourceFiles(sourceRoot);
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\brequire\s*\(/, `${path.relative(sourceRoot, file)} uses require()`);
  }

  const cli = fs.readFileSync(path.join(sourceRoot, 'cli.ts'), 'utf8');
  assert.doesNotMatch(cli, /^(?:export\s+)?(?:type|interface)\s+/m);
});

test('core, adapters, commands, and providers follow inward dependency boundaries', () => {
  const allowed = {
    core: new Set(['core']),
    adapters: new Set(['adapters', 'core']),
    commands: new Set(['commands', 'core']),
    providers: new Set(['providers', 'core'])
  };

  for (const file of sourceFiles(sourceRoot)) {
    const layer = sourceLayer(file);
    if (!allowed[layer]) {
      continue;
    }

    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      const dependencyLayer = importedLayer(file, match[1]);
      if (!dependencyLayer) {
        continue;
      }

      assert.equal(
        allowed[layer].has(dependencyLayer),
        true,
        `${path.relative(sourceRoot, file)} (${layer}) imports ${dependencyLayer}`
      );
    }
  }
});

test('build output does not retain modules from pre-refactor paths', () => {
  for (const legacyFile of [
    'types.js',
    'setup-detection.js',
    'process-detection.js',
    'tool-detection.js'
  ]) {
    assert.equal(fs.existsSync(path.join(distRoot, legacyFile)), false, legacyFile);
  }
});
