import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, clip } from '../src/rules.mjs';
import { mkDiff, run, hits } from './helpers.mjs';

const found = (diff, rule, config) => hits(run(diff, config), rule);
const pos = (diff, rule, config) => assert.ok(found(diff, rule, config).length > 0, `expected ${rule}`);
const neg = (diff, rule, config) => assert.deepEqual(found(diff, rule, config), [], `unexpected ${rule}`);

const IDS = [
  'test-deleted', 'test-skipped', 'test-focused', 'assertion-removed', 'assertion-weakened', 'tautology-added',
  'test-detection', 'test-command-neutered', 'allowlist-edited', 'diff-hidden', 'test-unregistered', 'unit-mocked',
  'stubbed-call-asserted', 'assertion-swallowed', 'test-case-removed', 'expectation-edited', 'snapshot-rewritten',
  'suppression-added', 'swallowed-exception', 'stub-added', 'input-special-cased', 'ci-failure-ignored',
  'flake-masking', 'todo-added', 'diff-truncated',
];

test('RULES lists all 25 rules in spec order with tiers, titles and a fixed why', () => {
  assert.deepEqual(RULES.map(r => r.id), IDS);
  assert.equal(RULES.filter(r => r.tier === 'HARD').length, 14);
  assert.equal(RULES.filter(r => r.tier === 'SOFT').length, 11);
  for (const r of RULES) {
    assert.equal(typeof r.title, 'string');
    assert.ok(r.title.length > 0);
    assert.ok(r.why.endsWith('.'), r.id);
    assert.equal(typeof r.check, 'function');
  }
});

test('clip trims and cuts long lines to 120 characters', () => {
  assert.equal(clip('  hi  '), 'hi');
  assert.equal(clip(null), null);
  const long = clip('x'.repeat(300));
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('…'));
});

// ---- 1 test-deleted ------------------------------------------------------------------------

test('test-deleted: a deleted test file is flagged with the old path as before', () => {
  const r = run(mkDiff('test/cart.test.js', ["it('a', () => {})"], [], { status: 'deleted' }));
  const [f] = hits(r, 'test-deleted');
  assert.equal(f.tier, 'HARD');
  assert.equal(f.file, 'test/cart.test.js');
  assert.equal(f.line, 0);
  assert.equal(f.before, 'test/cart.test.js');
  assert.equal(f.message, 'A test file was deleted, so whatever it checked is no longer checked.');
});

test('test-deleted: a test renamed to a non-test path is flagged', () => {
  pos(mkDiff('src/cart.js', [], [], { status: 'renamed', oldPath: 'test/cart.test.js' }), 'test-deleted');
});

test('test-deleted: renaming a test file to another test path is a refactor', () => {
  neg(mkDiff('tests/unit/cart.test.js', [], [], { status: 'renamed', oldPath: 'test/cart.test.js' }), 'test-deleted');
});

test('test-deleted: deleting a source file or a snapshot is not this rule', () => {
  neg(mkDiff('src/cart.js', ['x'], [], { status: 'deleted' }), 'test-deleted');
  neg(mkDiff('test/__snapshots__/cart.test.js.snap', ['x'], [], { status: 'deleted' }), 'test-deleted');
});

// ---- 2 test-skipped ------------------------------------------------------------------------

test('test-skipped: each language is caught in a test path', () => {
  const cases = [
    ['test/a.test.js', "it.skip('x', () => {})"],
    ['test/a.test.js', "xdescribe('x', () => {})"],
    ['test/a.test.js', "test.todo('x')"],
    ['tests/test_a.py', '@pytest.mark.skip(reason="no")'],
    ['tests/test_a.py', '    self.skipTest("later")'],
    ['src/test/java/FooTest.java', '    @Disabled'],
    ['pkg/a_test.go', '\tt.Skip("later")'],
    ['Shop.Tests/CartTests.cs', '[Fact(Skip = "later")]'],
    ['spec/a_spec.rb', '  skip "later"'],
    ['spec/a_spec.rb', "  xit 'does x' do"],
  ];
  for (const [p, line] of cases) pos(mkDiff(p, [], [line]), 'test-skipped');
});

test('test-skipped: rust #[ignore] counts in any .rs file', () => {
  pos(mkDiff('src/lib.rs', [], ['#[ignore]']), 'test-skipped');
});

test('test-skipped: a comment line mentioning it.skip( is ignored', () => {
  neg(mkDiff('test/a.test.js', [], ["// it.skip('x', () => {}) was here"]), 'test-skipped');
  neg(mkDiff('tests/test_a.py', [], ['# @pytest.mark.skip']), 'test-skipped');
});

test('test-skipped: skip syntax in a non-test source file is not flagged', () => {
  neg(mkDiff('src/runner.js', [], ["it.skip('x', () => {})"]), 'test-skipped');
});

test('test-skipped: a language pattern does not leak into another language', () => {
  neg(mkDiff('pkg/a_test.go', [], ["it.skip('x')"]), 'test-skipped');
});

// ---- 3 test-focused ------------------------------------------------------------------------

test('test-focused: it.only, fdescribe and pytest only are caught in tests', () => {
  pos(mkDiff('test/a.test.js', [], ["it.only('x', () => {})"]), 'test-focused');
  pos(mkDiff('test/a.test.js', [], ["fdescribe('x', () => {})"]), 'test-focused');
  pos(mkDiff('tests/test_a.py', [], ['@pytest.mark.only']), 'test-focused');
});

test('test-focused: .only in a non-test file is not flagged', () => {
  neg(mkDiff('src/query.js', [], ["return rows.only('first')"]), 'test-focused');
  neg(mkDiff('src/query.js', [], ["it.only('x', () => {})"]), 'test-focused');
});

test('test-focused: a comment mentioning it.only( is ignored', () => {
  neg(mkDiff('test/a.test.js', [], ["// never commit it.only('x')"]), 'test-focused');
});

// ---- 4 assertion-removed -------------------------------------------------------------------

test('assertion-removed: removing more assertions than are added flags each removed line', () => {
  const r = run(mkDiff('test/cart.test.js', [
    'expect(total([])).toBe(0)', 'expect(total([1])).toBe(1)',
  ], ['expect(total([1])).toBe(1)'.replace('1', '2')], {}));
  const fs = hits(r, 'assertion-removed');
  assert.equal(fs.length, 2);
  assert.equal(fs[0].before, 'expect(total([])).toBe(0)');
  assert.equal(fs[0].after, null);
});

test('assertion-removed: caps at 10 findings per file', () => {
  const removed = Array.from({ length: 12 }, (_, i) => `expect(f(${i})).toBe(${i})`);
  assert.equal(found(mkDiff('test/a.test.js', removed, []), 'assertion-removed').length, 10);
});

test('assertion-removed: an assertion moved to another test file is fine', () => {
  const d = mkDiff('test/a.test.js', ['expect(a()).toBe(1)'], [])
    + mkDiff('test/b.test.js', [], ['  expect(a()).toBe(1)']);
  neg(d, 'assertion-removed');
});

test('assertion-removed: an assertion moved within the same file is fine', () => {
  neg(mkDiff('test/a.test.js', ['expect(a()).toBe(1)'], ['  expect(a()).toBe(1)']), 'assertion-removed');
});

test('assertion-removed: a test file that only gains assertions is fine', () => {
  neg(mkDiff('test/a.test.js', [], ['expect(a()).toBe(1)', 'expect(b()).toBe(2)']), 'assertion-removed');
});

test('assertion-removed: removed comments and non-test files are ignored; deleted files are rule 1 only', () => {
  neg(mkDiff('test/a.test.js', ['// expect(a()).toBe(1)'], []), 'assertion-removed');
  neg(mkDiff('src/a.js', ['expect(a()).toBe(1)'], []), 'assertion-removed');
  neg(mkDiff('test/a.test.js', ['expect(a()).toBe(1)'], [], { status: 'deleted' }), 'assertion-removed');
});

test('assertion-removed: a renamed file is judged when either path is a test path', () => {
  pos(mkDiff('src/a.js', ['expect(a()).toBe(1)'], [], { status: 'renamed', oldPath: 'test/a.test.js' }), 'assertion-removed');
});

// ---- 5 assertion-weakened ------------------------------------------------------------------

test('assertion-weakened: toEqual swapped for toBeDefined', () => {
  const [f] = found(mkDiff('test/a.test.js', ['expect(x).toEqual({ a: 1 })'], ['expect(x).toBeDefined()']), 'assertion-weakened');
  assert.equal(f.before, 'expect(x).toEqual({ a: 1 })');
  assert.equal(f.after, 'expect(x).toBeDefined()');
  assert.equal(f.line, 1);
});

test('assertion-weakened: python equality swapped for bare truthiness', () => {
  pos(mkDiff('tests/test_a.py', ['    assert x == 5'], ['    assert x']), 'assertion-weakened');
  pos(mkDiff('tests/test_a.py', ['    assert x == 5'], ['    assert x is not None']), 'assertion-weakened');
});

test("assertion-weakened: node assert.deepEqual swapped for assert.ok", () => {
  pos(mkDiff('test/a.test.js', ['  assert.deepEqual(x, { a: 1 })'], ['  assert.ok(x)']), 'assertion-weakened');
});

test('assertion-weakened: a strong assertion replaced by another strong one is not weakened', () => {
  neg(mkDiff('test/a.test.js', ['expect(x).toBe(1)'], ['expect(x).toBe(2)']), 'assertion-weakened');
});

test('assertion-weakened: adding a weak assertion next to a kept strong one is fine', () => {
  neg(mkDiff('test/a.test.js', ['expect(x).toBe(1)'], ['expect(x).toBe(1)', 'expect(y).toBeDefined()']), 'assertion-weakened');
});

test('assertion-weakened: the same swap in a non-test file is not flagged', () => {
  neg(mkDiff('src/a.js', ['expect(x).toEqual(1)'], ['expect(x).toBeDefined()']), 'assertion-weakened');
});

// ---- 6 tautology-added ---------------------------------------------------------------------

test('tautology-added: assertions that cannot fail are caught', () => {
  const lines = [
    'expect(true).toBe(true)', "expect('a').toEqual('a')", 'assert True', '    assert 1 == 1',
    'self.assertTrue(True)', 'assert(true)', 'assert.equal(1, 1)', 'assert.strictEqual(true, true)',
    'assert.ok(true)', 'assert!(true);',
  ];
  for (const l of lines) pos(mkDiff('test/a.test.js', [], [l]), 'tautology-added');
});

test('tautology-added: a real assertion is not a tautology', () => {
  neg(mkDiff('test/a.test.js', [], ['expect(result).toBe(true)', 'assert.equal(total, 1)', 'expect(1).toBe(2)']), 'tautology-added');
});

test('tautology-added: only test paths count, and comments do not', () => {
  neg(mkDiff('src/a.js', [], ['expect(true).toBe(true)']), 'tautology-added');
  neg(mkDiff('test/a.test.js', [], ['// expect(true).toBe(true)']), 'tautology-added');
});

// ---- 7 test-detection ----------------------------------------------------------------------

test('test-detection: source code that asks whether it is under test', () => {
  pos(mkDiff('src/cart.js', [], ["if (process.env.NODE_ENV === 'test') return 90;"]), 'test-detection');
  pos(mkDiff('src/cart.py', [], ["if 'pytest' in sys.modules:"]), 'test-detection');
  pos(mkDiff('src/cart.js', [], ['const w = process.env.JEST_WORKER_ID']), 'test-detection');
  pos(mkDiff('app/app.rb', [], ['return 90 if Rails.env.test?']), 'test-detection');
});

test("test-detection: NODE_ENV === 'production' is fine", () => {
  neg(mkDiff('src/cart.js', [], ["if (process.env.NODE_ENV === 'production') return 90;"]), 'test-detection');
});

test('test-detection: test files, test infrastructure, comments and CI are exempt', () => {
  const line = ["if (process.env.NODE_ENV === 'test') setup();"];
  neg(mkDiff('test/helper.js', [], line), 'test-detection');
  neg(mkDiff('src/test-utils/boot.js', [], line), 'test-detection');
  neg(mkDiff('jest.setup.js', [], line), 'test-detection');
  neg(mkDiff('src/cart.js', [], ["// if (process.env.NODE_ENV === 'test')"]), 'test-detection');
  neg(mkDiff('jest.config.js', [], line), 'test-detection');
});

// ---- 8 test-command-neutered ---------------------------------------------------------------

test('test-command-neutered (a): runner word plus a way to hide failure in a build file', () => {
  pos(mkDiff('package.json', ['  "test": "jest"'], ['  "test": "jest || true"']), 'test-command-neutered');
  pos(mkDiff('package.json', [], ['  "test": "jest --passWithNoTests"']), 'test-command-neutered');
  pos(mkDiff('Makefile', [], ['\tpytest tests || true']), 'test-command-neutered');
  pos(mkDiff('.github/workflows/ci.yml', [], ['        run: npm test || exit 0']), 'test-command-neutered');
  pos(mkDiff('pom.xml', [], ['mvn test -DskipTests']), 'test-command-neutered');
});

test('test-command-neutered (b): the test script is deleted or emptied', () => {
  pos(mkDiff('package.json', ['    "test": "jest",', '    "lint": "eslint ."'], ['    "lint": "eslint ."']), 'test-command-neutered');
  pos(mkDiff('package.json', ['    "test": "jest"'], ['    "test": "echo ok"']), 'test-command-neutered');
  pos(mkDiff('package.json', ['    "test": "jest"'], ['    "test": ""']), 'test-command-neutered');
  pos(mkDiff('package.json', ['    "test": "jest"'], ['    "test": "exit 0"']), 'test-command-neutered');
});

test('test-command-neutered (c): continue-on-error next to a test step is HARD', () => {
  const d = mkDiff('.github/workflows/ci.yml', [], ['        continue-on-error: true'], {
    before: ['      - name: Run tests', '        run: npm run build-and-check'],
  });
  const r = run(d);
  assert.equal(hits(r, 'test-command-neutered').length, 1);
  assert.equal(hits(r, 'ci-failure-ignored').length, 0);
});

test('test-command-neutered (d): test paths and failures ignored in build config', () => {
  pos(mkDiff('jest.config.js', [], ["  testPathIgnorePatterns: ['/src/legacy/'],"]), 'test-command-neutered');
  pos(mkDiff('build.gradle', [], ['    ignoreFailures = true']), 'test-command-neutered');
  pos(mkDiff('pytest.ini', [], ['addopts = --ignore=tests/slow']), 'test-command-neutered');
  pos(mkDiff('pom.xml', [], ['<skipTests>true</skipTests>']), 'test-command-neutered');
});

test('test-command-neutered: changing the runner or keeping a real script is fine', () => {
  neg(mkDiff('package.json', ['    "test": "jest"'], ['    "test": "vitest run"']), 'test-command-neutered');
  neg(mkDiff('package.json', [], ['    "test": "echo \\"building\\" && jest"']), 'test-command-neutered');
  neg(mkDiff('.github/workflows/ci.yml', [], ['        run: npm test']), 'test-command-neutered');
  neg(mkDiff('Makefile', [], ['# pytest tests || true']), 'test-command-neutered');
  neg(mkDiff('src/a.js', [], ['jest || true']), 'test-command-neutered');
});

test('test-command-neutered: continue-on-error on a lint step is SOFT, not HARD', () => {
  const d = mkDiff('.github/workflows/ci.yml', [], ['        continue-on-error: true'], {
    before: ['      - name: Lint', '        run: npm run lint'],
  });
  const r = run(d);
  assert.equal(hits(r, 'test-command-neutered').length, 0);
  const [f] = hits(r, 'ci-failure-ignored');
  assert.equal(f.tier, 'SOFT');
  assert.equal(r.verdict, 'SUSPICIOUS');
});

// ---- 9 allowlist-edited --------------------------------------------------------------------

test('allowlist-edited: any change to .red-handed.json', () => {
  const [f] = found(mkDiff('.red-handed.json', [], ['{"allow":[]}'], { status: 'added' }), 'allowlist-edited');
  assert.equal(f.tier, 'HARD');
  assert.equal(f.file, '.red-handed.json');
  assert.equal(f.line, 0);
  pos(mkDiff('.red-handed.json', ['{}'], [], { status: 'deleted' }), 'allowlist-edited');
});

test('allowlist-edited: other json files are not the allow list', () => {
  neg(mkDiff('config/red-handed.json', [], ['{}']), 'allowlist-edited');
  neg(mkDiff('package.json', [], ['{}']), 'allowlist-edited');
});

// ---- 10 diff-hidden ------------------------------------------------------------------------

test('diff-hidden: .gitattributes hiding tests or code from diffs', () => {
  pos(mkDiff('.gitattributes', [], ['test/** -diff']), 'diff-hidden');
  pos(mkDiff('.gitattributes', [], ['*.test.js linguist-generated=true']), 'diff-hidden');
  pos(mkDiff('.gitattributes', [], ['* binary']), 'diff-hidden');
  pos(mkDiff('.gitattributes', [], ['src/cart.js -diff']), 'diff-hidden');
});

test('diff-hidden: attributes on assets, lockfiles and plain eol settings are fine', () => {
  neg(mkDiff('.gitattributes', [], ['*.png binary']), 'diff-hidden');
  neg(mkDiff('.gitattributes', [], ['package-lock.json -diff linguist-generated']), 'diff-hidden');
  neg(mkDiff('.gitattributes', [], ['*.js text eol=lf']), 'diff-hidden');
  neg(mkDiff('.gitattributes', [], ['# test/** -diff']), 'diff-hidden');
  neg(mkDiff('docs/notes.md', [], ['test/** -diff']), 'diff-hidden');
});

// ---- 11 expectation-edited -----------------------------------------------------------------

test('expectation-edited: same assertion, different literal', () => {
  const [f] = found(mkDiff('test/cart.test.js', ['expect(total(cart)).toBe(90)'], ['expect(total(cart)).toBe(100)']), 'expectation-edited');
  assert.equal(f.tier, 'SOFT');
  assert.equal(f.before, 'expect(total(cart)).toBe(90)');
  assert.equal(f.after, 'expect(total(cart)).toBe(100)');
  assert.match(f.message, /expected value in an assertion changed/);
  pos(mkDiff('test/cart.test.js', ["assert.equal(name, 'a')"], ["assert.equal(name, 'b')"]), 'expectation-edited');
});

test('expectation-edited: identical text, a different matcher or a non-test file is not flagged', () => {
  neg(mkDiff('test/a.test.js', ['expect(x).toBe(1)'], ['  expect(x).toBe(1)']), 'expectation-edited');
  neg(mkDiff('test/a.test.js', ['expect(x).toBe(1)'], ['expect(x).toEqual(1)']), 'expectation-edited');
  neg(mkDiff('src/a.js', ['expect(x).toBe(1)'], ['expect(x).toBe(2)']), 'expectation-edited');
});

// ---- 12 snapshot-rewritten -----------------------------------------------------------------

test('snapshot-rewritten: a snapshot changes together with source code', () => {
  const d = mkDiff('src/cart.js', ['a'], ['b']) + mkDiff('test/__snapshots__/cart.test.js.snap', ['old'], ['new']);
  const [f] = found(d, 'snapshot-rewritten');
  assert.equal(f.file, 'test/__snapshots__/cart.test.js.snap');
  assert.equal(f.line, 0);
  assert.equal(f.tier, 'SOFT');
});

test('snapshot-rewritten: a snapshot alone, or beside only test changes, is fine', () => {
  neg(mkDiff('test/__snapshots__/cart.test.js.snap', ['old'], ['new']), 'snapshot-rewritten');
  const d = mkDiff('test/cart.test.js', ['a'], ['b']) + mkDiff('test/__snapshots__/cart.test.js.snap', ['old'], ['new']);
  neg(d, 'snapshot-rewritten');
});

// ---- 13 suppression-added ------------------------------------------------------------------

test('suppression-added: silenced warnings in source and tests, including in comments', () => {
  pos(mkDiff('src/a.ts', [], ['// @ts-ignore']), 'suppression-added');
  pos(mkDiff('src/a.js', [], ['// eslint-disable-next-line no-unused-vars']), 'suppression-added');
  pos(mkDiff('src/a.py', [], ['import x  # noqa']), 'suppression-added');
  pos(mkDiff('src/A.java', [], ['@SuppressWarnings("unchecked")']), 'suppression-added');
  pos(mkDiff('test/a.test.ts', [], ['// @ts-expect-error']), 'suppression-added');
  pos(mkDiff('src/lib.rs', [], ['#[allow(dead_code)]']), 'suppression-added');
});

test('suppression-added: ordinary code and non-code files are fine', () => {
  neg(mkDiff('src/a.ts', [], ['const x: number = 1;']), 'suppression-added');
  neg(mkDiff('docs/lint.md', [], ['use eslint-disable sparingly']), 'suppression-added');
});

// ---- 14 swallowed-exception ----------------------------------------------------------------

test('swallowed-exception: empty catch blocks in one or several lines', () => {
  pos(mkDiff('src/a.js', [], ['  try { go(); } catch (e) {}']), 'swallowed-exception');
  pos(mkDiff('src/a.js', [], ['  } catch (e) {', '  }']), 'swallowed-exception');
  pos(mkDiff('src/a.js', [], ['  } catch (e) {', '    // ignore', '  }']), 'swallowed-exception');
});

test('swallowed-exception: python pass, promise catch and discarded go errors', () => {
  pos(mkDiff('src/a.py', [], ['    except ValueError: pass']), 'swallowed-exception');
  pos(mkDiff('src/a.py', [], ['    except Exception:', '        pass']), 'swallowed-exception');
  pos(mkDiff('src/a.js', [], ['load().catch(() => {})']), 'swallowed-exception');
  pos(mkDiff('src/a.go', [], ['\t_ = err']), 'swallowed-exception');
});

test('swallowed-exception: handlers that do something are fine', () => {
  neg(mkDiff('src/a.js', [], ['  } catch (e) {', '    log(e);', '  }']), 'swallowed-exception');
  neg(mkDiff('src/a.py', [], ['    except Exception:', '        log.error("x")']), 'swallowed-exception');
  neg(mkDiff('src/a.js', [], ['load().catch((e) => console.error(e))']), 'swallowed-exception');
  neg(mkDiff('README.md', [], ['try { x } catch (e) {}']), 'swallowed-exception');
});

// ---- 15 stub-added -------------------------------------------------------------------------

test('stub-added: not-implemented stubs in source', () => {
  pos(mkDiff('src/a.js', [], ["throw new Error('not implemented')"]), 'stub-added');
  pos(mkDiff('src/a.py', [], ['    raise NotImplementedError']), 'stub-added');
  pos(mkDiff('src/lib.rs', [], ['    todo!()']), 'stub-added');
  pos(mkDiff('src/A.java', [], ['throw new UnsupportedOperationException();']), 'stub-added');
});

test('stub-added: real errors and stubs in test files are fine', () => {
  neg(mkDiff('src/a.js', [], ["throw new Error('bad input')"]), 'stub-added');
  neg(mkDiff('test/a.test.js', [], ["throw new Error('not implemented')"]), 'stub-added');
  neg(mkDiff('src/a.js', [], ["// throw new Error('not implemented')"]), 'stub-added');
});

// ---- 16 ci-failure-ignored -----------------------------------------------------------------

test('ci-failure-ignored: continue-on-error with no test step nearby and gitlab allow_failure', () => {
  pos(mkDiff('.github/workflows/ci.yml', [], ['        continue-on-error: true'], { before: ['      - name: Lint'] }), 'ci-failure-ignored');
  pos(mkDiff('.gitlab-ci.yml', [], ['  allow_failure: true']), 'ci-failure-ignored');
});

test('ci-failure-ignored: a test step nearby makes it HARD instead, and non-CI yaml is ignored', () => {
  const near = mkDiff('.github/workflows/ci.yml', [], ['        continue-on-error: true'], { before: ['      - run: npm test'] });
  neg(near, 'ci-failure-ignored');
  neg(mkDiff('config/app.yml', [], ['continue-on-error: true']), 'ci-failure-ignored');
});

test('ci-failure-ignored: a test step that is a different step does not count as near', () => {
  const pad = Array.from({ length: 3 }, (_, i) => `        key${i}: v`);
  const d = mkDiff('.github/workflows/ci.yml', [], ['        continue-on-error: true'], { before: ['      - run: npm test', '      - name: Upload', ...pad] });
  pos(d, 'ci-failure-ignored');
  neg(d, 'test-command-neutered');
});

// ---- 17 flake-masking ----------------------------------------------------------------------

test('flake-masking: retries and long timeouts in tests and build config', () => {
  pos(mkDiff('test/a.test.js', [], ['jest.retryTimes(3)']), 'flake-masking');
  pos(mkDiff('test/a.test.js', [], ['  this.timeout(60000)']), 'flake-masking');
  pos(mkDiff('tests/test_a.py', [], ['@pytest.mark.flaky(reruns=3)']), 'flake-masking');
  pos(mkDiff('cypress.config.js', [], ['  retries: 2,']), 'flake-masking');
});

test('flake-masking: zero retries and source files are fine', () => {
  neg(mkDiff('cypress.config.js', [], ['  retries: 0,']), 'flake-masking');
  neg(mkDiff('src/net.js', [], ['  retries: 3,']), 'flake-masking');
});

// ---- 18 todo-added -------------------------------------------------------------------------

test('todo-added: markers in source files, comments included', () => {
  pos(mkDiff('src/a.js', [], ['// TODO handle the empty cart']), 'todo-added');
  pos(mkDiff('src/a.py', [], ['x = 1  # FIXME']), 'todo-added');
});

test('todo-added: test files, prose files and lowercase words are not flagged', () => {
  neg(mkDiff('test/a.test.js', [], ['// TODO later']), 'todo-added');
  neg(mkDiff('docs/plan.md', [], ['TODO write this']), 'todo-added');
  neg(mkDiff('src/a.js', [], ['const todos = []; // TODOS are listed']), 'todo-added');
});

// ---- 19 diff-truncated ---------------------------------------------------------------------

test('diff-truncated: raised when the parser stopped at its line limit', () => {
  const rule = RULES.find(r => r.id === 'diff-truncated');
  const [f] = rule.check({ truncated: true, files: [] });
  assert.equal(f.file, '');
  assert.equal(f.line, 0);
  assert.equal(f.tier, 'SOFT');
  assert.deepEqual(rule.check({ truncated: false, files: [] }), []);
});

test('diff-truncated: a clean small diff does not raise it', () => {
  neg(mkDiff('src/a.js', ['a'], ['b']), 'diff-truncated');
});

// ---- cross-rule ----------------------------------------------------------------------------

test('one line can trip two rules and both are reported', () => {
  const r = run(mkDiff('test/a.test.js', [], ["it.skip('x', () => { expect(true).toBe(true) })"]));
  assert.equal(hits(r, 'test-skipped').length, 1);
  assert.equal(hits(r, 'tautology-added').length, 1);
});

// ---- review fixes: false HARDs --------------------------------------------------------------

const CAUGHT = (d) => run(d).verdict === 'CAUGHT';
const notCaught = (d, msg) => assert.notEqual(run(d).verdict, 'CAUGHT', msg);

test('assertion-removed: table-driven rewrites in js, python, go, java and c# are not HARD', () => {
  notCaught(mkDiff('test/add.test.js', [
    "  it('adds small numbers', () => {", '    assert.equal(add(1, 2), 3);', '    assert.equal(add(2, 2), 4);', '    assert.equal(add(0, 5), 5);', '  });',
  ], [
    '  const cases = [[1, 2, 3], [2, 2, 4], [0, 5, 5]];', '  for (const [a, b, want] of cases) {', '    it(`adds ${a} and ${b}`, () => assert.equal(add(a, b), want));', '  }',
  ]), 'js');
  notCaught(mkDiff('tests/test_add.py', [
    'def test_add():', '    assert add(1, 2) == 3', '    assert add(2, 2) == 4', '    assert add(0, 5) == 5',
  ], [
    '@pytest.mark.parametrize("a,b,want", [(1, 2, 3), (2, 2, 4), (0, 5, 5)])', 'def test_add(a, b, want):', '    assert add(a, b) == want',
  ]), 'py');
  notCaught(mkDiff('add/add_test.go', [
    '\tif Add(1, 2) != 3 {', '\t\tt.Errorf("bad")', '\t}', '\tif Add(2, 2) != 4 {', '\t\tt.Errorf("bad")', '\t}',
  ], [
    '\ttests := []struct{ a, b, want int }{{1, 2, 3}, {2, 2, 4}}', '\tfor _, tt := range tests {', '\t\tif Add(tt.a, tt.b) != tt.want {', '\t\t\tt.Errorf("bad")', '\t\t}', '\t}',
  ]), 'go');
  notCaught(mkDiff('src/test/java/AddTest.java', [
    '    @Test void a() {', '        assertEquals(3, add(1, 2));', '        assertEquals(4, add(2, 2));', '    }',
  ], [
    '    @ParameterizedTest', '    @CsvSource({"1,2,3", "2,2,4"})', '    void a(int x, int y, int want) {', '        assertEquals(want, add(x, y));', '    }',
  ]), 'java');
  notCaught(mkDiff('Tests/AddTests.cs', [
    '    [Fact] public void A() {', '        Assert.Equal(3, Add(1, 2));', '        Assert.Equal(4, Add(2, 2));', '    }',
  ], [
    '    [Theory]', '    [InlineData(1, 2, 3)]', '    public void A(int a, int b, int want) {', '        Assert.Equal(want, Add(a, b));', '    }',
  ]), 'cs');
});

test('assertion-removed: dropping a plain expect is still HARD, and a table in the file only softens it', () => {
  assert.ok(CAUGHT(mkDiff('test/a.test.js', ['  expect(add(1, 2)).toBe(3);'], [])));
  const r = run(mkDiff('test/a.test.js', ['  expect(add(1, 2)).toBe(3);', '  expect(add(2, 2)).toBe(4);'], ['  for (const c of cases) run(c);']));
  assert.equal(hits(r, 'assertion-removed')[0].tier, 'SOFT');
});

test('assertion-removed: the word should in a test name is not an assertion', () => {
  notCaught(mkDiff('src/cart.test.ts', [
    "it('should total the items', () => {", "it('should apply the discount', () => {",
  ], ["it('totals the items', () => {", "it('applies the discount', () => {"]));
  assert.ok(CAUGHT(mkDiff('spec/a_spec.rb', ['  it { should eq 3 }'], [])), 'rspec one-liner');
  assert.ok(CAUGHT(mkDiff('test/a.test.js', ['  total.should.equal(3);'], [])), 'chai should');
});

test('test-command-neutered: stopping a test database or uploading coverage is not neutering', () => {
  const wf = '.github/workflows/ci.yml';
  notCaught(mkDiff(wf, [], ['      - name: Stop the test database', '        if: always()', '        run: docker rm -f test-db || true'], { before: ['      - run: npm test'] }));
  notCaught(mkDiff(wf, [], ['        continue-on-error: true'], {
    before: ['      - run: npm test -- --coverage', '      - name: Upload coverage', '        uses: codecov/codecov-action@v4'],
  }));
  assert.ok(CAUGHT(mkDiff(wf, [], ['        continue-on-error: true'], { before: ['      - name: Test', '        run: npm test'] })));
  assert.ok(CAUGHT(mkDiff(wf, [], ['        run: rake test || true'])));
});

test('assertion-weakened: comparing to a boolean literal and then asserting true is the same check', () => {
  notCaught(mkDiff('src/test/java/UserTest.java', ['        assertEquals(true, user.isActive());'], ['        assertTrue(user.isActive());']));
  notCaught(mkDiff('user/user_test.go', ['\tassert.Equal(t, true, u.Active)'], ['\tassert.True(t, u.Active)']));
  notCaught(mkDiff('Tests/UserTests.cs', ['        Assert.AreEqual(true, user.IsActive);'], ['        Assert.IsTrue(user.IsActive);']));
  notCaught(mkDiff('tests/test_user.py', ['    assert user.is_active == True'], ['    assert user.is_active']));
  assert.ok(CAUGHT(mkDiff('src/test/java/UserTest.java', ['        assertEquals(3, x);'], ['        assertTrue(x > 0);'])));
});

test('test-focused: model.fit and a focus prop are not focused tests', () => {
  notCaught(mkDiff('tests/test_model.py', [], ['    model = LinearRegression()', '    model.fit(X_train, y_train)', '    assert model.score(X_test, y_test) > 0.9']));
  notCaught(mkDiff('src/Input.test.jsx', [], ["  const props = { focus: true, label: 'Name' };"]));
  assert.ok(CAUGHT(mkDiff('test/a.test.js', [], ["fit('x', () => {})"])));
  assert.ok(CAUGHT(mkDiff('test/a.test.js', [], ["describe.only('x', () => {})"])));
  assert.ok(CAUGHT(mkDiff('spec/a_spec.rb', [], ["  it 'x', focus: true do"])));
});

test('test-skipped: a method named pending and a local called pending are not skips', () => {
  notCaught(mkDiff('test/queue.test.js', [], ['    expect(q.pending()).toBe(0);']));
  notCaught(mkDiff('spec/models/order_spec.rb', [], ['    pending = Order.where(status: :pending)', '    expect(pending.count).to eq(2)']));
  assert.ok(CAUGHT(mkDiff('test/q.test.js', [], ['  pending("later");'])));
  assert.ok(CAUGHT(mkDiff('spec/a_spec.rb', [], ['    skip'])));
  assert.ok(CAUGHT(mkDiff('spec/a_spec.rb', [], ['    pending "later"'])));
});

test('test-skipped: a skip inside a conditional or a brand-new test is softer', () => {
  const go = run(mkDiff('store/postgres_test.go', [], [
    'func TestPostgresRoundTrip(t *testing.T) {', '\tif testing.Short() {', '\t\tt.Skip("integration test, needs a database")', '\t}', '}',
  ], { status: 'added' }));
  assert.notEqual(go.verdict, 'CAUGHT');
  assert.equal(hits(go, 'test-skipped')[0].tier, 'SOFT');
  notCaught(mkDiff('tests/test_gpu.py', [], ['def test_gpu():', '    if not torch.cuda.is_available():', '        pytest.skip("needs a GPU")']), 'conditional skip');
  notCaught(mkDiff('src/price.rs', [], ['#[test]', '#[ignore = "slow"]', 'fn slow_one() {}'], { before: ['mod tests {'] }), 'new rust test');
  assert.ok(CAUGHT(mkDiff('price/price_test.go', [], ['\tt.Skip("flaky")'], { before: ['func TestDiscount(t *testing.T) {'], after: ['\tgot := Price(1)', '}'] })));
  assert.ok(CAUGHT(mkDiff('test/a.test.js', ["it('a', () => {})"], ["it.skip('a', () => {})"])));
});

test('test-command-neutered: ordinary runner config is not neutering', () => {
  notCaught(mkDiff('jest.config.js', [], ["  testPathIgnorePatterns: ['<rootDir>/.next/', '<rootDir>/node_modules/'],", "  modulePathIgnorePatterns: ['<rootDir>/dist/'],"]));
  notCaught(mkDiff('tox.ini', [], ['commands = flake8 --ignore=E203,W503 src']));
  notCaught(mkDiff('pytest.ini', [], ['norecursedirs = .git .venv node_modules build']));
  assert.ok(CAUGHT(mkDiff('jest.config.js', [], ["  testPathIgnorePatterns: ['/tests/pricing/'],"])));
  assert.ok(CAUGHT(mkDiff('pytest.ini', [], ['norecursedirs = tests build'])));
});

test('assertion-removed: asserts moved into a helper in another file are not removed', () => {
  const d = mkDiff('test/api.test.js', ['  expect(res.status).toBe(200);', "  expect(res.headers['content-type']).toMatch(/json/);"], ['  expectJsonOk(res);'])
    + mkDiff('test/helpers.js', [], ['  expect(response.status).toBe(200);', "  expect(response.headers['content-type']).toMatch(/json/);"]);
  notCaught(d);
  assert.ok(CAUGHT(mkDiff('test/api.test.js', ['  expect(res.status).toBe(200);', "  expect(res.headers['content-type']).toMatch(/json/);"], [])));
});

test('test-deleted: a deleted fixture is softer than a deleted test', () => {
  const r = run(mkDiff('tests/fixtures/legacy_user.json', ['{"id": 1}'], [], { status: 'deleted' }));
  assert.notEqual(r.verdict, 'CAUGHT');
  assert.equal(hits(r, 'test-deleted')[0].tier, 'SOFT');
  assert.ok(CAUGHT(mkDiff('test/price.test.js', ['expect(price()).toBe(1);'], [], { status: 'deleted' })));
});

test('diff-hidden: marking generated code is softer, hiding snapshots or tests is HARD', () => {
  const gen = run(mkDiff('.gitattributes', [], ['*.pb.go linguist-generated=true'], { before: ['* text=auto'] }));
  assert.notEqual(gen.verdict, 'CAUGHT');
  assert.equal(hits(gen, 'diff-hidden')[0].tier, 'SOFT');
  assert.ok(CAUGHT(mkDiff('.gitattributes', [], ['tests/** linguist-generated'])));
  assert.ok(CAUGHT(mkDiff('.gitattributes', [], ['*.snap -diff'])));
  assert.ok(CAUGHT(mkDiff('.gitattributes', [], ['*.golden linguist-generated'])));
  notCaught(mkDiff('.gitattributes', [], ['*.png binary']));
});

test('test-detection: a config module choosing a test database is softer', () => {
  const line = "const url = process.env.NODE_ENV === 'test' ? 'sqlite::memory:' : process.env.DATABASE_URL;";
  const cfg = run(mkDiff('src/config/db.js', [], [line]));
  assert.notEqual(cfg.verdict, 'CAUGHT');
  assert.equal(hits(cfg, 'test-detection')[0].tier, 'SOFT');
  assert.ok(CAUGHT(mkDiff('src/price.js', [], [line])));
});

// ---- review fixes: missed cheats ------------------------------------------------------------

test('test-unregistered: a test annotation removed or a test function renamed away is HARD', () => {
  const rules = (d) => hits(run(d), 'test-unregistered');
  assert.equal(rules(mkDiff('src/test/java/com/acme/PriceTest.java', ['    @Test'], [], { after: ['    void appliesDiscount() {', '        assertEquals(42.5, pricer.price(order), 0.001);'] })).length, 1);
  assert.equal(rules(mkDiff('src/price.rs', ['    #[test]'], [], { after: ['    fn applies_discount() {'] })).length, 1);
  assert.equal(rules(mkDiff('tests/test_price.py', ['def test_discount():'], ['def _test_discount():'])).length, 1);
  assert.equal(rules(mkDiff('price/price_test.go', ['func TestDiscount(t *testing.T) {'], ['func testDiscount(t *testing.T) {'])).length, 1);
  assert.equal(rules(mkDiff('src/test/java/AddTest.java', ['    @Test'], ['    @ParameterizedTest'])).length, 0);
  assert.equal(rules(mkDiff('Tests/AddTests.cs', ['    [Fact]'], ['    [Theory]'])).length, 0);
  assert.equal(rules(mkDiff('test/a.test.js', ["it('a', () => {})"], ["it.skip('a', () => {})"])).length, 0);
  assert.equal(rules(mkDiff('test/a.test.js', ["it('a', () => {})"], ["it('b', () => {})"])).length, 0);
  assert.equal(rules(mkDiff('test/a.test.js', ["it('a', () => {})"], [], { status: 'deleted' })).length, 0);
});

test('test-unregistered: merging two tests into one is softer than dropping one', () => {
  const r = hits(run(mkDiff('test/a.test.js', ["it('a', () => {})", "it('b', () => {})"], ["it('a and b', () => {})"])), 'test-unregistered');
  assert.equal(r[0].tier, 'SOFT');
});

test('test-command-neutered: removed or disabled CI test steps and filtered runners', () => {
  const wf = '.github/workflows/ci.yml';
  assert.ok(CAUGHT(mkDiff(wf, ['      - run: npm test'], [], { before: ['      - run: npm ci'], after: ['      - run: npm run build'] })), 'step removed');
  notCaught(mkDiff(wf, ['      - run: npm test'], ['      - run: npm run test:unit']), 'step reworded');
  notCaught(mkDiff(wf, ['      - name: Run tests'], ['      - name: Unit tests'], { after: ['        run: npm test'] }), 'name only');
  const moved = mkDiff(wf, ['      - run: npm test'], []) + mkDiff('.github/workflows/test.yml', [], ['      - run: npm test'], { status: 'added' });
  notCaught(moved, 'moved to another workflow');
  assert.ok(CAUGHT(mkDiff(wf, [], ['        if: false'], { before: ['      - name: Run tests'], after: ['        run: pytest'] })), 'if false');
  assert.ok(CAUGHT(mkDiff(wf, ['        run: go test ./...'], ['        run: go test -skip TestDiscount ./...'])), 'go skip');
  assert.ok(CAUGHT(mkDiff(wf, [], ['        run: dotnet test --filter "FullyQualifiedName!~PriceTests"'])), 'dotnet filter');
  assert.ok(CAUGHT(mkDiff('package.json', ['    "test": "jest",'], ['    "test": "node -e \\"process.exit(0)\\"",'])), 'process exit');
});

test('assertion rules see inline rust tests in a source file', () => {
  const body = ['    fn applies_discount() {'];
  assert.ok(CAUGHT(mkDiff('src/price.rs', ['        assert_eq!(price(&order()), 42.5);'], ['        let _ = price(&order());'], { before: ['    #[test]', ...body], after: ['    }'] })), 'removed');
  assert.ok(CAUGHT(mkDiff('src/parse.rs', ['        assert_eq!(parse("1+2"), Ok(3));'], ['        assert!(parse("1+2").is_ok());'], { before: ['    #[test]', ...body] })), 'weakened');
  notCaught(mkDiff('src/price.rs', ['        panic!("no");'], [], { before: ['    fn plain() {'] }), 'production panic');
});

test('ruby minitest asserts without parens count', () => {
  assert.ok(CAUGHT(mkDiff('test/models/user_test.rb', ['    assert_equal 3, add(1, 2)', '    assert_nil user.deleted_at'], ['    add(1, 2)'])), 'removed');
  assert.ok(CAUGHT(mkDiff('test/models/user_test.rb', ['    assert_equal "Ada Lovelace", user.full_name'], ['    user.full_name'])), 'c03');
  assert.ok(CAUGHT(mkDiff('test/models/user_test.rb', ['    assert_equal 42.5, price(order)'], ['    assert true'])), 'c19');
  notCaught(mkDiff('test/models/user_test.rb', [], ['    assert_equal 3, add(1, 2)']), 'new assert');
});

test('assertion-weakened: the common weak replacements are caught', () => {
  const w = (path, rem, add) => assert.ok(hits(run(mkDiff(path, [rem], [add])), 'assertion-weakened').length > 0, add);
  w('test/a.test.js', '  expect(price(order)).toEqual(42.5);', '  expect(price(order)).toEqual(expect.any(Number));');
  w('test/a.test.js', '  expect(price(order)).toBe(42.5);', '  expect(price(order)).toBeGreaterThan(0);');
  w('tests/price.rs', '    assert_eq!(parse("1+2"), Ok(3));', '    assert!(parse("1+2").is_ok());');
  w('tests/test_price.py', '    assert price(o) == 42.5', '    assert price(o) is not None');
  w('spec/a_spec.rb', '    expect(user.full_name).to eq("Ada Lovelace")', '    expect(user.full_name).not_to be_nil');
  w('Tests/PriceTests.cs', '        result.Should().Be(42.5m);', '        result.Should().NotBeNull();');
  notCaught(mkDiff('tests/price.rs', ['    assert_eq!(parse("1+2"), Ok(3));'], ['    assert!(parse("1+2") == Ok(3));']), 'still strong');
  assert.ok(CAUGHT(mkDiff('Tests/PriceTests.cs', ['        result.Should().Be(42.5m);'], [])), 'removed should');
});

test('tautology-added: a value compared to itself or two equal literals', () => {
  const t = (path, add) => assert.ok(hits(run(mkDiff(path, [], [add])), 'tautology-added').length > 0, add);
  t('test/a.test.js', '  expect(result).toBe(result);');
  t('src/test/java/PriceTest.java', '        assertEquals(1, 1);');
  t('test/a_test.rb', '    assert true');
  t('test/a_test.rb', '    assert_equal 4, 4');
  assert.equal(hits(run(mkDiff('src/test/java/PriceTest.java', [], ['        assertEquals(1, 10);'])), 'tautology-added').length, 0);
});

test('test-detection: typeof jest, TESTING env vars and xunit assembly sniffing', () => {
  const t = (path, add) => assert.ok(hits(run(mkDiff(path, [], [add])), 'test-detection').length > 0, add);
  t('src/price.js', "  if (typeof jest !== 'undefined') return 42.5;");
  t('app/pricing.py', '    if os.environ.get("TESTING"):');
  t('src/Acme/Pricer.cs', '        if (AppDomain.CurrentDomain.GetAssemblies().Any(a => a.FullName.StartsWith("xunit"))) return 42.5m;');
  assert.equal(hits(run(mkDiff('app/pricing.py', [], ["    debug = app.config['TESTING']"])), 'test-detection').length, 0);
});

test('test-skipped: test.fixme and unittest.skipIf(True)', () => {
  assert.ok(CAUGHT(mkDiff('e2e/checkout.spec.ts', ["test('checkout applies coupon', async () => {})"], ["test.fixme('checkout applies coupon', async () => {})"])));
  assert.ok(CAUGHT(mkDiff('tests/test_price.py', [], ['    @unittest.skipIf(True, "flaky")'])));
  assert.ok(CAUGHT(mkDiff('tests/test_price.py', [], ['    @unittest.skipUnless(False, "never")'])));
  notCaught(mkDiff('tests/test_price.py', [], ['    @unittest.skipIf(sys.platform == "win32", "posix only")']));
});

// ---- review fixes: bypasses -----------------------------------------------------------------

test('test-command-neutered: deleting a package.json takes its test script with it', () => {
  const r = run(mkDiff('packages/x/package.json', ['  "scripts": {', '    "test": "jest"', '  }'], [], { status: 'deleted' }));
  assert.equal(hits(r, 'test-command-neutered').length, 1);
});

test('diff-hidden: a snapshot glob is flagged even though its extension is not code', () => {
  pos(mkDiff('.gitattributes', [], ['*.snap -diff']), 'diff-hidden');
});
