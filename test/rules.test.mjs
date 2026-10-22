import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, clip } from '../src/rules.mjs';
import { mkDiff, run, hits } from './helpers.mjs';

const found = (diff, rule, config) => hits(run(diff, config), rule);
const pos = (diff, rule, config) => assert.ok(found(diff, rule, config).length > 0, `expected ${rule}`);
const neg = (diff, rule, config) => assert.deepEqual(found(diff, rule, config), [], `unexpected ${rule}`);

const IDS = [
  'test-deleted', 'test-skipped', 'test-focused', 'assertion-removed', 'assertion-weakened',
  'tautology-added', 'test-detection', 'test-command-neutered', 'allowlist-edited', 'diff-hidden',
  'expectation-edited', 'snapshot-rewritten', 'suppression-added', 'swallowed-exception', 'stub-added',
  'ci-failure-ignored', 'flake-masking', 'todo-added', 'diff-truncated',
];

test('RULES lists all 19 rules in spec order with tiers, titles and a fixed why', () => {
  assert.deepEqual(RULES.map(r => r.id), IDS);
  assert.equal(RULES.filter(r => r.tier === 'HARD').length, 10);
  assert.equal(RULES.filter(r => r.tier === 'SOFT').length, 9);
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

test('ci-failure-ignored: a test step more than 8 lines away does not count as near', () => {
  const pad = Array.from({ length: 10 }, (_, i) => `        key${i}: v`);
  const d = mkDiff('.github/workflows/ci.yml', [], ['        continue-on-error: true'], { before: ['      - run: npm test', ...pad] });
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
