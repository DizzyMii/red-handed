import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff } from '../src/diff.mjs';

const diff = (...lines) => lines.join('\n') + '\n';

test('modified file: hunk lines carry both counters, context is not in added or removed', () => {
  const { files, truncated } = parseDiff(diff(
    'diff --git a/src/cart.js b/src/cart.js',
    'index 1111111..2222222 100644',
    '--- a/src/cart.js',
    '+++ b/src/cart.js',
    '@@ -1,5 +1,5 @@',
    ' const a = 1;',
    ' const b = 2;',
    '-const c = 3;',
    '+const c = 4;',
    ' const d = 5;',
    ' const e = 6;',
  ));
  assert.equal(truncated, false);
  assert.equal(files.length, 1);
  const f = files[0];
  assert.deepEqual(Object.keys(f), ['oldPath', 'newPath', 'status', 'binary', 'hunks', 'added', 'removed']);
  assert.equal(f.oldPath, 'src/cart.js');
  assert.equal(f.newPath, 'src/cart.js');
  assert.equal(f.status, 'modified');
  assert.equal(f.binary, false);
  assert.equal(f.hunks.length, 1);
  assert.equal(f.hunks[0].oldStart, 1);
  assert.equal(f.hunks[0].newStart, 1);
  assert.deepEqual(f.hunks[0].lines.map(l => l.kind), [' ', ' ', '-', '+', ' ', ' ']);
  assert.deepEqual(f.hunks[0].lines[0], { kind: ' ', text: 'const a = 1;', oldLine: 1, newLine: 1 });
  assert.deepEqual(f.hunks[0].lines[2], { kind: '-', text: 'const c = 3;', oldLine: 3, newLine: null });
  assert.deepEqual(f.hunks[0].lines[5], { kind: ' ', text: 'const e = 6;', oldLine: 5, newLine: 5 });
  assert.deepEqual(f.added, [{ line: 3, text: 'const c = 4;', hunk: 0 }]);
  assert.deepEqual(f.removed, [{ line: 3, text: 'const c = 3;', hunk: 0 }]);
});

test('new file has null oldPath and status added', () => {
  const { files } = parseDiff(diff(
    'diff --git a/new.js b/new.js',
    'new file mode 100644',
    'index 0000000..abc1234',
    '--- /dev/null',
    '+++ b/new.js',
    '@@ -0,0 +1,2 @@',
    '+const a = 1;',
    '+const b = 2;',
  ));
  assert.equal(files[0].oldPath, null);
  assert.equal(files[0].newPath, 'new.js');
  assert.equal(files[0].status, 'added');
  assert.deepEqual(files[0].added.map(a => a.line), [1, 2]);
});

test('deleted file has null newPath and status deleted', () => {
  const { files } = parseDiff(diff(
    'diff --git a/old.js b/old.js',
    'deleted file mode 100644',
    'index abc1234..0000000',
    '--- a/old.js',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-const x = 1;',
    '-const y = 2;',
  ));
  assert.equal(files[0].oldPath, 'old.js');
  assert.equal(files[0].newPath, null);
  assert.equal(files[0].status, 'deleted');
  assert.deepEqual(files[0].removed.map(r => r.line), [1, 2]);
  assert.equal(files[0].added.length, 0);
});

test('rename with edits keeps both paths and status renamed', () => {
  const { files } = parseDiff(diff(
    'diff --git a/old/name.test.js b/new/name.test.js',
    'similarity index 80%',
    'rename from old/name.test.js',
    'rename to new/name.test.js',
    'index 1111111..2222222 100644',
    '--- a/old/name.test.js',
    '+++ b/new/name.test.js',
    '@@ -1,2 +1,2 @@',
    ' it("works", () => {',
    '-  assert.equal(a, 1);',
    '+  assert.equal(a, 2);',
  ));
  assert.equal(files[0].status, 'renamed');
  assert.equal(files[0].oldPath, 'old/name.test.js');
  assert.equal(files[0].newPath, 'new/name.test.js');
  assert.equal(files[0].added[0].text, '  assert.equal(a, 2);');
});

test('pure rename has no hunks', () => {
  const { files } = parseDiff(diff(
    'diff --git a/a.js b/b.js',
    'similarity index 100%',
    'rename from a.js',
    'rename to b.js',
  ));
  assert.equal(files[0].status, 'renamed');
  assert.equal(files[0].oldPath, 'a.js');
  assert.equal(files[0].newPath, 'b.js');
  assert.deepEqual(files[0].hunks, []);
});

test('binary file with "Binary files differ" is flagged and has no hunks', () => {
  const { files } = parseDiff(diff(
    'diff --git a/logo.png b/logo.png',
    'index 1111111..2222222 100644',
    'Binary files a/logo.png and b/logo.png differ',
  ));
  assert.equal(files[0].binary, true);
  assert.equal(files[0].newPath, 'logo.png');
  assert.deepEqual(files[0].hunks, []);
});

test('GIT binary patch is flagged and its data lines are ignored', () => {
  const { files } = parseDiff(diff(
    'diff --git a/x.bin b/x.bin',
    'new file mode 100644',
    'index 0000000..1234567',
    'GIT binary patch',
    'literal 5',
    'HcmV?d00001',
    '',
    'literal 0',
    'HcmV?d00001',
    '',
  ));
  assert.equal(files[0].binary, true);
  assert.equal(files[0].status, 'added');
  assert.equal(files[0].added.length, 0);
});

test('CRLF line endings are stripped from headers and content', () => {
  const text = [
    'diff --git a/w.js b/w.js',
    '--- a/w.js',
    '+++ b/w.js',
    '@@ -1 +1 @@',
    '-old();',
    '+new();',
    '',
  ].join('\r\n');
  const { files } = parseDiff(text);
  assert.equal(files[0].newPath, 'w.js');
  assert.equal(files[0].removed[0].text, 'old();');
  assert.equal(files[0].added[0].text, 'new();');
});

test('quoted paths are unquoted, including octal UTF-8 and tab escapes', () => {
  const { files } = parseDiff(diff(
    'diff --git "a/caf\\303\\251 menu.txt" "b/caf\\303\\251 menu.txt"',
    '--- "a/caf\\303\\251 menu.txt"',
    '+++ "b/caf\\303\\251 menu.txt"',
    '@@ -1 +1 @@',
    '-x',
    '+y',
    'diff --git "a/tab\\there.txt" "b/tab\\there.txt"',
    'similarity index 100%',
    'rename from "tab\\there.txt"',
    'rename to "tab\\there.txt"',
  ));
  assert.equal(files[0].newPath, 'café menu.txt');
  assert.equal(files[1].newPath, 'tab\there.txt');
});

test('unquoted paths with spaces are read whole', () => {
  const { files } = parseDiff(diff(
    'diff --git a/my dir/a b.txt b/my dir/a b.txt',
    '--- a/my dir/a b.txt',
    '+++ b/my dir/a b.txt',
    '@@ -1 +1 @@',
    '-a',
    '+b',
  ));
  assert.equal(files[0].oldPath, 'my dir/a b.txt');
  assert.equal(files[0].newPath, 'my dir/a b.txt');
});

test('"\\ No newline at end of file" lines are ignored', () => {
  const { files } = parseDiff(diff(
    'diff --git a/x.js b/x.js',
    '--- a/x.js',
    '+++ b/x.js',
    '@@ -1 +1 @@',
    '-old',
    '\\ No newline at end of file',
    '+new',
    '\\ No newline at end of file',
  ));
  assert.equal(files[0].hunks[0].lines.length, 2);
  assert.equal(files[0].removed.length, 1);
  assert.equal(files[0].added.length, 1);
});

test('plain diff -u output without diff --git lines is split into files', () => {
  const { files } = parseDiff(diff(
    '--- a/one.js\t2026-01-01 00:00:00',
    '+++ b/one.js\t2026-01-02 00:00:00',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '--- a/two.test.js',
    '+++ b/two.test.js',
    '@@ -1 +1,2 @@',
    '-c',
    '+d',
    '+e',
    '--- /dev/null',
    '+++ b/three.js',
    '@@ -0,0 +1 @@',
    '+f',
  ));
  assert.equal(files.length, 3);
  assert.equal(files[0].newPath, 'one.js');
  assert.equal(files[1].newPath, 'two.test.js');
  assert.equal(files[1].added.length, 2);
  assert.equal(files[2].status, 'added');
  assert.equal(files[2].newPath, 'three.js');
});

test('removed and added lines that look like file headers stay content inside a hunk', () => {
  const { files } = parseDiff(diff(
    '--- a/q.sql',
    '+++ b/q.sql',
    '@@ -1,3 +1,3 @@',
    ' keep',
    '--- old comment',
    '+++ new content',
    ' end',
  ));
  assert.equal(files.length, 1);
  assert.equal(files[0].removed[0].text, '-- old comment');
  assert.equal(files[0].added[0].text, '++ new content');
});

test('second hunk records its index and line numbers', () => {
  const { files } = parseDiff(diff(
    'diff --git a/m.js b/m.js',
    '--- a/m.js',
    '+++ b/m.js',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '@@ -10,2 +12,3 @@',
    ' a',
    '+b2',
    ' c',
  ));
  assert.equal(files[0].hunks.length, 2);
  assert.deepEqual(files[0].added[1], { line: 13, text: 'b2', hunk: 1 });
  assert.equal(files[0].removed[0].hunk, 0);
});

test('mode-only change is a modified file with no hunks', () => {
  const { files } = parseDiff(diff(
    'diff --git a/run.sh b/run.sh',
    'old mode 100644',
    'new mode 100755',
  ));
  assert.equal(files[0].status, 'modified');
  assert.deepEqual(files[0].hunks, []);
});

test('truncation stops parsing at maxLines and reports it', () => {
  const text = diff(
    'diff --git a/a.js b/a.js',
    '--- a/a.js',
    '+++ b/a.js',
    '@@ -1 +1,2 @@',
    '-a',
    '+b',
    '+c',
    'diff --git a/b.js b/b.js',
    '--- a/b.js',
    '+++ b/b.js',
    '@@ -1 +1 @@',
    '-x',
    '+y',
  );
  const cut = parseDiff(text, { maxLines: 6 });
  assert.equal(cut.truncated, true);
  assert.equal(cut.files.length, 1);
  assert.equal(cut.files[0].added.length, 1);

  const exact = parseDiff(text, { maxLines: 14 });
  assert.equal(exact.truncated, false);
  assert.equal(exact.files.length, 2);
});

test('empty input gives no files and not truncated', () => {
  assert.deepEqual(parseDiff(''), { files: [], truncated: false });
  assert.deepEqual(parseDiff('\n'), { files: [], truncated: false });
});
