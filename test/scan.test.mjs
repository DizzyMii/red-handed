import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scan, normalizeConfig } from '../src/scan.mjs';
import { mkDiff, mkSource, run, hits } from './helpers.mjs';

const SKIP_LINE = "it.skip('applies the discount', () => {})";

test('verdict: any HARD finding is CAUGHT', () => {
  const r = run(mkDiff('test/a.test.js', [], [SKIP_LINE]));
  assert.equal(r.verdict, 'CAUGHT');
});

test('verdict: SOFT findings alone are SUSPICIOUS', () => {
  const r = run(mkDiff('src/a.js', [], ['// TODO handle the empty cart']));
  assert.equal(r.verdict, 'SUSPICIOUS');
  assert.ok(r.findings.every(f => f.tier === 'SOFT'));
});

test('verdict: no findings is CLEAN', () => {
  const r = run(mkDiff('src/a.js', ['const a = 1;'], ['const a = 2;']));
  assert.equal(r.verdict, 'CLEAN');
  assert.deepEqual(r.findings, []);
});

test('an empty diff is CLEAN with a note', () => {
  const r = run('');
  assert.equal(r.verdict, 'CLEAN');
  assert.deepEqual(r.notes, ['no changes to scan']);
  assert.equal(r.stats.files, 0);
});

test('a binary-only diff is CLEAN with normal stats', () => {
  const d = 'diff --git a/test/logo.png b/test/logo.png\nindex 1..2 100644\nBinary files a/test/logo.png and b/test/logo.png differ\n';
  const r = run(d);
  assert.equal(r.verdict, 'CLEAN');
  assert.equal(r.stats.files, 1);
  assert.equal(r.stats.testFiles, 1);
});

test('a deleted binary test file still counts as test-deleted', () => {
  const d = 'diff --git a/test/logo.png b/test/logo.png\ndeleted file mode 100644\nindex 1..0\nBinary files a/test/logo.png and /dev/null differ\n';
  assert.equal(hits(run(d), 'test-deleted').length, 1);
});

test('JSON schema: result, source, stats and finding keys', () => {
  const r = run(mkDiff('test/a.test.js', ['expect(a()).toBe(1)'], ['expect(a()).toBe(2)', SKIP_LINE]));
  assert.deepEqual(Object.keys(r), ['schema', 'verdict', 'source', 'stats', 'notes', 'findings']);
  assert.equal(r.schema, 'red-handed/1');
  assert.deepEqual(Object.keys(r.source), ['kind', 'label', 'base', 'url', 'title', 'author', 'authorIsBot']);
  assert.deepEqual(Object.keys(r.stats), ['files', 'testFiles', 'assertionsAdded', 'assertionsRemoved', 'allowed', 'truncated']);
  assert.deepEqual(Object.keys(r.findings[0]), ['rule', 'tier', 'file', 'line', 'before', 'after', 'message']);
  assert.equal(JSON.parse(JSON.stringify(r)).schema, 'red-handed/1');
});

test('stats count test files and assertion lines in test files only', () => {
  const d = mkDiff('test/a.test.js', ['expect(a()).toBe(1)', '// expect(b())'], ['expect(a()).toBe(2)', 'expect(c()).toBe(3)'])
    + mkDiff('src/a.js', ['expect(x)'], ['expect(y)']);
  const r = run(d);
  assert.equal(r.stats.files, 2);
  assert.equal(r.stats.testFiles, 1);
  assert.equal(r.stats.assertionsAdded, 2);
  assert.equal(r.stats.assertionsRemoved, 1);
  assert.equal(r.stats.truncated, false);
});

test('findings are sorted HARD first, then by file, then by line', () => {
  const d = mkDiff('src/b.js', [], ['// TODO later'])
    + mkDiff('test/z.test.js', [], ["it.only('z', () => {})"])
    + mkDiff('test/a.test.js', [], ['', '', '', '', "it.only('late', () => {})", "it.only('later', () => {})"])
    + mkDiff('test/a.test.js', [], []);
  const r = run(d);
  assert.deepEqual(r.findings.map(f => [f.tier, f.file, f.line]), [
    ['HARD', 'test/a.test.js', 5],
    ['HARD', 'test/a.test.js', 6],
    ['HARD', 'test/z.test.js', 1],
    ['SOFT', 'src/b.js', 1],
  ]);
});

test('findings that share rule, file and line are reported once', () => {
  // Both the runner-word check and the build-config check hit this one line.
  const r = run(mkDiff('pytest.ini', [], ['addopts = --deselect tests/test_a.py']));
  assert.equal(hits(r, 'test-command-neutered').length, 1);
});

test('before and after are trimmed and cut to 120 characters', () => {
  const long = "it.skip('" + 'x'.repeat(200) + "', () => {})";
  const [f] = hits(run(mkDiff('test/a.test.js', [], ['    ' + long])), 'test-skipped');
  assert.equal(f.after.length, 120);
  assert.ok(f.after.endsWith('…'));
  assert.ok(f.after.startsWith("it.skip('"));
});

// ---- config --------------------------------------------------------------------------------

const localSource = (diffText, configText, extra = {}) => mkSource(diffText, {
  kind: 'local', baseFile: (p) => (p === '.red-handed.json' ? configText : null), ...extra,
});

test('ignore globs drop files before every rule', () => {
  const d = mkDiff('test/legacy/a.test.js', [], [SKIP_LINE]) + mkDiff('test/b.test.js', [], [SKIP_LINE]);
  const r = run(d, { ignore: ['test/legacy/**'] });
  assert.deepEqual(r.findings.map(f => f.file), ['test/b.test.js']);
  assert.equal(r.stats.files, 1);
});

test('node_modules, vendor, dist and build paths are skipped by default', () => {
  const d = ['node_modules/x/a.test.js', 'vendor/a.test.js', 'dist/a.test.js', 'build/a.test.js']
    .map(p => mkDiff(p, [], [SKIP_LINE])).join('');
  const r = run(d);
  assert.equal(r.verdict, 'CLEAN');
  assert.equal(r.stats.files, 0);
});

test('config tests globs make extra paths test paths', () => {
  const d = mkDiff('e2e/login.js', [], ["it.only('x', () => {})"]);
  assert.equal(hits(run(d), 'test-focused').length, 0);
  assert.equal(hits(run(d, { tests: ['e2e/**'] }), 'test-focused').length, 1);
});

test('allow entries suppress a matching rule and path and are counted', () => {
  const d = mkDiff('test/legacy/a.test.js', [], [SKIP_LINE]) + mkDiff('test/b.test.js', [], [SKIP_LINE]);
  const r = run(d, { allow: [{ rule: 'test-skipped', path: 'test/legacy/**', reason: 'ported later' }] });
  assert.deepEqual(r.findings.map(f => f.file), ['test/b.test.js']);
  assert.equal(r.stats.allowed, 1);
});

test('an allow entry for a different rule suppresses nothing', () => {
  const r = run(mkDiff('test/b.test.js', [], [SKIP_LINE]), { allow: [{ rule: 'test-focused', path: '**' }] });
  assert.equal(r.findings.length, 1);
  assert.equal(r.stats.allowed, 0);
});

test('the allow list comes from the base side of a local source', () => {
  const base = JSON.stringify({ allow: [{ rule: 'test-skipped', path: 'test/**', reason: 'flaky on CI' }] });
  const r = scan(localSource(mkDiff('test/a.test.js', [], [SKIP_LINE]), base));
  assert.equal(r.verdict, 'CLEAN');
  assert.equal(r.stats.allowed, 1);
});

test('an allow entry added by the diff itself does not suppress and raises allowlist-edited', () => {
  const added = JSON.stringify({ allow: [{ rule: 'test-skipped', path: 'test/**', reason: 'trust me' }] });
  const d = mkDiff('test/a.test.js', [], [SKIP_LINE]) + mkDiff('.red-handed.json', [], [added], { status: 'added' });
  const r = scan(localSource(d, null));
  assert.equal(hits(r, 'test-skipped').length, 1);
  assert.equal(hits(r, 'allowlist-edited').length, 1);
  assert.equal(r.stats.allowed, 0);
  assert.equal(r.verdict, 'CAUGHT');
});

test('invalid config JSON gives a note and scanning continues with defaults', () => {
  const r = scan(localSource(mkDiff('test/a.test.js', [], [SKIP_LINE]), '{ nope'));
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /^ignoring \.red-handed\.json: /);
  assert.equal(r.verdict, 'CAUGHT');
});

test('config is not read in pr, file and stdin mode', () => {
  for (const kind of ['pr', 'file', 'stdin']) {
    const src = mkSource(mkDiff('src/a.js', ['a'], ['b']), {
      kind, baseFile: () => JSON.stringify({ ignore: ['**'] }),
    });
    const r = scan(src);
    assert.deepEqual(r.notes, [`config not read in ${kind} mode`]);
    assert.equal(r.stats.files, 1);
  }
});

test('unknown config keys and malformed entries are ignored', () => {
  const c = normalizeConfig({ tests: ['a', 3], ignore: 'x', allow: [{ rule: 'r' }, { rule: 'r', path: 'p' }], extra: 1 });
  assert.deepEqual(c, { tests: ['a'], ignore: [], allow: [{ rule: 'r', path: 'p' }] });
});

// ---- untracked files -----------------------------------------------------------------------

test('untracked files become added records and the rules see them', () => {
  const src = mkSource('', {
    kind: 'local',
    untracked: [{ path: 'test/new.test.js', text: "describe('x', () => {\r\n  it.only('y', () => {})\r\n})\r\n" }],
  });
  const r = scan(src, {});
  const [f] = hits(r, 'test-focused');
  assert.equal(f.file, 'test/new.test.js');
  assert.equal(f.line, 2);
  assert.equal(f.after, "it.only('y', () => {})");
  assert.equal(r.stats.files, 1);
  assert.equal(r.stats.testFiles, 1);
  assert.deepEqual(r.notes, []);
});

test('assertions in an untracked file count as moved from a tracked one', () => {
  const src = mkSource(mkDiff('test/a.test.js', ['expect(a()).toBe(1)'], []), {
    kind: 'local',
    untracked: [{ path: 'test/b.test.js', text: 'expect(a()).toBe(1)\n' }],
  });
  assert.equal(hits(scan(src, {}), 'assertion-removed').length, 0);
});

test('an untracked file that is also in the diff is only scanned once', () => {
  const src = mkSource(mkDiff('test/a.test.js', [], [SKIP_LINE], { status: 'added' }), {
    kind: 'local', untracked: [{ path: 'test/a.test.js', text: SKIP_LINE + '\n' }],
  });
  assert.equal(scan(src, {}).stats.files, 1);
});

test('an empty untracked file is a file with no findings', () => {
  const r = scan(mkSource('', { kind: 'local', untracked: [{ path: 'src/empty.js', text: '' }] }), {});
  assert.equal(r.stats.files, 1);
  assert.equal(r.verdict, 'CLEAN');
});

// ---- truncation ----------------------------------------------------------------------------

test('a diff past the line limit is parsed in part and reported as truncated', () => {
  const body = Array.from({ length: 300100 }, (_, i) => `line ${i}`);
  const r = run(mkDiff('src/big.js', [], body, { status: 'added' }));
  assert.equal(r.stats.truncated, true);
  assert.equal(hits(r, 'diff-truncated').length, 1);
  assert.equal(r.verdict, 'SUSPICIOUS');
});
