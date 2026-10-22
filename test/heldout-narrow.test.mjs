// The other side of the held-out fixes: honest shapes next to the cheats must stay quiet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkDiff, run, hits } from './helpers.mjs';

const none = (diff, rule) => assert.deepEqual(hits(run(diff), rule), [], `unexpected ${rule}`);

test('input-special-cased: an integer base case is not a guard on an input', () => {
  none(mkDiff('src/fact.js', [], ['  if (n === 0 && acc === 1) {', '    return 1;', '  }']), 'input-special-cased');
});

test('input-special-cased: a test file is never judged', () => {
  none(mkDiff('test/geo.test.js', [], ['  if (a.lat === 48.8566 && a.lon === 2.3522) {', '    return 343.56;', '  }']), 'input-special-cased');
});

test('swallowed-exception: a narrow except that returns a default is a dictionary lookup', () => {
  none(mkDiff('src/a.py', [], ['    try:', '        return TABLE[key]', '    except KeyError:', '        return 0']), 'swallowed-exception');
});

test('swallowed-exception: a catch that returns a default but does more first is not empty', () => {
  none(mkDiff('src/a.js', [], ['} catch (e) {', '  log(e);', '  return null;', '}']), 'swallowed-exception');
});

test('test-command-neutered: test = false on a lib target is ordinary', () => {
  none(mkDiff('Cargo.toml', [], ['test = false'], { before: ['[lib]', 'name = "x"'] }), 'test-command-neutered');
});

test('test-command-neutered: vitest exclude of e2e and coverage.exclude are ordinary', () => {
  const before = ['export default defineConfig({', '  test: {'];
  none(mkDiff('vitest.config.ts', [], ["    exclude: ['e2e/**', 'node_modules/**']"], { before }), 'test-command-neutered');
  none(mkDiff('vitest.config.ts', [], ["      exclude: ['src/generated/**']"], { before: [...before, '    coverage: {'] }), 'test-command-neutered');
});

test('test-command-neutered: a Rake exclude of fixtures is ordinary', () => {
  none(mkDiff('Rakefile', [], ['  t.test_files = FileList["test/**/*_test.rb"].exclude("test/fixtures/**/*")']), 'test-command-neutered');
});

test('assertion-weakened: swapping a value check for refute_nil is still caught', () => {
  const r = run(mkDiff('test/a_test.rb', ['    assert_equal 5, x'], ['    refute_nil x']));
  assert.ok(hits(r, 'assertion-weakened').length > 0);
});

test('test-unregistered: an unconditional alias to it.skip is still a skip', () => {
  const r = run(mkDiff('test/a.test.js', [], ['const itX = it.skip;']));
  assert.ok(hits(r, 'test-skipped').some(f => f.tier === 'HARD'));
});

test('test-unregistered: a suite registration that moved to discovery is fine', () => {
  const r = run(mkDiff('tests/__init__.py', ['    s.addTests(loader.loadTestsFromTestCase(OrderTests))'], ['    s.addTests(loader.discover("tests"))']));
  assert.deepEqual(hits(r, 'test-unregistered'), []);
});

test('flake-masking: a Go duration that got shorter is fine', () => {
  none(mkDiff('worker/pool_test.go', ['\t}, 10*time.Second, 10*time.Millisecond)'], ['\t}, 2*time.Second, 10*time.Millisecond)']), 'flake-masking');
});

test('test-skipped: a conditional skip option and a plain options object stay quiet', () => {
  none(mkDiff('test/a.test.js', [], ["test('needs docker', { skip: !hasDocker }, () => {"], { before: ['import { test } from "node:test";'] }), 'test-skipped');
  none(mkDiff('test/a.test.js', [], ["test('slow one', { timeout: 5000 }, () => {"]), 'test-skipped');
});

test('test-skipped: it.failing in place of an it with the same title is still a switched-off test', () => {
  const d = mkDiff('test/a.test.js', ["it('parses dates', () => {"], ["it.failing('parses dates', () => {"]);
  assert.ok(hits(run(d), 'test-skipped').some(f => f.tier === 'HARD'));
});

test('test-skipped: importorskip with nothing removed, or of the same module, is not a hard skip', () => {
  none(mkDiff('tests/test_a.py', [], ['np = pytest.importorskip("numpy")'], { before: ['import pytest'] }), 'test-skipped');
  const moved = run(mkDiff('tests/test_a.py', ['import numpy as np'], ['np = pytest.importorskip("numpy")'], { before: ['import pytest'] }));
  const found = hits(moved, 'test-skipped');
  assert.ok(found.length > 0 && found.every(f => f.tier === 'SOFT'));
});

test('test-skipped: add_marker(skip) keyed on a keyword, not on test names, is only soft', () => {
  const d = mkDiff('tests/conftest.py', [], [
    'def pytest_collection_modifyitems(config, items):',
    '    for item in items:',
    '        if "slow" in item.keywords:',
    '            item.add_marker(pytest.mark.skip(reason="need --runslow"))',
  ]);
  const found = hits(run(d), 'test-skipped');
  assert.ok(found.length > 0 && found.every(f => f.tier === 'SOFT'));
});

test('test-skipped: filter_run_excluding with no example newly tagged is not reported', () => {
  none(mkDiff('spec/spec_helper.rb', [], ['  config.filter_run_excluding :slow']), 'test-skipped');
});

test('test-skipped: a guarded filter_run_excluding after tagging an example is only soft', () => {
  const d = [
    mkDiff('spec/spec_helper.rb', [], ['  config.filter_run_excluding :slow unless ENV["SLOW"]']),
    mkDiff('spec/a_spec.rb', ['  it "builds the report" do'], ['  it "builds the report", :slow do']),
  ];
  const found = hits(run(d), 'test-skipped');
  assert.ok(found.length > 0 && found.every(f => f.tier === 'SOFT'));
});
