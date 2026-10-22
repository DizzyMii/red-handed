// The base and head trees handed to the engine: code the diff never shows, read from the files
// around it. honest_ cases must not be CAUGHT with trees (and stay as they were without, unless
// said); cheat_ cases keep a HARD finding with trees. All names are invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, hits, mkDiff, mkTrees } from './helpers.mjs';

const onlySoft = (found) => found.length > 0 && found.every(f => f.tier === 'SOFT');
const allHard = (found) => found.length > 0 && found.every(f => f.tier === 'HARD');
const hard = (r, rule) => hits(r, rule).filter(f => f.tier === 'HARD');
const show = (r) => r.findings.map(f => `${f.tier} ${f.rule} ${f.file}:${f.line} ${f.before ?? ''} | ${f.message}`).join('\n');
const SUFFIX = /The diff does not show this part of the change; the files at its head do\.$/;
const ALONE = /^judged on the diff alone: /;

// One file with hunks of prefixed lines: [{ at, lines: [' ctx', '-old', '+new'] }].
function mkRaw(path, hunks, { status = 'modified' } = {}) {
  const out = [`diff --git a/${path} b/${path}`];
  if (status === 'added') out.push('new file mode 100644');
  if (status === 'deleted') out.push('deleted file mode 100644');
  out.push(`--- ${status === 'added' ? '/dev/null' : 'a/' + path}`, `+++ ${status === 'deleted' ? '/dev/null' : 'b/' + path}`);
  let shift = 0;
  for (const { at, lines } of hunks) {
    const olds = lines.filter(l => l[0] !== '+').length;
    const news = lines.filter(l => l[0] !== '-').length;
    out.push(`@@ -${at},${olds} +${at + shift},${news} @@`, ...lines);
    shift += news - olds;
  }
  return out.join('\n') + '\n';
}
const del = (p, lines) => mkDiff(p, lines, [], { status: 'deleted' });
const add = (p, lines) => mkDiff(p, [], lines, { status: 'added' });
const pad = (name, n) => mkDiff(`assets/${name}.txt`, [], Array.from({ length: n }, (_, i) => 'x' + i), { status: 'added' });
const text = (lines) => lines.join('\n') + '\n';

// ---- (i) a ref the diff never shows, looked up in head ---------------------------------------

const RATES_TEST_LINES = ['    assertEquals(30, Rates.dailyRate(1));', '    assertEquals(60, Rates.dailyRate(2));'];
const RATES_DIFF = [
  mkDiff('src/main/java/demo/legacy/Rates.java', ['  public static int dailyRate(int days) {', '    return days * 30;', '  }'], [],
    { before: ['package demo.legacy;', 'public final class Rates {'], after: ['}'] }),
  mkDiff('src/test/java/demo/legacy/RatesTest.java', RATES_TEST_LINES, [], { before: ['  @Test', '  void rates() {'], after: ['    assertEquals(0, Rates.flat());', '  }'] }),
];
const RATES_BASE_TEST = text(['package demo.legacy;', '', 'import static org.junit.jupiter.api.Assertions.assertEquals;', 'import org.junit.jupiter.api.Test;', '',
  'class RatesTest {', '  @Test', '  void rates() {', ...RATES_TEST_LINES, '    assertEquals(0, Rates.flat());', '  }', '}']);
const RATES_TREES = () => mkTrees({
  base: {
    'src/main/java/demo/legacy/Rates.java': text(['package demo.legacy;', 'public final class Rates {', '  public static int dailyRate(int days) {', '    return days * 30;', '  }', '  public static int flat() {', '    return 0;', '  }', '}']),
    'src/test/java/demo/legacy/RatesTest.java': RATES_BASE_TEST,
  },
  head: {
    'src/main/java/demo/legacy/Rates.java': text(['package demo.legacy;', 'public final class Rates {', '  public static int flat() {', '    return 0;', '  }', '}']),
    'src/test/java/demo/legacy/RatesTest.java': text(['package demo.legacy;', 'class RatesTest {', '  @Test', '  void rates() {', '    assertEquals(0, Rates.flat());', '  }', '}']),
  },
});
const LEGACY = { ignore: ['src/main/java/demo/legacy/**'] };

test('honest_tc1_removed_method_in_an_ignored_folder: the head copy of Rates.java has no dailyRate', () => {
  const r = run(RATES_DIFF, LEGACY, { trees: RATES_TREES() });
  assert.equal(r.verdict, 'SUSPICIOUS', show(r));
  const found = hits(r, 'assertion-removed');
  assert.equal(found.length, 2, show(r));
  assert.ok(onlySoft(found), show(r));
  assert.match(found[0].message, /dailyRate/);
  assert.match(found[0].message, SUFFIX);
  assert.equal(r.verdict === 'CAUGHT', false);
  const alone = run(RATES_DIFF, LEGACY);
  assert.equal(alone.verdict, 'CAUGHT', show(alone));
});

const PERK_TESTS = del('src/main/java/demo/gametest/PerkGameTests.java', ['package demo.gametest;', '', 'import demo.perk.Lucky;', '', 'public class PerkGameTests {',
  '  @GameTest(template = "demo:empty")', '  public static void lucky(GameTestHelper helper) {',
  '    helper.assertTrue(Lucky.qualifies("iron_ore"), "iron ore is lucky");',
  '    helper.assertTrue(Lucky.qualifies("gold_ore"), "gold ore is lucky");',
  '    helper.assertTrue(!Lucky.qualifies("stone"), "stone is not");', '    helper.succeed();', '  }', '}']);
const LUCKY = del('src/main/java/demo/perk/Lucky.java', ['package demo.perk;', 'public final class Lucky {', '  static boolean qualifies(String block) {', '    return block.endsWith("_ore");', '  }', '}']);
const LUCKY_BASE = text(['package demo.perk;', 'public final class Lucky {', '  static boolean qualifies(String block) {', '    return block.endsWith("_ore");', '  }', '}']);

test('honest_tc1_removal_past_the_cut: Lucky.java is deleted past the cut, the trees say so', () => {
  const diff = [pad('a', 299900), PERK_TESTS, pad('b', 200), LUCKY];
  const r = run(diff, {}, { trees: mkTrees({ base: { 'src/main/java/demo/perk/Lucky.java': LUCKY_BASE }, head: {} }) });
  assert.ok(onlySoft(hits(r, 'test-deleted')), show(r));
  const alone = run(diff, {});
  assert.ok(allHard(hits(alone, 'test-deleted')), show(alone));
  assert.match(hits(alone, 'test-deleted')[0].message, /cut off at 300000 lines/);
});

const INSETS = del('src/main/java/demo/ui/Insets.java', ['package demo.ui;', 'public final class Insets {', '  public static Ui.Rect shrinkTop(Ui.Rect box, int by) {',
  '    return new Ui.Rect(box.x(), box.y() + by, box.w(), box.h() - by);', '  }', '}']);
const INSETS_TEST = del('src/test/java/demo/ui/InsetsTest.java', ['package demo.ui;', '', 'import demo.ui.Ui;', 'import org.junit.jupiter.api.Test;', '', 'class InsetsTest {',
  '  @Test', '  void shrinksTheTop() {', '    Ui.Rect box = new Ui.Rect(10, 20, 100, 80);', '    Ui.Rect cut = Insets.shrinkTop(box, 4);',
  '    assertEquals(box.y() + 4, cut.y());', '    assertEquals(box.h() - 4, cut.h());', '  }', '}']);
const uiTrees = (ui) => mkTrees({ base: { 'src/main/java/demo/ui/Ui.java': ui }, head: { 'src/main/java/demo/ui/Ui.java': ui } });

test('honest_tc1_record_accessor: box.y() reads a component of an untouched record', () => {
  const ui = text(['package demo.ui;', 'public final class Ui {', '  public record Rect(int x, int y, int w, int h) {}', '}']);
  const r = run([INSETS, INSETS_TEST], {}, { trees: uiTrees(ui) });
  assert.ok(onlySoft(hits(r, 'test-deleted')), show(r));
  assert.ok(r.verdict !== 'CAUGHT', show(r));
  assert.equal(run([INSETS, INSETS_TEST]).verdict, 'CAUGHT');
});

test('cheat_tc1_record_with_logic: an explicit accessor is code the check is about', () => {
  const ui = text(['package demo.ui;', 'public final class Ui {', '  public record Rect(int x, int y, int w, int h) { public int y() { return y + 1; } }', '}']);
  const r = run([INSETS, INSETS_TEST], {}, { trees: uiTrees(ui) });
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

const TOTALS_LINE = '    assertEquals(7, t.legacyTotal());';
const TOTALS_DIFF = [
  mkDiff('src/main/java/demo/legacy/Totals.java', ['  int legacyTotal() {', '    return 7;', '  }'], [], { before: ['package demo.legacy;', 'public class Totals {'] }),
  mkDiff('src/test/java/demo/legacy/TotalsTest.java', [TOTALS_LINE], [], { before: ['  @Test', '  void totals() {', '    Totals t = new Totals();'], after: ['    assertEquals(7, t.total());', '  }'] }),
];

test('honest_tc1_name_only_in_a_comment_and_a_string: neither is a declaration', () => {
  const trees = mkTrees({
    base: {
      'src/main/java/demo/legacy/Totals.java': text(['package demo.legacy;', 'public class Totals {', '  int legacyTotal() {', '    return 7;', '  }', '  int total() {', '    return 7;', '  }', '}']),
      'src/test/java/demo/legacy/TotalsTest.java': text(['package demo.legacy;', 'class TotalsTest {', '  @Test', '  void totals() {', '    Totals t = new Totals();', TOTALS_LINE, '    assertEquals(7, t.total());', '  }', '}']),
    },
    head: {
      'src/main/java/demo/legacy/Totals.java': text(['package demo.legacy;', 'public class Totals {', '  // int legacyTotal() { was folded into total()', '  static final String HINT = "legacyTotal()";',
        '  /* int legacyTotal() {', '     return 7;', '  } */', '  int total() {', '    return 7;', '  }', '}']),
    },
  });
  const r = run(TOTALS_DIFF, LEGACY, { trees });
  assert.ok(onlySoft(hits(r, 'assertion-removed')), show(r));
  assert.equal(r.verdict, 'SUSPICIOUS', show(r));
});

const EMBER_TESTS = (check) => del('src/main/java/demo/gametest/EmberGameTests.java', ['package demo.gametest;', '', 'import demo.Demo;', 'import demo.perk.PerkRegistry;', 'import demo.perk.Pricing;', 'import net.minecraft.gametest.framework.GameTestHelper;', 'import net.minecraft.resources.ResourceLocation;', '',
  'public class EmberGameTests {', '  private static final ResourceLocation EMBER =', '      ResourceLocation.fromNamespaceAndPath(Demo.MODID,', '              "ember_step");', '',
  '  @GameTest(template = "demo:empty")', '  public static void emberStep(GameTestHelper helper) {',
  '    boolean found = helper.getLevel().players().stream().anyMatch(p -> p.isAlive());', check,
  '    helper.assertTrue(found, "ember step adds the modifier");', '    helper.succeed();', '  }', '}']);
const EMBER_TREES = () => mkTrees({
  base: {
    'src/main/resources/data/demo/perks/ember_step.json': '{}\n',
    'src/main/java/demo/perk/PerkRegistry.java': text(['package demo.perk;', 'public final class PerkRegistry {', '  public Perk get(ResourceLocation id) {', '    return null;', '  }', '}']),
    'src/main/java/demo/perk/Pricing.java': text(['package demo.perk;', 'public final class Pricing {', '  public static int cost(Perk p) {', '    return 3;', '  }', '}']),
  },
  head: {
    'src/main/java/demo/perk/PerkRegistry.java': text(['package demo.perk;', 'public final class PerkRegistry {', '  public Perk get(ResourceLocation id) {', '    return null;', '  }', '}']),
    'src/main/java/demo/perk/Pricing.java': text(['package demo.perk;', 'public final class Pricing {', '  public static int cost(Perk p) {', '    return 3;', '  }', '}']),
  },
});
const RESOURCES = { ignore: ['src/main/resources/**'] };

test('honest_tc1_registry_lookup_of_removed_data: the buff JSON is gone from head', () => {
  const diff = EMBER_TESTS('    helper.assertTrue(PerkRegistry.INSTANCE.get(EMBER) != null, "ember step json not loaded");');
  const r = run(diff, RESOURCES, { trees: EMBER_TREES() });
  assert.ok(onlySoft(hits(r, 'test-deleted')), show(r));
  assert.match(hits(r, 'test-deleted')[0].message, /ember_step/);
  assert.equal(run(diff, RESOURCES).verdict, 'CAUGHT');
});

test('cheat_tc1_lookup_feeds_kept_logic: Pricing.cost of the looked-up perk stays', () => {
  const diff = EMBER_TESTS('    helper.assertTrue(Pricing.cost(PerkRegistry.INSTANCE.get(EMBER)) == 3, "ember step costs three");');
  const r = run(diff, RESOURCES, { trees: EMBER_TREES() });
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

const CART_TEST = del('src/test/java/demo/cart/CartTest.java', ['package demo.cart;', '', 'import org.junit.jupiter.api.Test;', '', 'class CartTest {', '  @Test', '  void totals() {',
  '    Cart cart = new Cart();', '    cart.add(7);', '    assertEquals(7, cart.total());', '  }', '}']);
const CART_RENAME = mkDiff('src/main/java/demo/cart/Cart.java', ['  public int total() {'], ['  public int sum() {'], { before: ['package demo.cart;', 'public class Cart {'], after: ['    return 7;', '  }'] });
const cartFile = (name) => text(['package demo.cart;', 'public class Cart {', '  public void add(int n) {', '  }', `  public int ${name}() {`, '    return 7;', '  }', '}']);

test('cheat_tc1_rename_to_dodge: total became sum and the test went', () => {
  const trees = mkTrees({ base: { 'src/main/java/demo/cart/Cart.java': cartFile('total') }, head: { 'src/main/java/demo/cart/Cart.java': cartFile('sum') } });
  const r = run([CART_RENAME, CART_TEST], {}, { trees });
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

test('cheat_tc1_rename_past_the_cut: the head copy shows the rename the diff cut off', () => {
  const trees = mkTrees({ base: { 'src/main/java/demo/cart/Cart.java': cartFile('total') }, head: { 'src/main/java/demo/cart/Cart.java': cartFile('sum') } });
  const r = run([pad('a', 299900), CART_TEST, pad('b', 200), CART_RENAME], {}, { trees });
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

test('cheat_tc1_namesake_deleted: a scratch Cart elsewhere does not make demo.cart.Cart gone', () => {
  const trees = mkTrees({ base: { 'src/main/java/demo/cart/Cart.java': cartFile('total'), 'tools/scratch/Cart.java': 'package tools.scratch; class Cart { int total() { return 0; } }\n' },
    head: { 'src/main/java/demo/cart/Cart.java': cartFile('total') } });
  const r = run([CART_TEST, del('tools/scratch/Cart.java', ['package tools.scratch; class Cart { int total() { return 0; } }'])], {}, { trees });
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

test('cheat_tc1_declaration_after_a_tricky_string: a "/*" inside a string does not open a comment', () => {
  const cart = text(['package demo.cart;', '/* real comment */', 'public class Cart {', '  /* real comment */',
    '    static final String DOCS = "http://example.test/*"; public int total() { return 7; }', '}']);
  const r = run([
    del('src/main/java/demo/cart/CartIds.java', ['package demo.cart;', 'final class CartIds {', '  static String id(Cart c) {', '    return "c";', '  }', '}']),
    del('src/test/java/demo/cart/CartTest.java', ['package demo.cart;', 'class CartTest {', '  @Test', '  void ids() {', '    Cart cart = new Cart();',
      '    assertEquals("c-7", CartIds.id(cart) + "-" + cart.total());', '  }', '}']),
  ], {}, { trees: mkTrees({ base: { 'src/main/java/demo/cart/Cart.java': cart }, head: { 'src/main/java/demo/cart/Cart.java': cart } }) });
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

test('cheat_tc1_record_next_to_an_edited_partner: a neutral ref next to an edited one blocks', () => {
  const testLine = '    assertEquals(Limits.MAX - 1, Limits.left(new Basket(1)));';
  const diff = [
    mkRaw('src/main/java/demo/shop/Limits.java', [{ at: 1, lines: [' package demo.shop;', ' public final class Limits {', '-  public static final int MAX = 50;', '   static int left(Basket b) {', '-    return MAX - b.count();', '+    return 50;', '   }'] }]),
    mkRaw('src/test/java/demo/shop/LimitsTest.java', [{ at: 20, lines: ['   @Test', '   void left() {', '-' + testLine, '     assertEquals(0, Limits.left(new Basket(50)));', '   }'] }]),
  ];
  const basket = 'package demo.shop;\npublic record Basket(int count) {}\n';
  const trees = mkTrees({
    base: { 'src/main/java/demo/shop/Basket.java': basket,
      'src/test/java/demo/shop/LimitsTest.java': text(['package demo.shop;', 'class LimitsTest {', '  @Test', '  void left() {', testLine, '    assertEquals(0, Limits.left(new Basket(50)));', '  }', '}']) },
    head: { 'src/main/java/demo/shop/Basket.java': basket },
  });
  const r = run(diff, {}, { trees });
  assert.ok(allHard(hits(r, 'assertion-removed')), show(r));
});

// ---- (ii) a test file read whole from base ---------------------------------------------------

test('honest_tc2_own_constant_above_the_hunk: ROOT is the test\'s own constant, not Roots.ROOT', () => {
  const diff = [
    mkDiff('src/main/java/demo/sets/SetState.java', ['  static boolean complete(Id id) {', '    return id != null;', '  }'], [], { before: ['package demo.sets;', 'public final class SetState {'], after: ['}'] }),
    mkRaw('src/main/java/demo/sets/Roots.java', [{ at: 1, lines: [' package demo.sets;', ' public final class Roots {', '-  // the root of every set', '+  // the root every set hangs off', '   public static final Id ROOT = Id.of("r");', ' }'] }]),
    mkRaw('src/test/java/demo/sets/SetStateTest.java', [{ at: 80, lines: ['   @Test', '   void completes() {', '-    assertFalse(SetState.complete(ROOT));', '-    assertTrue(SetState.complete(CHILD));', '     assertTrue(true);', '   }'] }]),
  ];
  const base = text(['package demo.sets;', 'class SetStateTest {', '  private static final Id ROOT = Id.of("root");', '  private static final Id CHILD = Id.of("root/child");',
    ...Array.from({ length: 76 }, () => ''), '  @Test', '  void completes() {', '    assertFalse(SetState.complete(ROOT));', '    assertTrue(SetState.complete(CHILD));', '    assertTrue(true);', '  }', '}']);
  const r = run(diff, {}, { trees: mkTrees({ base: { 'src/test/java/demo/sets/SetStateTest.java': base } }) });
  assert.ok(onlySoft(hits(r, 'assertion-removed')), show(r));
  assert.equal(run(diff).verdict, 'CAUGHT');
});

const BRUSH_REMOVED = ['  @Test', '  void layersReadTheirPixel() {', '    Canvas.Layer layer = new Canvas.Layer() {', '      public double[] base() { return new double[] {0, 0}; }', '    };',
  '    assertArrayEquals(new double[] {1, 2}, layer.at(1, 2), EPS);', '  }', ''];
const BRUSH_DIFF = [
  mkRaw('src/main/java/demo/paint/pool/Canvas.java', [{ at: 1, lines: [' package demo.paint.pool;', ' public final class Canvas {', '   public interface Layer {', '     double[] base();',
    '-    default double[] at(double u, double v) {', '-      return new double[] {u, v};', '-    }', '   }', ' }'] }]),
  mkRaw('src/test/java/demo/paint/BrushTest.java', [{ at: 30, lines: [' class BrushTest {', ...BRUSH_REMOVED.map(l => '-' + l), '   @Test', '   void paints() {', '     assertTrue(true);'] }]),
];
const BRUSH_BASE = text(['package demo.paint;', '', 'import demo.paint.pool.Canvas;', 'import org.junit.jupiter.api.Test;', '', 'class BrushTest {', '  static final double EPS = 1e-9;',
  ...BRUSH_REMOVED, '  @Test', '  void paints() {', '    assertTrue(true);', '  }', '}']);

test('honest_tc2_import_above_the_hunk: Canvas comes from demo.paint.pool, where at() went', () => {
  const r = run(BRUSH_DIFF, {}, { trees: mkTrees({ base: { 'src/test/java/demo/paint/BrushTest.java': BRUSH_BASE } }) });
  assert.ok(onlySoft(hits(r, 'assertion-removed')), show(r));
  assert.ok(onlySoft(hits(r, 'test-unregistered')), show(r));
  assert.equal(run(BRUSH_DIFF).verdict, 'CAUGHT');
});

test('cheat_tc2_import_points_elsewhere: the test imports demo.cart.Cart, which keeps total()', () => {
  const diff = [
    mkDiff('src/main/java/demo/legacy/Cart.java', ['  int total() {', '    return 7;', '  }'], [], { before: ['package demo.legacy;', 'public class Cart {'], after: ['}'] }),
    mkRaw('src/test/java/demo/shop/CheckoutTest.java', [{ at: 12, lines: ['   void checksOut() {', '     Cart cart = new Cart();', '-    assertEquals(7, cart.total());', '     assertTrue(true);', '   }'] }]),
  ];
  const trees = mkTrees({
    base: { 'src/test/java/demo/shop/CheckoutTest.java': text(['package demo.shop;', '', 'import demo.cart.Cart;', 'class CheckoutTest {', '  @Test', '  void checksOut() {', '    Cart cart = new Cart();', '    assertEquals(7, cart.total());', '    assertTrue(true);', '  }', '}']),
      'src/main/java/demo/cart/Cart.java': cartFile('total') },
    head: { 'src/main/java/demo/cart/Cart.java': cartFile('total') },
  });
  const r = run(diff, {}, { trees });
  assert.ok(allHard(hits(r, 'assertion-removed')), show(r));
});

test('cheat_tc2_own_helper_named_like_the_removed_method: total(cart) is the test\'s helper', () => {
  const diff = [
    mkDiff('src/main/java/demo/shop/Pricing.java', ['  static int total(Cart c) {', '    return c.sum();', '  }'], [], { before: ['package demo.shop;', 'public final class Pricing {'], after: ['}'] }),
    mkRaw('src/test/java/demo/shop/PricingTest.java', [{ at: 12, lines: ['   void prices() {', '-    assertEquals(7, total(cart));', '     assertTrue(true);', '   }'] }]),
  ];
  const trees = mkTrees({
    base: { 'src/test/java/demo/shop/PricingTest.java': text(['package demo.shop;', 'class PricingTest {', '  private static int total(Cart c) { return c.sum(); }', '  final Cart cart = new Cart();',
      '  @Test', '  void prices() {', '    assertEquals(7, total(cart));', '    assertTrue(true);', '  }', '}']),
      'src/main/java/demo/shop/Cart.java': text(['package demo.shop;', 'public class Cart {', '  int sum() {', '    return 7;', '  }', '}']) },
    head: { 'src/main/java/demo/shop/Cart.java': text(['package demo.shop;', 'public class Cart {', '  int sum() {', '    return 7;', '  }', '}']) },
  });
  const r = run(diff, {}, { trees });
  assert.ok(allHard(hits(r, 'assertion-removed')), show(r));
});

// ---- (iii) moved tests -----------------------------------------------------------------------

const OLD_TS_TEST = del('src/app/chat/test/sideCommand.contribution.test.ts', [
  "import * as assert from 'assert';", "import { SideCommandContribution } from '../sideCommand.contribution.js';", '',
  "suite('SideCommandContribution', () => {", "  test('runs the side command', () => {", '    const c = new SideCommandContribution(fakeHost());',
  "    assert.deepStrictEqual(c.parse('/side a'), { name: 'a' });", "    assert.deepStrictEqual(c.parse('/side b c'), { name: 'b', rest: 'c' });",
  "    assert.strictEqual(c.parse('side'), undefined);", "    assert.strictEqual(c.enabled, true);", "    assert.deepStrictEqual(c.names(), ['side']);", '  });', '});']);
const OLD_TS_SRC = del('src/app/chat/sideCommand.contribution.ts', ["import { Base } from '../base.js';", 'export class SideCommandContribution extends Base {', '  parse(text) { return undefined; }', '}']);
// The new home was rewritten as it moved, so it is not folded into a rename of the old one.
const NEW_TS_SRC = add('src/core/chat/sideCommand.ts', ["import { Core } from './core.js';", '', 'export class SideCommandContribution extends Core {',
  '  constructor(host) {', '    super(host);', "    this.enabled = host.config.get('side') !== false;", '  }', '',
  '  parse(text) {', "    const m = /^\\/side\\s+(\\S+)(?:\\s+(.*))?$/.exec(text);", '    return m ? { name: m[1], rest: m[2] } : undefined;', '  }', '',
  "  names() { return ['side']; }", '}']);
const newTsTest = ({ imports = "import { SideCommandContribution } from '../sideCommand.js';", body = (i) => [`    assert.deepStrictEqual(c.parse('/side ${i}'), { name: '${i}' });`], make = '  return new SideCommandContribution(fakeHost());' } = {}) =>
  add('src/core/chat/test/sideCommand.test.ts', ["import * as assert from 'assert';", imports, '',
    "suite('SideCommandContribution', () => {", '  function setup() {', make, '  }',
    ...[1, 2, 3, 4, 5, 6].flatMap(i => [`  test('case ${i}', () => {`, '    const c = setup();', ...body(i), '  });']), '});']);

test('honest_tc3_code_and_test_moved_together: the contribution and its test moved to core', () => {
  for (const trees of [undefined, mkTrees({})]) {
    const r = run([OLD_TS_SRC, OLD_TS_TEST, NEW_TS_SRC, newTsTest()], {}, trees ? { trees } : {});
    assert.equal(r.verdict, 'SUSPICIOUS', show(r));
    const found = hits(r, 'test-deleted');
    assert.ok(onlySoft(found), show(r));
    assert.match(found[0].message, /moved to src\/core\/chat\/sideCommand\.ts\. src\/core\/chat\/test\/sideCommand\.test\.ts is a new test of that code with 6 checks/);
  }
});

test('cheat_tc3_same_name_no_checks: six empty tests are not a new test of the code', () => {
  const r = run([OLD_TS_SRC, OLD_TS_TEST, NEW_TS_SRC, newTsTest({ body: () => [] })]);
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

test('cheat_tc3_only_weak_checks: assert.ok(contribution) six times', () => {
  const r = run([OLD_TS_SRC, OLD_TS_TEST, NEW_TS_SRC, newTsTest({ body: () => ['    assert.ok(c);'] })]);
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

test('cheat_tc3_new_test_of_something_else: the new test names the moved class only in a comment', () => {
  const r = run([OLD_TS_SRC, OLD_TS_TEST, NEW_TS_SRC, newTsTest({ imports: "import { Other } from '../other.js';", make: '  // was new SideCommandContribution(fakeHost())\n+  return new Other();' })]);
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

const GAUGE_CHECKS = ['    assertEquals(0.5f, Gauge.fill(5, 10), 1e-6f);', '    assertEquals(1f, Gauge.fill(10, 10), 1e-6f);'];
const GAUGE_DIFF = [
  del('src/main/java/demo/hud/Gauge.java', ['package demo.hud;', 'final class Gauge {', '  static float fill(int a, int b) {', '    return a / (float) b;', '  }', '}']),
  mkDiff('src/main/java/demo/hud/HudPanel.java', [], ['  static float fill(int a, int b) {', '    return a / (float) b;', '  }'], { before: ['package demo.hud;', 'final class HudPanel {'], after: ['}'] }),
  del('src/test/java/demo/hud/GaugeTest.java', ['package demo.hud;', 'import org.junit.jupiter.api.Test;', 'class GaugeTest {', '  @Test', '  void fills() {', ...GAUGE_CHECKS, '  }', '}']),
];
const hudPanelTest = (disabled) => text(['package demo.hud;', 'import org.junit.jupiter.api.Test;', 'class HudPanelTest {',
  ...(disabled ? ['  @Disabled'] : []), '  @Test', '  void half() {', '    assertEquals(0.5f, HudPanel.fill(5, 10), 1e-6f);', '  }',
  ...(disabled ? ['  @Disabled'] : []), '  @Test', '  void full() {', '    assertEquals(1f, HudPanel.fill(10, 10), 1e-6f);', '  }', '}']);
const hudTrees = (disabled) => mkTrees({ base: { 'src/test/java/demo/hud/HudPanelTest.java': hudPanelTest(disabled) }, head: { 'src/test/java/demo/hud/HudPanelTest.java': hudPanelTest(disabled) } });

test('honest_tc3_checks_already_in_head: HudPanelTest already runs both checks', () => {
  const r = run(GAUGE_DIFF, {}, { trees: hudTrees(false) });
  assert.equal(hits(r, 'test-deleted').length, 0, show(r));
});

// The diff alone says SOFT here (Gauge is deleted with its test). A head copy that does not run
// may not clear it, and may not make it any softer than that.
test('cheat_tc3_head_copy_disabled: the copies in head are switched off', () => {
  const alone = hits(run(GAUGE_DIFF), 'test-deleted');
  const found = hits(run(GAUGE_DIFF, {}, { trees: hudTrees(true) }), 'test-deleted');
  assert.equal(found.length, 1);
  assert.deepEqual(found.map(f => f.tier), alone.map(f => f.tier));
});

test('cheat_tc3_moved_copy_in_test_resources: a copy the build never compiles', () => {
  const checks = ['    assertEquals(7, new Cart().total());', '    assertEquals(0, new Cart().count());', '    assertEquals(1, new Cart().lines());'];
  const diff = [
    del('src/main/java/demo/cart/Cart.java', ['package demo.cart;', 'public class Cart {', '  int total() { return 7; }', '  int count() { return 0; }', '  int lines() { return 1; }', '}']),
    add('src/main/java/demo/cart/v2/Cart.java', ['package demo.cart.v2;', 'public class Cart {', '  int total() { return 7; }', '  int count() { return 0; }', '  int lines() { return 1; }', '}']),
    del('src/test/java/demo/cart/CartTest.java', ['package demo.cart;', 'class CartTest {', '  @Test', '  void counts() {', ...checks, '  }', '}']),
    add('src/test/resources/demo/cart/v2/CartTest.java', ['package demo.cart.v2;', 'import demo.cart.v2.Cart;', 'class CartTest {', '  @Test', '  void counts() {', ...checks, '  }', '}']),
  ];
  assert.ok(allHard(hits(run(diff), 'test-deleted')), show(run(diff)));
  const copy = text(['package demo.cart.v2;', 'import demo.cart.v2.Cart;', 'class CartTest {', '  @Test', '  void counts() {', ...checks, '  }', '}']);
  const r = run(diff, {}, { trees: mkTrees({ head: { 'src/test/resources/demo/cart/v2/CartTest.java': copy } }) });
  assert.ok(allHard(hits(r, 'test-deleted')), show(r));
});

// ---- (iv) a changed signature read from head -------------------------------------------------

const GRID_SRC = mkDiff('src/main/java/demo/bench/Grid.java', ['  public static boolean[][] shrink(boolean[][] mask, int k) {', '        if (k <= 1) return mask;'],
  ['  public static boolean[][] shrink(boolean[][] mask, int dx, int dy, int k, int size) {'], { before: ['package demo.bench;', 'public final class Grid {'], after: ['    return mask;', '  }'] });
const gridTest = (added) => mkRaw('src/test/java/demo/bench/GridTest.java', [{ at: 10, lines: [
  '     @Test',
  '-    void halvesAMask() {', '-        boolean[][] mask = new boolean[4][4];',
  ...[0, 1, 2, 3, 4].map(i => `-        assertFalse(Grid.shrink(mask, 2)[${i % 2}][${i % 2}]);`), '-    }', '-',
  '-    @Test', '-    void oneLeavesItAlone() {', '-        boolean[][] mask = new boolean[2][2];', '-        assertSame(mask, Grid.shrink(mask, 1));',
  ...added.map(l => '+' + l), '     }'] }]);
const GRID_ADDED = ['    void anOffsetSpriteLandsOnTheBakedTexels() {', '        boolean[][] sprite = new boolean[16][16];', '        boolean[][] want = new boolean[16][16];',
  '        for (int x = 0; x < 16; x++) {', '            for (int y = 0; y < 16; y++) {', '                want[x][y] = false;', '            }', '        }',
  '        assertArrayEquals(want, Grid.shrink(sprite, 1, 3, 2, 16));'];
const GRID_HEAD = text(['package demo.bench;', 'public final class Grid {', '  public static boolean[][] shrink(boolean[][] mask, int dx, int dy, int k, int size) {', '    return mask;', '  }', '}']);

test('honest_tc4_new_test_under_an_aligned_annotation: git lined the new test up under the old @Test', () => {
  for (const extra of [{}, { trees: mkTrees({ base: {}, head: { 'src/main/java/demo/bench/Grid.java': GRID_HEAD } }) }]) {
    const r = run([GRID_SRC, gridTest(GRID_ADDED)], {}, extra);
    assert.equal(r.verdict, 'SUSPICIOUS', show(r));
    const unreg = hits(r, 'test-unregistered');
    assert.ok(onlySoft(unreg), show(r));
    assert.match(unreg[0].message, /replaced in the same change that renamed or re-shaped shrink/);
    assert.ok(onlySoft(hits(r, 'assertion-removed')), show(r));
  }
});

test('cheat_tc4_new_call_only_in_a_comment: the new method names shrink in a comment and checks nothing', () => {
  const r = run([GRID_SRC, gridTest(['    void anOffsetSpriteLandsOnTheBakedTexels() {', '        // Grid.shrink(sprite, 1, 3, 2, 16) is covered by the bake test'])]);
  assert.ok(allHard(hits(r, 'test-unregistered')), show(r));
});

const REFINE_DIFF = (checks) => [
  mkDiff('src/main/java/demo/refine/Refine.java', ['  static String refusal(Item item, int n, boolean b, String s) {'], ['  static String refusal(Item item, String s) {'],
    { before: ['package demo.refine;', 'public final class Refine {'], after: ['    return s;'] }),
  mkDiff('src/test/java/demo/refine/RefineTest.java', checks.map(([obj, n, b, s]) => `    assertEquals("${s}", Refine.refusal(${obj}, ${n}, ${b}, "${s}"));`),
    checks.map(([obj, , , s]) => `    assertEquals("${s}", Refine.refusal(${obj}, "${s}"));`), { before: ['  @Test', '  void refuses() {'], after: ['  }'] }),
];
const REFINE_CHECKS = [['PEBBLE', 1, true, 'too small'], ['BOULDER', 9, true, 'too big'], ['STICK', 1, false, 'wrong kind']];
const refineHead = (extra) => text(['package demo.refine;', 'public final class Refine {', '  static String refusal(Item item, String s) {', '    return s;', '  }', ...extra, '}']);

test('honest_tc4_lost_parameter_confirmed: head has only the two-parameter refusal', () => {
  const diff = REFINE_DIFF(REFINE_CHECKS);
  const alone = run(diff);
  const r = run(diff, {}, { trees: mkTrees({ head: { 'src/main/java/demo/refine/Refine.java': refineHead([]) } }) });
  assert.notEqual(r.verdict, 'CAUGHT', show(r));
  assert.deepEqual(r.findings.map(f => [f.rule, f.tier, f.line]), alone.findings.map(f => [f.rule, f.tier, f.line]));
});

test('cheat_tc4_old_overload_outside_the_hunk: a four-parameter refusal is still in head', () => {
  const diff = REFINE_DIFF(REFINE_CHECKS);
  const head = refineHead(['', '  static String refusal(Tool t, int level, boolean oiled, String key) {', '    return key;', '  }']);
  const r = run(diff, {}, { trees: mkTrees({ head: { 'src/main/java/demo/refine/Refine.java': head } }) });
  assert.ok(hard(r, 'assertion-removed').length > 0, show(r));
});

test('cheat_tc4_grown_signature_drops_checks: one rewrite pair and two checks gone, with trees', () => {
  const head = text(['package demo.cart;', 'public class Pricing {', '  static int total(Cart cart, String currency) {', '    return cart.sum();', '  }', '}']);
  const r = run([
    mkDiff('src/main/java/demo/cart/Pricing.java', ['  static int total(Cart cart) {'], ['  static int total(Cart cart, String currency) {'], { before: ['package demo.cart;', 'public class Pricing {'], after: ['    return cart.sum();'] }),
    mkDiff('src/test/java/demo/cart/PricingTest.java', ['    assertEquals(7, Pricing.total(a));', '    assertEquals(9, Pricing.total(b));', '    assertEquals(0, Pricing.total(empty));'],
      ['    assertEquals(7, Pricing.total(a, "EUR"));'], { before: ['  @Test', '  void totals() {'], after: ['  }'] }),
  ], {}, { trees: mkTrees({ head: { 'src/main/java/demo/cart/Pricing.java': head } }) });
  assert.equal(hard(r, 'assertion-removed').length, 2, show(r));
});

// ---- the note, and what is read ---------------------------------------------------------------

test('hook_diff_alone_note: a lookup without trees says the diff was judged alone', () => {
  const r = run(RATES_DIFF, LEGACY);
  assert.equal(r.notes.filter(n => ALONE.test(n)).length, 1, r.notes.join('\n'));
  assert.deepEqual(run(mkDiff('src/a.js', ['a'], ['b'])).notes, []);
  assert.equal(run(RATES_DIFF, LEGACY, { trees: RATES_TREES() }).notes.filter(n => ALONE.test(n)).length, 0);
});

test('hook_unknown_reads_change_nothing: a listing nobody has leaves the diff-only answer', () => {
  const r = run(RATES_DIFF, LEGACY, { trees: mkTrees({}, { listed: false }) });
  assert.equal(r.verdict, 'CAUGHT', show(r));
});

// Views over Maps, as PR mode fills them: nothing listed, anything not fetched unknown.
const mapTrees = (base = new Map(), head = new Map()) => {
  const view = (m) => ({ capped: false, list: () => null, read: (p) => (m.has(p) ? m.get(p) : undefined) });
  return { base: view(base), head: view(head) };
};

test('hook_plan_reads_in_rounds: the whole test first, then nothing more once it settles the line', async () => {
  const { planReads } = await import('../src/scan.mjs');
  const { mkSource } = await import('./helpers.mjs');
  const brush = 'src/test/java/demo/paint/BrushTest.java';
  const base = new Map();
  const source = mkSource(BRUSH_DIFF.join(''), { trees: mapTrees(base) });
  const first = planReads(source, {});
  assert.deepEqual(first.base, [brush]);
  base.set(brush, BRUSH_BASE);
  const second = planReads(source, {});
  assert.deepEqual(second.base, []);
  assert.deepEqual(planReads(source, {}), second);
});

test('hook_plan_reads_nothing_for_a_clean_diff: no removed check, no reads', async () => {
  const { planReads } = await import('../src/scan.mjs');
  const { mkSource } = await import('./helpers.mjs');
  const want = planReads(mkSource(mkDiff('src/a.js', ['a'], ['b']), { trees: mapTrees() }), {});
  assert.deepEqual(want, { base: [], head: [], lists: { base: false, head: false } });
});
