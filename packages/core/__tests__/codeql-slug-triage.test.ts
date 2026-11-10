import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairRequired } from '../src/frontmatter-rescue.js';

test('alert 181: slug separator runs collapse before edge trimming', () => {
  for (const filename of [`${'-'.repeat(200000)}.md`, `${'-'.repeat(200000)}alpha${'-'.repeat(200000)}.md`]) {
    const data: Record<string, unknown> = {};
    repairRequired(data, filename, 0, '', [], () => false);
    assert.equal(data.id, filename.includes('alpha') ? 'alpha' : 'untitled');
  }
});

