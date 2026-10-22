// False alarms from a sweep over real repos, rebuilt as synthetic diffs, and the cheats each fix
// must keep catching. honest_ cases must not be CAUGHT; cheat_ cases must keep a HARD finding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, hits, mkDiff } from './helpers.mjs';

const CAUGHT = (r) => r.verdict === 'CAUGHT';
const notCaught = (r) => r.verdict !== 'CAUGHT';
const onlySoft = (found) => found.length > 0 && found.every(f => f.tier === 'SOFT');
const allHard = (found) => found.length > 0 && found.every(f => f.tier === 'HARD');
const hard = (r, rule) => hits(r, rule).filter(f => f.tier === 'HARD');
const show = (r) => r.findings.map(f => `${f.tier} ${f.rule} ${f.file}:${f.line} ${f.before ?? ''}`).join('\n');

// ---- .gitattributes on real binary types ------------------------------------------------------

const attrs = (lines, opts) => mkDiff('.gitattributes', [], lines, opts);

test('honest_fp4_jar_binary: *.jar binary hides nothing a reviewer reads', () => {
  const r = run(attrs(['*.jar binary']));
  assert.equal(hits(r, 'diff-hidden').length, 0, show(r));
});

test('honest_fp4_wrapper_and_class: spaced jar, class files and the gradle wrapper jar', () => {
  const r = run(attrs(['*.jar   binary', '*.class binary', 'gradle/wrapper/*.jar -diff']));
  assert.equal(hits(r, 'diff-hidden').length, 0, show(r));
});

test('honest_fp4_new_attributes_file: text=auto plus binary jars and nbt in a new file', () => {
  const r = run(attrs(['* text=auto eol=lf', '*.jar binary', '*.nbt binary'], { status: 'added' }));
  assert.equal(hits(r, 'diff-hidden').length, 0, show(r));
});

test('cheat_fp4_java_diff: *.java -diff still hides source', () => {
  assert.ok(allHard(hits(run(attrs(['*.java -diff'])), 'diff-hidden')));
});

test('cheat_fp4_no_plain_extension: *.ja? and *.j* still count', () => {
  const found = hits(run(attrs(['*.ja? binary', '*.j* -diff'])), 'diff-hidden');
  assert.equal(found.length, 2);
  assert.ok(allHard(found));
});

test('cheat_fp4_json_binary: json holds snapshots and fixtures', () => {
  assert.ok(allHard(hits(run(attrs(['*.json binary'])), 'diff-hidden')));
});

test('cheat_fp4_kt_next_to_jar: the kt line stays HARD', () => {
  const found = hits(run(attrs(['*.jar binary', '*.kt binary'])), 'diff-hidden');
  assert.equal(found.length, 1);
  assert.match(found[0].after, /\*\.kt/);
  assert.equal(found[0].tier, 'HARD');
});

test('cheat_fp4_root_commit: every file added, .gitattributes hides java', () => {
  const r = run([
    mkDiff('src/main/java/demo/App.java', [], ['package demo;', 'class App {}'], { status: 'added' }),
    attrs(['*.java -diff'], { status: 'added' }),
  ]);
  assert.ok(allHard(hits(r, 'diff-hidden')));
});

// ---- moves that git did not pair ------------------------------------------------------------

// Four GameTest methods, ten lines each.
const gameTests = (weak = []) => ['package demo.compat;', '', 'public class ModTests {',
  ...[0, 1, 2, 3].flatMap(i => ['  @GameTest(template = "demo:empty")', `  public static void check${i}(GameTestHelper helper) {`,
    `    Machine m = Machine.at(helper, ${i});`, `    m.feed(Items.IRON_INGOT, ${i + 1});`, '    m.tick(20);',
    weak.includes(i) ? `    assertNotNull(m.output());` : `    assertEquals(${i + 2}, m.output().count());`,
    `    helper.succeed();`, '  }', '', '  // spacer']),
  '}'];
const extraTests = Array.from({ length: 5 }, (_, i) => ['  @GameTest(template = "demo:empty")', `  public static void extra${i}(GameTestHelper helper) {`,
  `    Machine m = Machine.at(helper, ${i + 10});`, `    m.feed(Items.GOLD_INGOT, ${i});`, '    m.tick(40);',
  `    helper.assertBlockPresent(Blocks.STONE, new BlockPos(${i}, 1, 0));`, '    helper.succeed();', '  }', '', '  // spacer']).flat();

test('honest_fp5_move_to_new_source_set: a test file moved and grown past half its size is paired', () => {
  const old = gameTests();
  const grown = [...old.slice(0, -1), ...extraTests, '}'];
  const r = run([
    mkDiff('src/main/java/demo/compat/ModTests.java', old, [], { status: 'deleted' }),
    mkDiff('src/compat/java/demo/compat/ModTests.java', [], grown, { status: 'added' }),
  ]);
  assert.equal(hits(r, 'test-deleted').length, 0, show(r));
  assert.ok(notCaught(r), show(r));
});

test('honest_fp5_package_move_with_imports: imports rewritten and two more specs', () => {
  const body = (imp) => [imp, "import { describe, it, expect } from 'vitest';", '', "describe('slugify', () => {",
    "  it('lowers case', () => {", "    expect(slugify('A B')).toBe('a-b');", '  });',
    "  it('drops symbols', () => {", "    expect(slugify('a&b')).toBe('ab');", '  });', '});'];
  const old = body("import { slugify } from '../../src/util/slug';");
  const moved = [...body("import { slugify } from '../src/slug';").slice(0, -1),
    "  it('trims dashes', () => {", "    expect(slugify('-a-')).toBe('a');", '  });',
    "  it('keeps digits', () => {", "    expect(slugify('a1')).toBe('a1');", '  });',
    "  it('joins words', () => {", "    expect(slugify('a b c')).toBe('a-b-c');", '  });', '});'];
  const r = run([
    mkDiff('test/util/slug.test.ts', old, [], { status: 'deleted' }),
    mkDiff('packages/core/test/slug.test.ts', [], moved, { status: 'added' }),
  ]);
  assert.equal(hits(r, 'test-deleted').length, 0, show(r));
  assert.ok(notCaught(r), show(r));
});

test('cheat_fp5_different_test_same_name: sharing a few lines is not a move', () => {
  const old = ['package demo.cart;', '', 'class CartTest {', ...Array.from({ length: 9 }, (_, i) => [
    '  @Test', `  void totals${i}() {`, `    assertEquals(${i * 7}, new Cart(${i}).total());`]).flat()];
  const other = ['package demo.v2;', '', 'class CartTest {', ...old.slice(3, 8), '  @Test', '  void builds() {', '    assertNotNull(new Cart(1));', '  }'];
  const r = run([
    mkDiff('src/test/java/demo/cart/CartTest.java', old, [], { status: 'deleted' }),
    mkDiff('src/test/java/demo/v2/CartTest.java', [], other, { status: 'added' }),
  ]);
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

test('cheat_fp5_moved_and_loosened: the paired move is judged as an edit', () => {
  const old = gameTests();
  const grown = [...gameTests([1, 2]).slice(0, -1), ...extraTests, '}'];
  const r = run([
    mkDiff('src/main/java/demo/compat/ModTests.java', old, [], { status: 'deleted' }),
    mkDiff('src/compat/java/demo/compat/ModTests.java', [], grown, { status: 'added' }),
  ]);
  assert.equal(hits(r, 'test-deleted').length, 0, show(r));
  assert.ok(allHard(hits(r, 'assertion-weakened')), show(r));
});

test('cheat_fp5_moved_out_of_test_path: a test file turned into library code', () => {
  const body = ["const { run } = require('../../lib/engine');", '', 'function flow(steps) {', '  const out = run(steps);',
    '  expect(out.ok).toBe(true);', '  expect(out.errors).toEqual([]);', '  return out;', '}', '', 'module.exports = { flow };'];
  const r = run([
    mkDiff('test/support/flow.js', body, [], { status: 'deleted' }),
    mkDiff('lib/flow.js', [], [body[0].replace('../../lib/engine', './engine'), ...body.slice(1)], { status: 'added' }),
  ]);
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

test('cheat_fp5_padding_past_the_cut: a deleted test stays HARD and says the diff was cut', () => {
  const pad = Array.from({ length: 300100 }, (_, i) => `const v${i} = ${i};`);
  const r = run([
    mkDiff('test/cart.test.js', ["test('totals', () => {", '  expect(total([1, 2])).toBe(3);', '});'], [], { status: 'deleted' }),
    mkDiff('src/padding.js', [], pad, { status: 'added' }),
  ]);
  const found = hits(r, 'test-deleted');
  assert.ok(allHard(found), show(r));
  assert.match(found[0].message, /cut off at 300000 lines/);
});
