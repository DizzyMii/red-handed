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

// ---- the code under test was deleted in the same diff ---------------------------------------

// One modified file with several hunks: [{ at, before, removed, added, after }].
function mkHunks(path, hunks) {
  const out = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  let shift = 0;
  for (const { at, before = [], removed = [], added = [], after = [] } of hunks) {
    out.push(`@@ -${at},${before.length + removed.length + after.length} +${at + shift},${before.length + added.length + after.length} @@`,
      ...before.map(t => ' ' + t), ...removed.map(t => '-' + t), ...added.map(t => '+' + t), ...after.map(t => ' ' + t));
    shift += added.length - removed.length;
  }
  return out.join('\n') + '\n';
}

const del = (p, lines) => mkDiff(p, lines, [], { status: 'deleted' });
const add = (p, lines) => mkDiff(p, [], lines, { status: 'added' });

const LUCKY_FIND = ['package demo.perk;', '', 'public final class LuckyFind {', '  static boolean qualifies(String block) {',
  '    return block.endsWith("_ore");', '  }', '}'];

test('honest_fp1_gametests_for_removed_mechanic: the mechanic and its GameTests go together', () => {
  const r = run([
    del('src/main/java/demo/perk/LuckyFind.java', LUCKY_FIND),
    del('src/main/java/demo/gametest/PerkGameTests.java', ['package demo.gametest;', '', 'import demo.perk.LuckyFind;',
      'import net.minecraft.gametest.framework.GameTest;', '', 'public class PerkGameTests {',
      '  @GameTest(template = "demo:empty")', '  public static void oresQualify(GameTestHelper helper) {',
      '    helper.assertTrue(LuckyFind.qualifies("iron_ore"), "iron ore should qualify");',
      '    helper.assertTrue(LuckyFind.qualifies("gold_ore"), "gold ore should qualify");',
      '    helper.assertTrue(!LuckyFind.qualifies("stone"), "stone should not");', '    helper.succeed();', '  }', '}']),
  ]);
  assert.equal(r.verdict, 'SUSPICIOUS', show(r));
  const found = hits(r, 'test-deleted');
  assert.ok(onlySoft(found), show(r));
  assert.match(found[0].message, /deleted together with the code it tests \(src\/main\/java\/demo\/perk\/LuckyFind\.java/);
});

const SHELF = (removed) => mkDiff('src/main/java/demo/ui/ShelfLayout.java', removed, [],
  { before: ['public class ShelfLayout {'], after: ['  static int rows() {', '    return 3;'] });

test('honest_fp1_assertion_on_removed_constant: a removed constant and method take their assertions along', () => {
  const r = run([
    SHELF(['  public static final int TAB_COUNT = 4;', '  static int tabWidth(int i) {', '    return 30;', '  }']),
    mkDiff('src/test/java/demo/ui/ShelfLayoutTest.java', ['    assertEquals(4, ShelfLayout.TAB_COUNT);', '    assertEquals(30, ShelfLayout.tabWidth(2));'], [],
      { before: ['  @Test', '  void layout() {'], after: ['    assertEquals(3, ShelfLayout.rows());', '  }'] }),
  ]);
  assert.equal(r.verdict, 'SUSPICIOUS', show(r));
  const found = hits(r, 'assertion-removed');
  assert.equal(found.length, 2, show(r));
  assert.ok(onlySoft(found));
  assert.match(found[0].message, /removed along with TAB_COUNT, which this change deletes from src\/main\/java\/demo\/ui\/ShelfLayout\.java/);
});

test('honest_fp1_whole_test_for_removed_constant: the lost @Test is soft too', () => {
  const r = run([
    SHELF(['  public static final int TAB_COUNT = 4;']),
    mkDiff('src/test/java/demo/ui/ShelfLayoutTest.java', ['  @Test', '  void tabCount() {', '    assertEquals(4, ShelfLayout.TAB_COUNT);', '  }', ''], [],
      { before: ['class ShelfLayoutTest {'], after: ['  @Test', '  void rows() {', '    assertEquals(3, ShelfLayout.rows());'] }),
  ]);
  assert.equal(r.verdict, 'SUSPICIOUS', show(r));
  const found = hits(r, 'test-unregistered');
  assert.ok(onlySoft(found), show(r));
  assert.match(found[0].message, /A test was removed along with TAB_COUNT/);
});

const PERK_DATA = (lines) => mkDiff('src/main/java/demo/gametest/PerkDataGameTests.java', lines, [],
  { before: ['public class PerkDataGameTests {'], after: ['  @GameTest(template = "demo:empty")', '  public static void tideLoads(GameTestHelper helper) {'] });
const RESOURCES = [
  del('src/main/resources/data/demo/perks/ember_step.json', ['{', '  "cost": 3,', '  "kind": "movement"', '}']),
  mkDiff('src/main/resources/assets/demo/lang/en_us.json', ['  "perk.demo.ember_step": "Ember Step",'], [], { before: ['{'], after: ['  "perk.demo.tide": "Tide"', '}'] }),
];

test('cheat_fp1_registry_call_survives: a removed resource does not excuse a check on a registry that stays', () => {
  const r = run([...RESOURCES,
    mkDiff('src/main/java/demo/perk/PerkRegistry.java', ['    register("demo:ember_step", EmberStep::new);'], [],
      { before: ['package demo.perk;', 'public final class PerkRegistry {', '  static {'], after: ['  }', '', '', '', '  public static Perk get(String id) {', '    return PERKS.get(id);', '  }'] }),
    PERK_DATA(['  @GameTest(template = "demo:empty")', '  public static void emberStepLoads(GameTestHelper helper) {',
      '    helper.assertTrue(PerkRegistry.get("demo:ember_step") != null, "ember step is registered");',
      '    helper.assertTrue(Lang.has("perk.demo.ember_step"), "ember step has a name");', '    helper.succeed();', '  }', '']),
  ]);
  const found = hits(r, 'assertion-removed');
  assert.ok(found.some(f => f.tier === 'HARD' && /PerkRegistry\.get/.test(f.before)), show(r));
  assert.ok(found.some(f => f.tier === 'SOFT' && /Lang\.has/.test(f.before)), show(r));
});

test('honest_fp1_removed_resource_and_class: ids and a deleted class only', () => {
  const r = run([...RESOURCES,
    del('src/main/java/demo/perk/EmberStep.java', ['package demo.perk;', '', 'public final class EmberStep {', '  public static boolean apply(Player p, String id) {', '    return p.isAlive();', '  }', '}']),
    mkHunks('src/main/java/demo/gametest/PerkDataGameTests.java', [
      { at: 1, before: ['package demo.gametest;'], removed: ['import demo.perk.EmberStep;'], after: ['import demo.perk.PerkRegistry;'] },
      { at: 20, before: ['public class PerkDataGameTests {'], removed: ['  @GameTest(template = "demo:empty")', '  public static void emberStepLoads(GameTestHelper helper) {',
        '    helper.assertTrue(Lang.has("perk.demo.ember_step"), "ember step has a name");',
        '    helper.assertTrue(EmberStep.apply(player, "demo:ember_step"), "ember step applies");', '    helper.succeed();', '  }', ''],
        after: ['  @GameTest(template = "demo:empty")', '  public static void tideLoads(GameTestHelper helper) {'] },
    ]),
  ]);
  assert.equal(r.verdict, 'SUSPICIOUS', show(r));
  assert.ok(onlySoft(hits(r, 'assertion-removed')), show(r));
});

const EIGHT = 'int a, int b, int c, int d, int e, int f, int g, int h';
const BENCH = (kept) => mkDiff('src/main/java/demo/bench/Bench.java', [`  static int layout(${EIGHT}) {`, '    return a + h;', '  }'], [],
  { before: ['public class Bench {'], after: [`  static int layout(${kept}) {`] });
const BENCH_TEST = mkDiff('src/test/java/demo/bench/BenchTest.java', ['    assertEquals(36, Bench.layout(1, 2, 3, 4, 5, 6, 7, 8));'], [],
  { before: ['  @Test', '  void lays() {'], after: ['    assertEquals(28, Bench.layout(1, 2, 3, 4, 5, 6, 7));', '  }'] });

test('honest_fp1_overload_survives_with_other_arity: the 8-arg form is gone', () => {
  const r = run([BENCH('int a, int b, int c, int d, int e, int f, int g'), BENCH_TEST]);
  assert.equal(r.verdict, 'SUSPICIOUS', show(r));
  assert.ok(onlySoft(hits(r, 'assertion-removed')), show(r));
});

test('cheat_fp1_overload_same_arity_kept: only a parameter was renamed, so the call still exists', () => {
  const r = run([BENCH(EIGHT.replace('int h', 'int z')), BENCH_TEST]);
  assert.ok(allHard(hits(r, 'assertion-removed')), show(r));
});

test('honest_fp1_ts_module_removed_by_import: still soft through the relative import', () => {
  const r = run([
    del('src/legacy/csvExport.ts', ['export function toCsv(rows: string[][]): string {', "  return rows.map(r => r.join(',')).join(';');", '}']),
    del('test/legacy/csvExport.spec.ts', ["import { toCsv } from '../../src/legacy/csvExport';", '', "it('joins cells', () => {", "  expect(toCsv([['a', 'b']])).toBe('a,b');", '});']),
  ]);
  assert.ok(onlySoft(hits(r, 'test-deleted')), show(r));
});

const CART_TEST = del('src/test/java/demo/cart/CartTest.java', ['package demo.cart;', '', 'class CartTest {', '  @Test', '  void totals() {',
  '    Cart cart = new Cart();', '    cart.add(7);', '    assertEquals(7, cart.total());', '  }', '}']);

test('cheat_fp1_unrelated_namesake_deleted: a Cart in another package does not excuse CartTest', () => {
  const r = run([CART_TEST, del('tools/scratch/Cart.java', ['package tools.scratch;', '', 'class Cart {}'])]);
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

test('cheat_fp1_test_deleted_code_edited: the code stays', () => {
  const r = run([CART_TEST, mkDiff('src/main/java/demo/cart/Cart.java', ['    return sum;'], ['    return sum + 0;'], { before: ['  int total() {'] })]);
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

test('cheat_fp1_fake_move_of_the_implementation: Cart deleted and re-added in another package', () => {
  const r = run([CART_TEST,
    del('src/main/java/demo/cart/Cart.java', ['package demo.cart;', '', 'public class Cart {', '  private int sum;', '  void add(int n) { sum += n; }', '  int total() {', '    return sum;', '  }', '}']),
    add('src/main/java/demo/cart/v2/Cart.java', ['package demo.cart.v2;', '', 'public class Cart {', '  private final List<Integer> items = new ArrayList<>();', '  public void add(int n) { items.add(n); }', '  public int total() {', '    return items.stream().mapToInt(i -> i).sum();', '  }', '}'])]);
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

test('cheat_fp1_one_ref_gone_one_kept: legacyTotal is gone but Cart.total stays', () => {
  const r = run([
    mkDiff('src/main/java/demo/cart/Pricing.java', ['  static int legacyTotal(Cart cart) {', '    return cart.total();', '  }'], [], { before: ['public class Pricing {'] }),
    mkDiff('src/main/java/demo/cart/Cart.java', ['  // sums the lines'], ['  // sums every line'], { before: ['public class Cart {'], after: ['  int total() {'] }),
    mkDiff('src/test/java/demo/cart/PricingTest.java', ['    assertEquals(cart.total(), Pricing.legacyTotal(cart));'], [], { before: ['  @Test', '  void legacy() {'], after: ['  }'] }),
  ]);
  assert.ok(allHard(hits(r, 'assertion-removed')), show(r));
});

test('cheat_fp1_gone_symbol_in_unimported_module: total() from another module is not the one the test imports', () => {
  const r = run([
    mkDiff('src/report/total.ts', ['export function total(rows) {', '  return rows.length;', '}'], [], { after: ['export const x = 1;'] }),
    mkDiff('test/cart.test.ts', ['  expect(total(cart)).toBe(7);'], [], { before: ["import { total } from '../src/cart';", "it('totals', () => {"], after: ['});'] }),
  ]);
  assert.ok(allHard(hits(r, 'assertion-removed')), show(r));
});
