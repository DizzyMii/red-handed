import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff } from '../src/diff.mjs';
import { declarationsOn, sourceIndex, refsOf, subjectRefs, dropMessage, moveKey, testContext, splitTop, codeOnly, indexText } from '../src/symbols.mjs';
import { mkDiff } from './helpers.mjs';

const ctxOf = (...diffs) => ({ files: parseDiff(diffs.join('')).files, config: { tests: [] } });
const fileOf = (ctx, p) => ctx.files.find(f => (f.newPath ?? f.oldPath) === p);
const names = (text, lang) => declarationsOn(text, lang).map(d => `${d.kind}:${d.name}${d.arity == null ? '' : '/' + d.arity}`);

test('jvm declarations: types, methods with arity, final fields and enum constants', () => {
  assert.deepEqual(names('public final class LuckyFind {', 'jvm'), ['type:LuckyFind']);
  assert.deepEqual(names('  static boolean qualifies(String block) {', 'jvm'), ['fn:qualifies/1']);
  assert.deepEqual(names('  public static <T> List<T> layout(Map<String, T> m, int a) {', 'jvm'), ['fn:layout/2']);
  assert.deepEqual(names('  void reset() {', 'jvm'), ['fn:reset/0']);
  assert.deepEqual(names('  public static final int TAB_COUNT = 4;', 'jvm'), ['field:TAB_COUNT']);
  assert.deepEqual(names('  EMBER_STEP,', 'jvm'), ['field:EMBER_STEP']);
  assert.deepEqual(names('    if (x) {', 'jvm'), []);
  assert.deepEqual(names('    } else if (x) {', 'jvm'), []);
  assert.deepEqual(names('    return compute(a) {', 'jvm'), []);
  assert.deepEqual(names('  // static int gone(int a) {', 'jvm'), []);
  assert.deepEqual(names('  fun total(cart: Cart): Int {', 'jvm'), ['fn:total/1']);
  assert.deepEqual(names('  public static @Nullable String refusal(ItemCounters c, int stars, @Nullable String key) {', 'jvm'), ['fn:refusal/3']);
  assert.deepEqual(names('  @Deprecated public static final int MAX = 3;', 'jvm'), ['field:MAX']);
});

test('js, py, go and rust declarations', () => {
  assert.deepEqual(names('export function toCsv(rows, sep) {', 'js'), ['fn:toCsv/2']);
  assert.deepEqual(names('export const REPLY_WINDOW_MS = 120000;', 'js'), ['field:REPLY_WINDOW_MS']);
  assert.deepEqual(names('const total = (cart) => cart.sum;', 'js'), ['fn:total/1']);
  assert.deepEqual(names('export class Cart {', 'js'), ['type:Cart']);
  assert.deepEqual(names('  async load(id, opts) {', 'js'), ['fn:load/2']);
  assert.deepEqual(names('  if (ready) {', 'js'), []);
  assert.deepEqual(names('export { a, b as c };', 'js'), ['field:a', 'field:c']);
  assert.deepEqual(names('def slugify(self, text):', 'py'), ['fn:slugify/1']);
  assert.deepEqual(names('MAX_LEN = 40', 'py'), ['field:MAX_LEN']);
  assert.deepEqual(names('func (c *Cart) Total(x int) int {', 'go'), ['fn:Total/1']);
  assert.deepEqual(names('pub fn total(cart: &Cart) -> u32 {', 'rust'), ['fn:total/1']);
});

const LAYOUT = mkDiff('src/main/java/demo/ui/ShelfLayout.java', [
  '  public static final int TAB_COUNT = 4;',
  '  static int tabWidth(int i) { return 4; }',
], [], { before: ['package demo.ui;', 'public class ShelfLayout {'], after: ['  static int rows() {'] });

test('gone: a removed field resolves through the test package and counts as gone', () => {
  const ctx = ctxOf(LAYOUT, mkDiff('src/test/java/demo/ui/ShelfLayoutTest.java', ['    assertEquals(4, ShelfLayout.TAB_COUNT);'], [], { before: ['package demo.ui;'] }));
  const t = fileOf(ctx, 'src/test/java/demo/ui/ShelfLayoutTest.java');
  const refs = subjectRefs(ctx, t, '    assertEquals(4, ShelfLayout.TAB_COUNT);');
  assert.deepEqual(refs.map(r => `${r.name}:${r.status}`), ['TAB_COUNT:gone']);
  assert.equal(refs[0].file, 'src/main/java/demo/ui/ShelfLayout.java');
  // rows() is declared as context, so it survives.
  assert.deepEqual(subjectRefs(ctx, t, 'assertEquals(2, ShelfLayout.rows());').map(r => r.status), ['kept']);
});

test('gone: a namesake in another package does not count', () => {
  const ctx = ctxOf(LAYOUT, mkDiff('src/test/java/demo/shop/ShopTest.java', ['    assertEquals(4, ShelfLayout.TAB_COUNT);'], [], { before: ['package demo.shop;'] }));
  const t = fileOf(ctx, 'src/test/java/demo/shop/ShopTest.java');
  assert.deepEqual(subjectRefs(ctx, t, 'assertEquals(4, ShelfLayout.TAB_COUNT);').map(r => r.status), ['kept']);
  // An import of the right class fixes the owner.
  const ctx2 = ctxOf(LAYOUT, mkDiff('src/test/java/demo/shop/ShopTest.java', ['    assertEquals(4, ShelfLayout.TAB_COUNT);'], [], { before: ['package demo.shop;', 'import demo.ui.ShelfLayout;'] }));
  const t2 = fileOf(ctx2, 'src/test/java/demo/shop/ShopTest.java');
  assert.deepEqual(subjectRefs(ctx2, t2, 'assertEquals(4, ShelfLayout.TAB_COUNT);').map(r => r.status), ['gone']);
});

test('gone: an overload with another arity does not save a call, one with the same arity does', () => {
  const eight = 'int a, int b, int c, int d, int e, int f, int g, int h';
  const seven = 'int a, int b, int c, int d, int e, int f, int g';
  const src = (kept) => mkDiff('src/main/java/demo/bench/Bench.java', [`  static int layout(${eight}) {`], [], { before: ['package demo.bench;', 'class Bench {'], after: [`  static int layout(${kept}) {`] });
  const call = 'assertEquals(3, Bench.layout(1, 2, 3, 4, 5, 6, 7, 8));';
  const test8 = mkDiff('src/test/java/demo/bench/BenchTest.java', [call], [], { before: ['package demo.bench;'] });
  let ctx = ctxOf(src(seven), test8);
  assert.equal(subjectRefs(ctx, fileOf(ctx, 'src/test/java/demo/bench/BenchTest.java'), call)[0].status, 'gone');
  ctx = ctxOf(src(eight.replace('h', 'z')), test8);
  assert.equal(subjectRefs(ctx, fileOf(ctx, 'src/test/java/demo/bench/BenchTest.java'), call)[0].status, 'kept');
});

test('renamed, arityChanged and touched', () => {
  const ctx = ctxOf(
    mkDiff('src/main/java/demo/tide/TideClock.java', ['  static int bonusTurnsAfterCashOut(int n) {'], ['  static boolean grantsBonus(int n) {'], { before: ['package demo.tide;', 'class TideClock {'] }),
    mkDiff('src/main/java/demo/refine/Refine.java', ['  static String refusal(Item item, int n, boolean b, String s) {'], ['  static String refusal(Item item, String s) {'], { before: ['package demo.refine;', 'class Refine {'] }),
    mkDiff('src/main/java/demo/anvil/AnvilSession.java', ['  // the id of the session'], ['  // the session id, 0 when idle'], { before: ['package demo.anvil;', 'class AnvilSession {'], after: ['  int sessionId() {'] }),
  );
  const idx = sourceIndex(ctx);
  const own = (owner) => (d) => d.owner === owner;
  assert.equal(idx.renamed('bonusTurnsAfterCashOut', own('TideClock')), 'grantsBonus');
  assert.equal(idx.renamed('refusal', own('Refine')), null);
  assert.deepEqual(idx.arityChanged('refusal', own('Refine')), { from: new Set([4]), to: new Set([2]) });
  assert.equal(idx.touched('refusal', own('Refine')), true);
  // A comment edit next to a declaration is not a touch.
  assert.equal(idx.touched('sessionId', own('AnvilSession')), false);
  assert.equal(idx.newlyDeclared('grantsBonus'), true);
  assert.equal(idx.newlyDeclared('sessionId'), false);
});

test('deleted sources: really gone unless a type of the same name is added elsewhere', () => {
  const delBody = (p) => mkDiff(p, ['package demo.cart;', 'public class Cart {', '  int total() { return 7; }', '}'], [], { status: 'deleted' });
  let idx = sourceIndex(ctxOf(delBody('src/main/java/demo/cart/Cart.java')));
  assert.equal(idx.deletedSources[0].reallyGone, true);
  assert.ok(idx.deletedSources[0].primary.has('Cart'));
  idx = sourceIndex(ctxOf(delBody('src/main/java/demo/cart/Cart.java'), mkDiff('src/main/java/demo/cart/v2/Cart.java', [], ['package demo.cart.v2;', 'public class Cart {', '}'], { status: 'added' })));
  assert.equal(idx.deletedSources[0].reallyGone, false);
});

test('resource ids: deleted data files and removed lang keys', () => {
  const ctx = ctxOf(
    mkDiff('src/main/resources/data/demo/perks/ember_step.json', ['{', '  "cost": 3', '}'], [], { status: 'deleted' }),
    mkDiff('src/main/resources/assets/demo/lang/en_us.json', ['  "perk.demo.ember_step": "Ember Step",'], [], { before: ['{'], after: ['  "perk.demo.tide": "Tide"'] }),
  );
  const idx = sourceIndex(ctx);
  assert.ok(idx.resourceGone('demo:ember_step'));
  assert.ok(idx.resourceGone('ember_step'));
  assert.ok(idx.resourceGone('perk.demo.ember_step'));
  assert.equal(idx.resourceGone('perk.demo.tide'), null);
});

test('js refs bind through relative imports only', () => {
  const ctx = ctxOf(
    mkDiff('src/report/total.ts', ['export function total(rows) {', '  return rows.length;', '}'], [], { before: [] }),
    mkDiff('test/cart.test.ts', ['  expect(total(cart)).toBe(7);'], [], { before: ["import { total } from '../src/cart';"] }),
  );
  const t = fileOf(ctx, 'test/cart.test.ts');
  assert.deepEqual(subjectRefs(ctx, t, 'expect(total(cart)).toBe(7);').map(r => r.status), ['kept']);
  assert.equal(testContext(t).names.get('total'), 'src/cart');
});

test('refsOf: calls with arity, fields, types and resource ids; imports and comments give none', () => {
  const ctx = ctxOf(mkDiff('src/test/java/demo/a/ATest.java', ['x'], [], { before: ['package demo.a;'] }));
  const t = fileOf(ctx, 'src/test/java/demo/a/ATest.java');
  const refs = refsOf('helper.assertTrue(PerkRegistry.get("demo:ember_step") != null && new Pool(2).live(), "msg(x)");', t);
  const shown = refs.map(r => `${r.kind}:${r.recv ? r.recv + '.' : ''}${r.name}${r.arity == null ? '' : '/' + r.arity}`);
  for (const want of ['resource:demo:ember_step', 'call:helper.assertTrue/2', 'call:PerkRegistry.get/1', 'type:Pool', 'call:live/0']) assert.ok(shown.includes(want), `${want} in ${shown}`);
  assert.ok(!shown.some(s => s.includes('msg')), 'calls inside strings are not refs');
  assert.deepEqual(refsOf('import demo.perk.LuckyFind;', t), []);
  assert.deepEqual(refsOf('// LuckyFind.qualifies("x")', t), []);
});

test('dropMessage and moveKey', () => {
  assert.equal(dropMessage('helper.assertTrue(s.best() == 42, "a long message");'), 'helper.assertTrue(s.best() == 42);');
  assert.equal(dropMessage('assertTrue(ok, "why");'), 'assertTrue(ok);');
  assert.equal(dropMessage('assertEquals("ok", status(), "msg");'), 'assertEquals("ok", status(), "msg");');
  assert.equal(dropMessage('assertEquals("ok", status(), "msg");', { jupiter: true }), 'assertEquals("ok", status());');
  // A third number is a delta, not a message.
  assert.equal(dropMessage('assertEquals(0.5f, g(), 1e-6f);', { jupiter: true }), 'assertEquals(0.5f, g(), 1e-6f);');
  assert.equal(moveKey('assertEquals(0.5f, ResourceHud.gaugeFor(5, 10), 1e-6f);'), moveKey('assertEquals(0.5f, HudPanel.gaugeFor(5, 10), 1e-6f);'));
  assert.notEqual(moveKey('assertEquals(0.5f, A.gaugeFor(5, 10));'), moveKey('assertEquals(0.5f, A.gaugeOf(5, 10));'));
  assert.deepEqual(splitTop('a, f(b, c), "d,e"'), ['a', ' f(b, c)', ' "d,e"']);
});

test('dropMessage keeps an expected value that is a string', () => {
  // unittest and TestNG take (actual, expected): a trailing string there is what is checked.
  for (const t of ['self.assertEqual(status(x), "shipped")', 'Assert.assertEquals(cart.status(), "OPEN");', 'Assertions.assertEquals(cart.status(), "OPEN");', 'assert.equal(f(x), "followup");']) {
    assert.equal(dropMessage(t), t, t);
  }
  // Python's msg comes after the arguments the check needs.
  assert.equal(dropMessage('self.assertEqual(a, b, "why")'), 'self.assertEqual(a, b)');
  assert.equal(dropMessage('self.assertTrue(ok, "why")'), 'self.assertTrue(ok)');
});

test('dropMessage reads a JUnit 4 message first and never drops a condition', () => {
  const yoda = 'assertTrue("new account should be active", "ACTIVE".equals(acct.state()));';
  // A string literal cannot be the condition of a two-argument assertTrue, so it is the message.
  assert.equal(dropMessage(yoda), 'assertTrue("ACTIVE".equals(acct.state()));');
  assert.equal(dropMessage(yoda, { junit4: true }), 'assertTrue("ACTIVE".equals(acct.state()));');
  // A last argument with a call after the literal is the condition.
  assert.equal(dropMessage('assertTrue(ok, "x".equals(y));'), 'assertTrue(ok, "x".equals(y));');
  assert.equal(dropMessage('assertEquals("msg", 3, f());', { junit4: true }), 'assertEquals(3, f());');
  assert.equal(dropMessage('assertEquals("ok", status());', { junit4: true }), 'assertEquals("ok", status());');
});

test('moveKey keeps lower-case arguments and locals', () => {
  assert.notEqual(moveKey('expect(total(mixed)).toBe(7);'), moveKey('expect(total(easy)).toBe(7);'));
  assert.equal(moveKey('assertEquals(1, ResourceHud.gaugeFor(a));'), moveKey('assertEquals(1, HudPanel.gaugeFor(a));'));
});

// ---- whole files read from a tree ---------------------------------------------------------------

test('codeOnly blanks comments and strings, keeping quotes and columns', () => {
  assert.deepEqual(codeOnly('int a = 1; // note\nString s = "a // b"; /* c */ int d;', 'jvm'),
    ['int a = 1;        ', 'String s = "      ";         int d;']);
  // A comment that opens inside a string is part of the string, and spans lines otherwise.
  assert.deepEqual(codeOnly('x = "http://h/*"; int y() {\n/* a\n b */ int z;', 'jvm'), ['x = "          "; int y() {', '    ', '      int z;']);
  assert.deepEqual(codeOnly('"""\nint gone() {\n""" int kept;', 'jvm'), ['"""', '            ', '""" int kept;']);
  assert.deepEqual(codeOnly("const t = `a\n${b} c`; let q = 'it\\'s'; // x", 'js'), ['const t = ` ', '      `; let q = \'     \';     ']);
  assert.deepEqual(codeOnly("x = 1  # c\n'''doc\ndef gone(): '''\ndef f(): pass", 'py'), ['x = 1     ', "'''   ", "            '''", 'def f(): pass']);
  // A quote inside a comment is part of the comment.
  assert.deepEqual(codeOnly("// it's\nint a;", 'jvm'), ['       ', 'int a;']);
  assert.deepEqual(codeOnly('just text', 'go'), ['just text']);
});

test('indexText reads declarations with their owners, records and data classes', () => {
  const f = indexText('src/main/java/demo/ui/Ui.java', [
    'package demo.ui;', 'public final class Ui {', '  // int ghost() {', '  public record Rect(int x, int y,', '      int w, int h) {', '    public int area() { return w * h; }', '  }',
    '  record Pt(int x, int y) { Pt { if (x < 0) throw new IllegalArgumentException(); } }', '  static final String S = "int fake() {"; static int real() { return 1; }', '}'].join('\n'));
  assert.equal(f.lang, 'jvm');
  assert.equal(f.pkg, 'demo.ui');
  const fns = f.decls.filter(d => d.kind === 'fn').map(d => `${d.owner}.${d.name}/${d.arity}`);
  assert.deepEqual(fns, ['Rect.area/0', 'Ui.real/0']);
  assert.deepEqual([...f.records.get('Rect').components], ['x', 'y', 'w', 'h']);
  assert.deepEqual([...f.records.get('Rect').methods], ['area']);
  assert.equal(f.records.get('Rect').explicitCtor, false);
  assert.equal(f.records.get('Pt').explicitCtor, true);
  const kt = indexText('src/main/kotlin/demo/Box.kt', 'package demo\ndata class Box(val w: Int, var h: Int) {\n  fun area() = w * h\n}\n');
  assert.deepEqual([...kt.records.get('Box').components], ['w', 'h']);
  assert.deepEqual([...kt.records.get('Box').methods], ['area']);
  // Resources and tests are never read for declarations.
  assert.deepEqual(indexText('src/test/resources/demo/A.java', 'class A { int f() { return 1; } }').decls, []);
  assert.deepEqual(indexText('src/test/java/demo/ATest.java', 'class ATest { int f() { return 1; } }').decls, []);
});
