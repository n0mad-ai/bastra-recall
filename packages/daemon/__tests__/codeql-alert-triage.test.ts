import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { textAfterToolWrappers } from '../src/system-turn.js';

test('alert 180: only fixed protocol tag names reach the dynamic regexp', () => {
  for (const tag of ['bash-input', 'bash-stdout', 'bash-stderr', 'local-command-stdout', 'local-command-stderr', 'command-message']) {
    assert.equal(textAfterToolWrappers(`<${tag}>ignored</${tag}>owner suffix`), 'owner suffix');
    assert.equal(textAfterToolWrappers(`<${tag.toUpperCase()}>ignored</${tag.toUpperCase()}>owner suffix`), null);
  }
  for (const tag of ['bash-stdout.*', 'bash-stdout|.*', 'bash-stdout(a+)+']) {
    const text = `<${tag}>ordinary</${tag}>suffix`;
    assert.equal(textAfterToolWrappers(text), text);
  }
});

test('alert 179: vendored Bash grammar matches pinned upstream digest', async () => {
  const root = new URL('../vendor/', import.meta.url);
  const meta = JSON.parse(await readFile(new URL('tree-sitter-bash.json', root), 'utf8'));
  assert.equal(meta.source, 'https://github.com/tree-sitter/tree-sitter-bash/releases/download/v0.25.1/tree-sitter-bash.wasm');
  assert.equal(meta.license, 'MIT');
  assert.equal(createHash('sha256').update(await readFile(new URL('tree-sitter-bash.wasm', root))).digest('hex'), meta.sha256);
});
