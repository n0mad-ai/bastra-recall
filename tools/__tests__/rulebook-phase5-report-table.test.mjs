import test from 'node:test';
import assert from 'node:assert/strict';
import {escapeReportCell} from '../probes/rulebook-phase5/report-table.ts';

test('probe report cells contain no physical line breaks from CR, LF or CRLF', () => {
  for (const newline of ['\r', '\n', '\r\n']) {
    const row = `| detail | ${escapeReportCell(`before${newline}after`)} |`;
    assert.doesNotMatch(row, /[\r\n]/);
    assert.ok(row.includes('before') && row.includes('after'));
  }
});

test('report escaping preserves existing backslash, pipe and LF handling', () => {
  assert.equal(escapeReportCell('path\\file|line\nnext'), 'path\\\\file\\|line next');
});
