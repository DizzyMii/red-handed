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

// ---- coverage moved to another test in the same diff ----------------------------------------

const gaugeTests = (cls) => [
  '  @Test', '  void halfFull() {', `    assertEquals(0.5f, ${cls}.gaugeFor(5, 10), 1e-6f);`, '  }', '',
  '  @Test', '  void emptyWhenNoMax() {', `    assertEquals(0f, ${cls}.gaugeFor(3, 0), 1e-6f);`, '  }'];

test('honest_fp3_gauge_tests_moved_with_class_rename: the same checks on the renamed class', () => {
  const r = run([
    mkDiff('src/main/java/demo/hud/HudPanel.java', ['public final class ResourceHud {'], ['public final class HudPanel {'], { status: 'renamed', oldPath: 'src/main/java/demo/hud/ResourceHud.java', before: ['package demo.hud;'] }),
    del('src/test/java/demo/hud/ResourceHudGaugeTest.java', ['package demo.hud;', '', 'class ResourceHudGaugeTest {', ...gaugeTests('ResourceHud'), '}']),
    add('src/test/java/demo/hud/HudPanelTest.java', ['package demo.hud;', '', 'import static org.junit.jupiter.api.Assertions.*;', '', 'class HudPanelTest {',
      '  @Test', '  void drawsAtOrigin() {', '    HudPanel p = new HudPanel(0, 0);', '    assertEquals(0, p.x());', '    assertEquals(0, p.y());', '  }', '',
      '  @Test', '  void scalesWithGui() {', '    HudPanel p = new HudPanel(0, 0);', '    p.scale(2);', '    assertEquals(2, p.scale());', '  }', '',
      ...gaugeTests('HudPanel'), '}']),
  ]);
  assert.equal(hits(r, 'test-deleted').length, 0, show(r));
  assert.ok(notCaught(r), show(r));
});

test('honest_fp3_spec_merged_into_bigger_one: three parseDate specs now live in dates.test.ts', () => {
  const specs = ["  it('reads iso dates', () => {", "    expect(parseDate('2024-01-02')).toEqual({ y: 2024, m: 1, d: 2 });", '  });',
    "  it('reads slashes', () => {", "    expect(parseDate('2024/01/02')).toEqual({ y: 2024, m: 1, d: 2 });", '  });',
    "  it('rejects junk', () => {", "    expect(parseDate('soon')).toEqual(null);", '  });'];
  const r = run([
    del('test/parseDate.test.ts', ["import { parseDate } from '../src/dates';", '', "describe('parseDate', () => {", ...specs, '});']),
    mkDiff('test/dates.test.ts', [], ['', "describe('parseDate', () => {", ...specs, '});'], { before: ["import { formatDate, parseDate } from '../src/dates';"], after: ['', "describe('formatDate', () => {"] }),
  ]);
  assert.equal(hits(r, 'test-deleted').length, 0, show(r));
  assert.ok(notCaught(r), show(r));
});

test('honest_fp3_python_move: slug tests folded into test_text.py', () => {
  const r = run([
    del('tests/test_slug.py', ['from app.text import slugify', '', 'def test_spaces():', '    assert slugify("A B") == "a-b"', '', 'def test_symbols():', '    assert slugify("a&b") == "ab"']),
    mkDiff('tests/test_text.py', [], ['', 'def test_slug_spaces():', '    assert slugify("A B") == "a-b"', '', 'def test_slug_symbols():', '    assert slugify("a&b") == "ab"'],
      { before: ['from app.text import slugify, wrap', '', 'def test_wrap():', '    assert wrap("a b", 1) == ["a", "b"]'] }),
  ]);
  assert.equal(hits(r, 'test-deleted').length, 0, show(r));
  assert.ok(notCaught(r), show(r));
});

const CART_TOTALS = ['package demo.cart;', '', 'class CartTest {', '  @Test', '  void totalsLines() {', '    Cart cart = new Cart(3, 4);',
  '    assertEquals(7, cart.total());', '    assertEquals(2, cart.lines());', '    assertEquals(4, cart.max());', '  }', '}'];
const ORDER = (added, before = ['class OrderTest {']) => mkDiff('src/test/java/demo/cart/OrderTest.java', [], added, { before, after: ['  @Test', '  void ships() {'] });

test('cheat_fp3_empty_namesake: a test of the same name with no checks', () => {
  const r = run([del('src/test/java/demo/cart/CartTest.java', CART_TOTALS), ORDER(['  @Test', '  void totalsLines() {', '  }', ''])]);
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

test('cheat_fp3_half_the_checks: two of three copied, and the message says so', () => {
  const r = run([del('src/test/java/demo/cart/CartTest.java', CART_TOTALS),
    ORDER(['  @Test', '  void totalsLines() {', '    Cart cart = new Cart(3, 4);', '    assertEquals(7, cart.total());', '    assertEquals(2, cart.lines());', '  }', ''])]);
  const found = hits(r, 'test-deleted');
  assert.ok(allHard(found), show(r));
  assert.match(found[0].message, /2 of its 3 checks reappear in src\/test\/java\/demo\/cart\/OrderTest\.java; the other 1 do not\./);
});

const ALL_THREE = ['    Cart cart = new Cart(3, 4);', '    assertEquals(7, cart.total());', '    assertEquals(2, cart.lines());', '    assertEquals(4, cart.max());'];

test('honest_fp3_all_checks_copied: the same three checks in a real test elsewhere', () => {
  const r = run([del('src/test/java/demo/cart/CartTest.java', CART_TOTALS), ORDER(['  @Test', '  void cartTotals() {', ...ALL_THREE, '  }', ''])]);
  assert.equal(hits(r, 'test-deleted').length, 0, show(r));
});

test('cheat_fp3_checks_parked_in_production_code: Checks.java is not a test', () => {
  const r = run([del('src/test/java/demo/cart/CartTest.java', CART_TOTALS),
    mkDiff('src/main/java/demo/Checks.java', [], ['  @Test', '  void cartTotals() {', ...ALL_THREE, '  }'], { before: ['class Checks {'] })]);
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

test('cheat_fp3_checks_moved_into_switched_off_test: @Disabled does not count', () => {
  const r = run([del('src/test/java/demo/cart/CartTest.java', CART_TOTALS), ORDER(['  @Disabled', '  @Test', '  void cartTotals() {', ...ALL_THREE, '  }', ''])]);
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
  // test-skipped calls a skip on a test the same change adds SOFT, so it is only checked to fire.
  assert.ok(hits(r, 'test-skipped').length > 0, show(r));
  const sameLine = run([del('src/test/java/demo/cart/CartTest.java', CART_TOTALS), ORDER(['  @Disabled @Test', '  void cartTotals() {', ...ALL_THREE, '  }', ''], ['class OrderTest {', '  @Test', '  void builds() {', '    assertNotNull(new Order());', '  }'])]);
  assert.ok(allHard(hits(sameLine, 'test-deleted')), show(sameLine));
});

test('cheat_fp3_looser_copy: assertNotNull is not the same check', () => {
  const r = run([del('src/test/java/demo/cart/CartTest.java', CART_TOTALS),
    ORDER(['  @Test', '  void cartTotals() {', '    Cart cart = new Cart(3, 4);', '    assertNotNull(cart.total());', '    assertEquals(2, cart.lines());', '    assertEquals(4, cart.max());', '  }', ''])]);
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

test('cheat_fp3_copy_into_file_the_runner_skips: test/cart.checks.js is never collected', () => {
  const body = ["test('totals', () => {", '  expect(total([3, 4])).toBe(7);', '  expect(count([3, 4])).toBe(2);', '});'];
  const r = run([
    del('test/cart.test.js', ["const { total, count } = require('../src/cart');", '', ...body]),
    mkDiff('test/cart.checks.js', [], body, { before: ["const { total, count } = require('../src/cart');", ''] }),
  ]);
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

// ---- the test was rewritten to a changed API or behaviour -----------------------------------

const TIDE = mkDiff('src/main/java/demo/tide/TideClock.java',
  ['  static int bonusTurnsAfterCashOut(int n) {', '    return n == 0 ? 1 : 0;'], ['  static boolean grantsBonus(int n) {', '    return n == 0;'],
  { before: ['package demo.tide;', 'public final class TideClock {'], after: ['  }'] });

test('honest_fp2_return_type_change: an int count became a yes or no', () => {
  const r = run([TIDE, mkDiff('src/test/java/demo/tide/TideClockTest.java',
    ['    assertEquals(1, TideClock.bonusTurnsAfterCashOut(0));', '    assertEquals(0, TideClock.bonusTurnsAfterCashOut(3));'],
    ['    assertTrue(TideClock.grantsBonus(0));', '    assertFalse(TideClock.grantsBonus(3));'],
    { before: ['  @Test', '  void bonusOnlyOnFirstCashOut() {'], after: ['  }'] })]);
  assert.ok(notCaught(r), show(r));
  const weak = hits(r, 'assertion-weakened');
  assert.ok(onlySoft(weak), show(r));
  assert.match(weak[0].message, /removed or renamed bonusTurnsAfterCashOut in src\/main\/java\/demo\/tide\/TideClock\.java/);
});

const SHOP = mkDiff('src/main/java/demo/shop/ShopLayout.java', ['  public static final int SLOT_COUNT = 4;'],
  ['  public static final int VISIBLE_RIGHT = 180;', '  public static final int VISIBLE_BOTTOM = 120;'], { before: ['public final class ShopLayout {'] });

test('honest_fp2_constant_replaced_by_bounds: a slot count became two edges the book has to fit in', () => {
  const r = run([SHOP, mkDiff('src/test/java/demo/shop/ShopLayoutTest.java', ['    assertEquals(4, ShopLayout.SLOT_COUNT);'],
    ['    assertTrue(left + ShopLayout.VISIBLE_RIGHT <= windowW, "book fits");', '    assertTrue(top + ShopLayout.VISIBLE_BOTTOM <= windowH, "book fits");'],
    { before: ['  @Test', '  void bookFits() {'], after: ['  }'] })]);
  assert.ok(notCaught(r), show(r));
  assert.ok(onlySoft(hits(r, 'assertion-weakened')), show(r));
});

test('honest_fp2_behaviour_change_plus_dropped_feature: one check went with the constant, one changed its expected value', () => {
  const r = run([
    mkHunks('src/reply.ts', [
      { at: 1, before: ['export const MIN = 60000;'], removed: ['export const REPLY_WINDOW_MS = 120000;'], after: [''] },
      { at: 10, before: ['export function classify(text, ctx) {', '  if (ctx.ts > ctx.last + MIN) {'], removed: ['    return null;'], added: ['    return "followup";'], after: ['  }'] },
    ]),
    mkHunks('test/reply.test.ts', [
      { at: 1, removed: ["import { classify, MIN, REPLY_WINDOW_MS } from '../src/reply';"], added: ["import { classify, MIN } from '../src/reply';"], after: ["import assert from 'node:assert/strict';"] },
      { at: 8, before: ["test('follow-ups', () => {"], removed: ['  assert.equal(classify("ok", { ts: T0 + REPLY_WINDOW_MS + 1 }), null);', '  assert.equal(classify("yeah", { ts: T0 + MIN }), null);'],
        added: ['  assert.equal(classify("yeah", { ts: T0 + MIN }), "followup");'], after: ['});'] },
    ]),
  ]);
  assert.equal(r.verdict, 'SUSPICIOUS', show(r));
  const found = hits(r, 'assertion-removed');
  assert.equal(found.length, 2, show(r));
  assert.ok(onlySoft(found));
  assert.ok(found.some(f => /rewritten in the same change that changed classify in src\/reply\.ts/.test(f.message) && /followup/.test(f.after)), show(r));
});

const POOL_TEST = mkDiff('src/test/java/demo/pool/PoolGameTests.java',
  ['    helper.assertTrue(pool.round() == 0 && !pool.live(), "the pool should be empty after the last round");',
    '    helper.assertTrue(pool.round() == 0 && !pool.live(), "no round should be live once the pool is spent");'],
  ['    PoolChecks.assertEnded(helper, pool);'], { before: ['  @GameTest(template = "demo:pool")', '  public static void drains(GameTestHelper helper) {', '    Pool pool = Pool.at(helper);', '    pool.runAll();'], after: ['    helper.succeed();'] });
const POOL_CHECKS = (body) => add('src/test/java/demo/pool/PoolChecks.java', ['package demo.pool;', '', 'final class PoolChecks {',
  '  static void assertEnded(GameTestHelper helper, Pool pool) {', ...body, '  }', '}']);

test('honest_fp2_assertions_folded_into_helper: the checks moved into PoolChecks.assertEnded', () => {
  const r = run([POOL_TEST, POOL_CHECKS(['    helper.assertTrue(pool.round() == 0 && !pool.live(), "the run is over");', '    helper.assertTrue(pool.score() >= pool.best(), "score is kept");'])]);
  assert.ok(notCaught(r), show(r));
});

test('honest_fp2_helper_with_parameters: a literal check folded into a helper that takes the value', () => {
  const r = run([
    mkDiff('src/test/java/demo/pool/PoolTest.java', ['    assertEquals(3, pool.size());', '    assertEquals(3, pool.live().size());'], ['    assertSizes(pool, 3);'],
      { before: ['  @Test', '  void fills() {', '    Pool pool = Pool.of(3);'], after: ['  }'] }),
    add('src/test/java/demo/pool/PoolAsserts.java', ['package demo.pool;', '', 'final class PoolAsserts {', '  static void assertSizes(Pool p, int expected) {',
      '    assertEquals(expected, p.size());', '    assertEquals(expected, p.live().size());', '  }', '}']),
  ]);
  assert.ok(notCaught(r), show(r));
  const found = hits(r, 'assertion-removed');
  assert.ok(onlySoft(found), show(r));
  assert.match(found[0].message, /replaced by a call to assertSizes/);
});

test('cheat_fp2_helper_with_weak_checks: a helper that only checks the pool exists', () => {
  const r = run([POOL_TEST, POOL_CHECKS(['    helper.assertTrue(pool != null, "pool exists");'])]);
  assert.ok(allHard(hits(r, 'assertion-removed')), show(r));
});

test('honest_fp2_parameter_dropped: refusal lost two parameters and legacyFlag went', () => {
  const r = run([
    mkHunks('src/main/java/demo/refine/Refine.java', [
      { at: 3, before: ['public final class Refine {'], removed: ['  static String refusal(Item item, int n, boolean b, String s) {'], added: ['  static String refusal(Item item, String s) {'], after: ['    return s;'] },
      { at: 30, before: ['  }'], removed: ['  static boolean legacyFlag(Item item, int n) {', '    return n > 1;', '  }'], after: ['}'] },
    ]),
    mkDiff('src/test/java/demo/refine/RefineTest.java', [
      '    assertEquals("too small", Refine.refusal(PEBBLE, 1, true, "too small"));',
      '    assertEquals("too big", Refine.refusal(BOULDER, 9, true, "too big"));',
      '    assertEquals("wrong kind", Refine.refusal(STICK, 1, false, "wrong kind"));',
      '    assertTrue(Refine.legacyFlag(PEBBLE, 2));',
    ], [
      '    assertEquals("too small", Refine.refusal(PEBBLE, "too small"));',
      '    assertEquals("too big", Refine.refusal(BOULDER, "too big"));',
      '    assertEquals("wrong kind", Refine.refusal(STICK, "wrong kind"));',
    ], { before: ['  @Test', '  void refuses() {'], after: ['  }'] }),
  ]);
  assert.equal(r.verdict, 'SUSPICIOUS', show(r));
  const found = hits(r, 'assertion-removed');
  assert.equal(found.length, 4, show(r));
  assert.ok(onlySoft(found));
});

test('cheat_fp2_message_noise_only: message-only edits leave the findings, the dropped check stays', () => {
  const r = run([mkDiff('src/test/java/demo/score/ScoreTest.java', [
    '    helper.assertTrue(s.best() == 42, "the best score after the third round should still be forty two");',
    '    helper.assertTrue(s.worst() == 3, "the worst score after the third round should be three");',
    '    assertEquals(3, s.kinds().size());',
  ], ['    helper.assertTrue(s.best() == 42, "best");', '    helper.assertTrue(s.worst() == 3, "worst");'],
  { before: ['  @Test', '  void scores() {'], after: ['  }'] })]);
  assert.ok(CAUGHT(r), show(r));
  const found = hits(r, 'assertion-removed');
  assert.equal(found.length, 1, show(r));
  assert.match(found[0].before, /kinds\(\)/);
});

const CART_RENAME = mkDiff('src/main/java/demo/cart/Cart.java', ['  int total() {'], ['  int sum() {'], { before: ['public class Cart {'], after: ['    return lines.size();'] });
const cartTest = (removed, added) => mkDiff('src/test/java/demo/cart/CartTest.java', removed, added, { before: ['  @Test', '  void totals() {'], after: ['  }'] });

test('cheat_fp2_rename_then_weaken: total became sum and the check became not-null', () => {
  const r = run([CART_RENAME, cartTest(['    assertEquals(5, cart.total());'], ['    assertNotNull(cart.sum());'])]);
  assert.ok(allHard(hits(r, 'assertion-weakened')), show(r));
});

test('cheat_fp2_rename_then_compare_to_zero: sum() > 0 is not a real comparison', () => {
  const r = run([CART_RENAME, cartTest(['    assertEquals(5, cart.total());'], ['    assertTrue(cart.sum() > 0);'])]);
  assert.ok(allHard(hits(r, 'assertion-weakened')), show(r));
});

test('cheat_fp2_inversion_behind_comment_edit: a comment edit is not a change to sessionId', () => {
  const r = run([
    mkDiff('src/main/java/demo/anvil/AnvilSession.java', ['  // the id of the open session'], ['  // id of the open session, 0 when idle'], { before: ['public class AnvilSession {'], after: ['  int sessionId() {'] }),
    mkDiff('src/test/java/demo/anvil/AnvilSessionTest.java', ['    assertTrue(s.sessionId() == 0);', '    assertTrue(s.sessionId() == 0 && s.idle());'], ['    assertTrue(s.sessionId() != 0);'],
      { before: ['  @Test', '  void starts() {'], after: ['  }'] }),
  ]);
  assert.ok(allHard(hits(r, 'assertion-removed')), show(r));
});

test('cheat_fp2_arity_change_used_to_drop_checks: one rewrite pair, two checks gone', () => {
  const r = run([
    mkDiff('src/main/java/demo/cart/Pricing.java', ['  static int total(Cart cart) {'], ['  static int total(Cart cart, String currency) {'], { before: ['public class Pricing {'], after: ['    return cart.sum();'] }),
    mkDiff('src/test/java/demo/cart/PricingTest.java', ['    assertEquals(7, Pricing.total(a));', '    assertEquals(9, Pricing.total(b));', '    assertEquals(0, Pricing.total(empty));'],
      ['    assertEquals(7, Pricing.total(a, "EUR"));'], { before: ['  @Test', '  void totals() {'], after: ['  }'] }),
  ]);
  const found = hits(r, 'assertion-removed');
  assert.equal(found.filter(f => f.tier === 'HARD').length, 2, show(r));
  assert.equal(found.filter(f => f.tier === 'SOFT').length, 1, show(r));
});

test('cheat_fp2_message_swap_hiding_expected_value: JUnit 5 message drop keeps the expected value', () => {
  const r = run([mkDiff('src/test/java/demo/status/StatusTest.java', ['    assertEquals("ok", status(), "msg");', '    assertEquals(2, retries());'],
    ['    assertEquals("fail", status(), "other msg");'], { before: ['import org.junit.jupiter.api.Test;', '', '  @Test', '  void reports() {'], after: ['  }'] })]);
  assert.ok(allHard(hits(r, 'assertion-removed')), show(r));
});

const tideTests = (n) => Array.from({ length: n }, (_, i) => ['  @Test', `  void cashOut${i}() {`, `    TideClock.bonusTurnsAfterCashOut(${i});`, '  }', '']).flat();

test('honest_fp2_tests_replaced_after_rename: two smoke tests of the old name became one of the new name', () => {
  const r = run([TIDE,
    mkDiff('src/test/java/demo/tide/TideClockTest.java', tideTests(2), [], { before: ['class TideClockTest {'], after: ['  @Test', '  void ticks() {'] }),
    add('src/test/java/demo/tide/TideBonusTest.java', ['package demo.tide;', '', 'class TideBonusTest {', '  @Test', '  void grants() {', '    TideClock.grantsBonus(0);', '  }', '}']),
  ]);
  assert.ok(notCaught(r), show(r));
  const found = hits(r, 'test-unregistered');
  assert.ok(onlySoft(found), show(r));
  assert.match(found[0].message, /renamed or re-shaped bonusTurnsAfterCashOut/);
});

test('cheat_fp2_tests_replaced_by_unrelated_one: the new test does not call the new name', () => {
  const r = run([TIDE,
    mkDiff('src/test/java/demo/tide/TideClockTest.java', tideTests(2), [], { before: ['class TideClockTest {'], after: ['  @Test', '  void ticks() {'] }),
    add('src/test/java/demo/tide/TideBonusTest.java', ['package demo.tide;', '', 'class TideBonusTest {', '  @Test', '  void builds() {', '    new TideClock();', '  }', '}']),
  ]);
  assert.ok(allHard(hits(r, 'test-unregistered')), show(r));
});

test('honest_fp1_nested_type_name_reused_elsewhere: an unrelated nested Phase does not make the deletion a move', () => {
  const r = run([
    del('src/main/java/demo/ui/PageTurn.java', ['package demo.ui;', '', 'public final class PageTurn {', '  enum Phase { OUT, IN }', '  static float progress(int tick) {', '    return tick / 10f;', '  }', '}']),
    del('src/test/java/demo/ui/PageTurnTest.java', ['package demo.ui;', '', 'class PageTurnTest {', '  @Test', '  void halfway() {', '    assertEquals(0.5f, PageTurn.progress(5), 1e-6f);', '  }', '}']),
    mkDiff('src/main/java/demo/shop/Till.java', [], ['  enum Phase { OPEN, CLOSED }'], { before: ['public final class Till {'] }),
  ]);
  assert.ok(onlySoft(hits(r, 'test-deleted')), show(r));
});

test('honest_fp1_library_calls_do_not_block: isEmpty and locals on a typed receiver point outside the diff', () => {
  const r = run([
    del('src/main/java/demo/perk/GraniteHide.java', ['package demo.perk;', '', 'public final class GraniteHide {', '  static boolean isPhysical(DamageSource s) {', '    return !s.isMagic();', '  }', '}']),
    // Another class in the test's package happens to declare isEmpty and a field named found.
    mkDiff('src/main/java/demo/gametest/Bag.java', [], [], { before: ['public class Bag {', '  static final boolean found = false;', '  boolean isEmpty() {'] }),
    mkDiff('src/main/java/demo/gametest/PerkGameTests.java', ['    helper.assertTrue(!GraniteHide.isPhysical(lightning) && product.isEmpty() && !found, "lightning is not physical");'], [],
      { before: ['import demo.perk.GraniteHide;', '    ItemStack product = helper.craft();', '    boolean found = helper.scan();'], after: ['    helper.succeed();'] }),
  ]);
  assert.ok(onlySoft(hits(r, 'assertion-removed')), show(r));
});

test('cheat_fp1_untyped_receiver_still_blocks: cart.total() with no declared type keeps the line HARD', () => {
  const r = run([
    mkDiff('src/main/java/demo/cart/Pricing.java', ['  static int legacyTotal(Cart cart) {', '    return cart.total();', '  }'], [], { before: ['public class Pricing {'] }),
    mkDiff('src/main/java/demo/cart/Cart.java', [], [], { before: ['public class Cart {', '  int total() {'] }),
    mkDiff('src/test/java/demo/cart/PricingTest.java', ['    assertEquals(cart.total(), Pricing.legacyTotal(cart));'], [], { before: ['  @Test', '  void legacy() {'], after: ['  }'] }),
  ]);
  assert.ok(allHard(hits(r, 'assertion-removed')), show(r));
});

test('honest_fp1_local_from_removed_call: the assertion reads a value the removed radar returned', () => {
  const r = run([
    del('src/main/java/demo/perk/OreRadar.java', ['package demo.perk;', '', 'public final class OreRadar {', '  public static ItemStack matched(BlockState s) {', '    return ItemStack.EMPTY;', '  }', '}']),
    mkDiff('src/main/java/demo/gametest/Bag.java', [], [], { before: ['package demo.gametest;', 'public class Bag {', '  boolean isEmpty() {'] }),
    mkDiff('src/main/java/demo/gametest/RadarGameTests.java', ['    var product = OreRadar.matched(Blocks.STONE.defaultBlockState());', '    helper.assertTrue(product.isEmpty(),', '        "stone gives nothing (got " + product + ")");'], [],
      { before: ['package demo.gametest;', 'import demo.perk.OreRadar;', '  public static void stone(GameTestHelper helper) {'], after: ['    helper.succeed();'] }),
  ]);
  assert.ok(onlySoft(hits(r, 'assertion-removed')), show(r));
});

test('cheat_fp1_local_from_kept_call: the same shape with the radar still there stays HARD', () => {
  const r = run([
    mkDiff('src/main/java/demo/perk/OreRadar.java', [], [], { before: ['package demo.perk;', 'public final class OreRadar {', '  public static ItemStack matched(BlockState s) {'] }),
    mkDiff('src/main/java/demo/gametest/RadarGameTests.java', ['    var product = OreRadar.matched(Blocks.STONE.defaultBlockState());', '    helper.assertTrue(product.isEmpty(),', '        "stone gives nothing (got " + product + ")");'], [],
      { before: ['package demo.gametest;', 'import demo.perk.OreRadar;', '  public static void stone(GameTestHelper helper) {'], after: ['    helper.succeed();'] }),
  ]);
  assert.ok(allHard(hits(r, 'assertion-removed')), show(r));
});

const REFINE_SIG = mkDiff('src/main/java/demo/refine/Refine.java', ['  public static @Nullable String refusal(Item item, int stars, boolean keystone, String key) {'],
  ['  public static @Nullable String refusal(Item item, int stars, String key) {'], { before: ['public final class Refine {'], after: ['    return null;'] });

// The keystone parameter is gone from refusal, so its check cannot be written the old way. It was
// HARD before the arity rule; it is SOFT now, and still the one line reported outside the pairs.
test('honest_fp2_exact_pairs_first: the dropped keystone check is the one reported, not a neighbour', () => {
  const r = run([REFINE_SIG, mkDiff('src/test/java/demo/refine/RefineTest.java', [
    '    assertEquals("max", Refine.refusal(EMPTY, 3, true, OIL));',
    '    assertEquals("keystone", Refine.refusal(EMPTY, 2, false, OIL));',
    '    assertEquals("honed", Refine.refusal(HONED, 0, false, HONE));',
    '    assertEquals("oiled", Refine.refusal(OILED, 0, false, OIL));',
  ], [
    '    assertEquals("max", Refine.refusal(EMPTY, 3, OIL));',
    '    assertEquals("honed", Refine.refusal(HONED, 0, HONE));',
    '    assertEquals("oiled", Refine.refusal(OILED, 0, OIL));',
  ], { before: ['  @Test', '  void refuses() {'], after: ['  }'] })]);
  const found = hits(r, 'assertion-removed').filter(f => !/rewritten in the same change/.test(f.message));
  assert.equal(found.length, 1, show(r));
  assert.match(found[0].before, /keystone/);
  assert.equal(found[0].tier, 'SOFT');
  assert.match(found[0].message, /parameter this change removes/);
});

test('honest_fp2_weak_line_rewritten_as_weak: assertNotNull before and after is not a loosening', () => {
  const r = run([REFINE_SIG, mkDiff('src/test/java/demo/refine/RefineTest.java', [
    '    assertNotNull(Refine.refusal(done, 0, false, key), key + " never twice");',
    '    assertEquals("max", Refine.refusal(EMPTY, 3, true, OIL));',
    '    assertEquals("keystone", Refine.refusal(EMPTY, 2, false, OIL));',
  ], [
    '    assertNotNull(Refine.refusal(done, 0, key), key + " never twice");',
    '    assertEquals("max", Refine.refusal(EMPTY, 3, OIL));',
    '    assertNull(Refine.refusal(EMPTY, 2, OIL), "a third star needs no keystone");',
  ], { before: ['  @Test', '  void refuses() {'], after: ['  }'] })]);
  assert.equal(hits(r, 'assertion-weakened').length, 0, show(r));
});

test('honest_fp1_primitive_local_from_removed_call: double[] marks = Bench.marks(...) then marks[0]', () => {
  const r = run([
    mkDiff('src/main/java/demo/bench/Bench.java', ['  static double[] marks(int w, int h) {', '    return new double[] { -w / 2.0, h / 2.0 };', '  }'], [], { before: ['public final class Bench {'] }),
    mkDiff('src/test/java/demo/bench/BenchTest.java', ['    double[] square = Bench.marks(1, 1);', '    assertEquals(-0.5, square[0], 1e-9, "the marks read the centre negated");', '    assertEquals(0.5, square[1], 1e-9);'], [],
      { before: ['  @Test', '  void marks() {'], after: ['  }'] }),
  ]);
  assert.ok(onlySoft(hits(r, 'assertion-removed')), show(r));
});

test('honest_fp2_ts_local_helper_for_removed_detector: const d = (...) => detect(...)', () => {
  const r = run([
    mkDiff('src/perception.ts', ['export function lateReply(text, ctx, last) {', '  return ctx.ts - last.ts > WINDOW ? "late" : null;', '}'], [], { before: ['export const WINDOW = 60000;'] }),
    mkDiff('test/perception.test.ts', ['  const d = (text, ctx, last) => lateReply(text, ctx, last);', '  assert.equal(d("yeah", { ts: T0 + MIN }, her), null);', '  assert.equal(d("fine", { ts: T0 + 3 * MIN }, her), "late");'], [],
      { before: ["import { lateReply } from '../src/perception';", "test('late replies', () => {"], after: ['});'] }),
  ]);
  assert.ok(onlySoft(hits(r, 'assertion-removed')), show(r));
});

test('cheat_fp1_local_from_kept_call_with_primitive_type: the call survives, so the line is a lost check', () => {
  const r = run([
    mkDiff('src/main/java/demo/bench/Bench.java', [], [], { before: ['public final class Bench {', '  static double[] marks(int w, int h) {'] }),
    mkDiff('src/test/java/demo/bench/BenchTest.java', ['    double[] square = Bench.marks(1, 1);', '    assertEquals(-0.5, square[0], 1e-9);'], [],
      { before: ['  @Test', '  void marks() {'], after: ['  }'] }),
  ]);
  assert.ok(allHard(hits(r, 'assertion-removed')), show(r));
});

// ---- red team round: holes the first fixes opened, and the cheats that walk through them -----

test('cheat_fp3_testng_expected_value_swapped_in_move: Assert.assertEquals(actual, "lit") keeps its expected value', () => {
  const r = run([
    mkDiff('src/test/java/demo/cart/CartTest.java', ['package demo.cart;', 'import org.testng.Assert;', 'import org.testng.annotations.Test;', 'public class CartTest {',
      '  @Test', '  public void opens() {', '    Assert.assertEquals(new Cart().status(), "OPEN");', '  }', '}'], [], { status: 'deleted' }),
    mkDiff('src/test/java/demo/cart/OrderTest.java', [], ['  @Test', '  public void opens() {', '    Assert.assertEquals(new Cart().status(), "ANY");', '  }'],
      { before: ['public class OrderTest {'], after: ['}'] }),
  ]);
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

test('cheat_fp2_unittest_expected_value_is_not_a_message: an in-file expected-value change is not message-only', () => {
  const r = run(mkDiff('tests/test_slug.py', ['        self.assertEqual(slugify("A B"), "a-b")', '        self.assertEqual(slugify("C"), "c")'], ['        self.assertEqual(slugify("A B"), "")'],
    { before: ['class SlugTest(unittest.TestCase):', '    def test_slug(self):'] }));
  assert.ok(CAUGHT(r), show(r));
  assert.equal(hard(r, 'assertion-removed').length, 2, show(r));
});

const cartTestJ5 = ['package demo.cart;', 'import org.junit.jupiter.api.Test;', 'class CartTest {', '  @Test', '  void totals() {',
  '    assertEquals(7, new Cart(3, 4).total());', '    assertEquals(0, new Cart().total());', '    assertEquals(1, new Cart(1).lines());', '  }', '}'];
const movedChecks = ['    assertEquals(7, new Cart(3, 4).total());', '    assertEquals(0, new Cart().total());', '    assertEquals(1, new Cart(1).lines());'];

test('cheat_fp3_moved_under_class_level_disabled: @Disabled on the class switches the copies off', () => {
  const filler = Array.from({ length: 15 }, (_, i) => [`  @Test`, `  void other${i}() {`, `    assertEquals(${i}, Order.of(${i}).size());`, '  }']).flat();
  const r = run([
    mkDiff('src/test/java/demo/cart/CartTest.java', cartTestJ5, [], { status: 'deleted' }),
    mkDiff('src/test/java/demo/cart/OrderTest.java', [], ['package demo.cart;', 'import org.junit.jupiter.api.Disabled;', 'import org.junit.jupiter.api.Test;',
      '@Disabled', 'class OrderTest {', ...filler, '  @Test', '  void totals() {', ...movedChecks, '  }', '}'], { status: 'added' }),
  ]);
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

test('cheat_fp3_moved_under_module_pytestmark: pytestmark skip switches the whole module off', () => {
  const r = run([
    mkDiff('tests/test_slug.py', ['from app.text import slugify', '', 'def test_slug():', '    assert slugify("A B") == "a-b"', '    assert slugify("C") == "c"'], [], { status: 'deleted' }),
    mkDiff('tests/test_text.py', [], ['import pytest', 'from app.text import slugify', '', 'pytestmark = pytest.mark.skip(reason="later")', '',
      'def test_slug():', '    assert slugify("A B") == "a-b"', '    assert slugify("C") == "c"',
      // Enough unrelated tests that the new file is no move of the old one.
      ...Array.from({ length: 8 }, (_, i) => ['', `def test_title_${i}():`, `    assert titled("w${i}") == "W${i}"`]).flat()], { status: 'added' }),
  ]);
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
  assert.ok(hits(r, 'test-skipped').length > 0, show(r));
});

test('cheat_fp3_moved_under_describe_skip: the deleted file stays HARD, not only the skip', () => {
  const r = run([
    mkDiff('test/cart.test.js', ["import { total } from '../src/cart.js';", "it('sums', () => {", '  expect(total([3, 4])).toBe(7);', '});'], [], { status: 'deleted' }),
    mkDiff('test/order.test.js', [], ["describe.skip('cart', () => {", "  it('sums', () => {", '    expect(total([3, 4])).toBe(7);', '  });', '});'],
      { before: ["import { total } from '../src/cart.js';"] }),
  ]);
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

test('honest_fp3_moved_into_test_class: a pytest class named Test still counts', () => {
  const r = run([
    mkDiff('tests/test_slug.py', ['from app.text import slugify', '', 'def test_slug():', '    assert slugify("A B") == "a-b"'], [], { status: 'deleted' }),
    mkDiff('tests/test_text.py', [], ['', 'class TestSlug:', '    def test_slug(self):', '        assert slugify("A B") == "a-b"'], { before: ['from app.text import slugify'] }),
  ]);
  assert.equal(hits(r, 'test-deleted').length, 0, show(r));
});

test('cheat_fp4_macro_hides_java: a macro defined as -diff hides what it is applied to', () => {
  const found = hits(run(attrs(['*.jar binary', '[attr]vendored -diff -merge', '*.java vendored'])), 'diff-hidden');
  assert.equal(found.length, 1, found.map(f => f.after).join('\n'));
  assert.match(found[0].after, /\*\.java/);
  assert.equal(found[0].tier, 'HARD');
  // A macro built on a macro hides too, and one that only sets merge does not.
  assert.ok(allHard(hits(run(attrs(['[attr]quiet binary', '[attr]hush quiet', '*.kt hush'])), 'diff-hidden')));
  assert.equal(hits(run(attrs(['[attr]keepours merge=ours', '*.java keepours'])), 'diff-hidden').length, 0);
});

test('cheat_fp1_small_deleted_helper_does_not_excuse_the_rest: LegacyFormat goes, Cart stays', () => {
  const r = run([
    mkDiff('src/main/java/demo/fmt/LegacyFormat.java', ['package demo.fmt;', 'import demo.cart.Cart;', 'public final class LegacyFormat {', '  public static String of(Cart c) { return "" + c.total(); }', '}'], [], { status: 'deleted' }),
    mkDiff('src/test/java/demo/cart/CartTest.java', ['package demo.cart;', 'import demo.fmt.LegacyFormat;', 'import org.junit.jupiter.api.Test;', 'class CartTest {', '  @Test', '  void totals() {',
      '    Cart cart = new Cart(3, 4);', '    assertEquals(7, cart.total());', '    assertEquals(2, cart.lines());', '    assertEquals("7", LegacyFormat.of(cart));', '  }', '}'], [], { status: 'deleted' }),
  ]);
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

test('cheat_fp1_py_unrelated_namesake_deleted: scripts/legacy/cart.py is not the cart the test imports', () => {
  const r = run([
    mkDiff('tests/test_cart.py', ['from cart import Cart', '', 'def test_total():', '    assert Cart([3, 4]).total() == 7'], [], { status: 'deleted' }),
    mkDiff('scripts/legacy/cart.py', ['def old():', '    return 1'], [], { status: 'deleted' }),
  ]);
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

test('speed_fp2_big_rewrite: 3000 rewritten checks against 200 edited methods pair in under 2 s', () => {
  const svcRem = [];
  const svcAdd = [];
  for (let k = 0; k < 200; k++) {
    svcRem.push(`  static int calc${k}(int i) {`, `    return i + ${k};`, '  }');
    svcAdd.push(`  static int calc${k}(int i) {`, `    return i * ${k};`, '  }');
  }
  const rem = [];
  const add = [];
  for (let i = 0; i < 3000; i++) {
    rem.push(`    assertEquals(${i}, Svc.calc${i % 200}(${i}));`);
    add.push(`    assertEquals(${i + 1}, Svc.calc${i % 200}(${i}));`);
  }
  const t0 = Date.now();
  const r = run([
    mkDiff('src/main/java/demo/Svc.java', svcRem, svcAdd, { before: ['package demo;', 'public final class Svc {'], after: ['}'] }),
    mkDiff('src/test/java/demo/SvcTest.java', rem, add, { before: ['package demo;', 'class SvcTest {', '  @Test', '  void all() {'], after: ['  }', '}'] }),
  ]);
  const took = Date.now() - t0;
  assert.ok(took < 2000, `took ${took} ms`);
  assert.ok(onlySoft(hits(r, 'assertion-removed')), 'every rewrite still pairs');
});

test('honest_fp1_nested_namesake_added_elsewhere: a nested record Chip in another class does not bring Chip back', () => {
  const r = run([
    del('src/main/java/demo/ui/Chip.java', ['package demo.ui;', '', 'public final class Chip {', '  public static int width(String label) {', '    return label.length() * 6 + 4;', '  }', '}']),
    del('src/test/java/demo/ui/ChipTest.java', ['package demo.ui;', '', 'class ChipTest {', '  @Test', '  void widthGrowsWithLabel() {', '    assertNotNull(new Chip("a"));', '    assertEquals(16, Chip.width("ab"));', '  }', '}']),
    mkDiff('src/main/java/demo/smith/Cues.java', [], ['  public record Chip(String glyph, int tint) {}'], { before: ['package demo.smith;', '', 'public final class Cues {'], after: ['}'] }),
  ]);
  assert.ok(onlySoft(hits(r, 'test-deleted')), show(r));
});

test('cheat_fp1_top_level_namesake_added: a new top-level Chip is a move, so the test is still needed', () => {
  const r = run([
    del('src/main/java/demo/ui/Chip.java', ['package demo.ui;', '', 'public final class Chip {', '  public static int width(String label) {', '    return label.length() * 6 + 4;', '  }', '}']),
    del('src/test/java/demo/ui/ChipTest.java', ['package demo.ui;', '', 'class ChipTest {', '  @Test', '  void widthGrowsWithLabel() {', '    assertEquals(10, Chip.width("a"));', '  }', '}']),
    mkDiff('src/main/java/demo/hud/Chip.java', [], ['package demo.hud;', '', 'public final class Chip {', '  public static int width(String label) {', '    return label.length() * 6 + 4;', '  }', '}'], { status: 'added' }),
  ]);
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

test('honest_fp1_method_after_nested_type: a method below a nested enum belongs to the outer class', () => {
  const r = run([
    mkDiff('src/main/java/demo/ui/Gauge.java', ['  static float fill(int have, int max) {', '    return have / (float) max;', '  }'], [],
      { before: ['package demo.ui;', 'public final class Gauge {', '  enum Mode { BAR, RING }'], after: ['}'] }),
    mkDiff('src/test/java/demo/ui/GaugeTest.java', ['    assertEquals(0.5f, Gauge.fill(5, 10), 1e-6f);'], [], { before: ['package demo.ui;', 'class GaugeTest {', '  @Test', '  void fills() {'], after: ['  }', '}'] }),
  ]);
  assert.ok(onlySoft(hits(r, 'assertion-removed')), show(r));
});

const LEDGER = (added) => mkDiff('src/main/java/demo/cart/Ledger.java', ['  public static int balance() {'], [...added, '  public static int net() {'],
  { before: ['package demo.cart;', 'public class Ledger {'], after: ['    return sum;', '  }', '}'] });
const LEDGER_TEST = (check) => mkDiff('src/test/java/demo/cart/LedgerTest.java', ['    assertEquals(7, Ledger.balance());'], [check],
  { before: ['package demo.cart;', 'class LedgerTest {', '  @Test', '  void sums() {'], after: ['  }', '}'] });

test('cheat_fp2_rename_then_compare_to_type_limit: net() < Integer.MAX_VALUE holds for every int', () => {
  const r = run([LEDGER([]), LEDGER_TEST('    assertTrue(Ledger.net() < Integer.MAX_VALUE);')]);
  assert.ok(allHard(hits(r, 'assertion-weakened')), show(r));
});

test('cheat_fp2_rename_plus_constant_predicate: a new predicate that returns true checks nothing', () => {
  const r = run([LEDGER(['  public static boolean consistent() {', '    return true;', '  }']), LEDGER_TEST('    assertTrue(Ledger.consistent());')]);
  assert.ok(allHard(hits(r, 'assertion-weakened')), show(r));
});

test('honest_fp1_nested_interface_default_removed: Board.Surface station = ... then station.at(...)', () => {
  const r = run([
    mkDiff('src/main/java/demo/play/Board.java', ['        default double[] at(double u, double v) {', '            return new double[] {u, v};', '        }'], [],
      { before: ['public interface Board {', '    interface Surface {', '        void dot(double u, double v);'], after: ['    }'] }),
    mkDiff('src/test/java/demo/play/BoardTest.java', ['    @Test', '    void aPointReadsBack() {', '        Board.Surface station = new Board.Surface() {', '            @Override public void dot(double u, double v) {}', '        };',
      '        assertArrayEquals(new double[] {1, 2}, station.at(1, 2), EPS);', '    }'], [], { before: ['package demo.play;', 'class BoardTest {'], after: ['}'] }),
  ]);
  assert.ok(notCaught(r), show(r));
  assert.ok(onlySoft(hits(r, 'assertion-removed')), show(r));
});

test('honest_fp1_nested_record_factory_removed: the hunk does not show the record header', () => {
  const r = run([
    mkDiff('src/main/java/demo/smith/Cues.java', ['        static Context held(int heat) {', '            return new Context(heat, true);', '        }'], [],
      { before: ['        boolean holding() { return holding; }'], after: ['    }'] }),
    mkDiff('src/test/java/demo/smith/CuesTest.java', ['        Cues.Context ctx = Cues.Context.held(3);', '        assertTrue(ctx.holding());'], [],
      { before: ['package demo.smith;', 'class CuesTest {', '    @Test', '    void heldContext() {'], after: ['    }', '}'] }),
  ]);
  assert.ok(onlySoft(hits(r, 'assertion-removed')), show(r));
});

test('cheat_fp1_nested_method_kept: the nested default method survives, so the check is lost', () => {
  const r = run([
    mkDiff('src/main/java/demo/play/Board.java', ['            return new double[] {u, v};'], ['            return new double[] {v, u};'],
      { before: ['public interface Board {', '    interface Surface {', '        default double[] at(double u, double v) {'], after: ['        }'] }),
    mkDiff('src/test/java/demo/play/BoardTest.java', ['        assertArrayEquals(new double[] {1, 2}, station.at(1, 2), EPS);', '        assertArrayEquals(new double[] {3, 4}, station.at(3, 4), EPS);'], [],
      { before: ['package demo.play;', 'class BoardTest {', '    @Test', '    void aPointReadsBack() {', '        Board.Surface station = surface();'], after: ['    }', '}'] }),
  ]);
  assert.ok(CAUGHT(r), show(r));
});

test('honest_fp2_test_of_dropped_parameter: meshShift lost its scale, and the test of the scale went with it', () => {
  const r = run([
    mkDiff('src/main/java/demo/bench/Framing.java', ['  public static float[] meshShift(int u, int v, int w, int h, int canvas, float scale) {'], ['  public static float[] meshShift(int u, int v, int w, int h, int canvas) {'],
      { before: ['package demo.bench;', 'public final class Framing {'], after: ['    return new float[] {u - w / 2f, v - h / 2f};', '  }', '}'] }),
    mkDiff('src/test/java/demo/bench/FramingTest.java', ['  @Test', '  void theShiftScalesWithTheCanvas() {', '    float[] small = Framing.meshShift(4, 4, 2, 2, 16, 1f);',
      '    float[] big = Framing.meshShift(4, 4, 2, 2, 32, 0.5f);', '    assertEquals(small[0] / 2, big[0], 1e-6);', '    assertArrayEquals(new float[] {0f, 0f}, Framing.meshShift(1, 1, 2, 2, 32, 0.5f), 1e-6f);', '  }'], [],
      { before: ['package demo.bench;', 'class FramingTest {'], after: ['}'] }),
  ]);
  assert.ok(notCaught(r), show(r));
  assert.ok(onlySoft(hits(r, 'assertion-removed')), show(r));
});
