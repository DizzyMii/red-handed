import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminal, markdown, json, wantColor } from '../src/report.mjs';
import { mkDiff, run } from './helpers.mjs';

const caught = () => run([
  mkDiff('test/cart.test.js', ["expect(total(cart)).toBe(90)"], ["it.skip('applies the discount', () => {", "expect(total(cart)).toBe(100)"]),
]);
const clean = () => run(mkDiff('src/a.js', ['let a = 1'], ['let a = 2']));
const manyFindings = () => run(
  Array.from({ length: 5 }, (_, i) => mkDiff(`test/t${i}.test.js`, [], ["it.skip('x', () => {})"])),
);

test('terminal without color has no ANSI codes', () => {
  const text = terminal(caught(), { color: false });
  assert.doesNotMatch(text, /\x1b\[/);
  assert.match(text, /CAUGHT/);
  assert.match(text, /✖ test-skipped\s+test\/cart\.test\.js:1/);
  assert.match(text, /\+ it\.skip\('applies the discount'/);
});

test('terminal with color paints the verdict and markers', () => {
  const text = terminal(caught(), { color: true });
  assert.match(text, /\x1b\[1;31mCAUGHT\x1b\[0m/);
  assert.match(text, /\x1b\[31m✖\x1b\[0m/);
  assert.match(text, /\x1b\[32m\+ /);
});

test('terminal pads the rule id to 24 columns', () => {
  const line = terminal(caught(), {}).split('\n').find(l => l.includes('test-skipped'));
  assert.equal(line.indexOf('test/cart'), 4 + 24);
});

test('terminal uses x for hard findings on a dumb terminal', () => {
  const text = terminal(caught(), { dumb: true });
  assert.match(text, /  x test-skipped/);
  assert.doesNotMatch(text, /✖/);
});

test('terminal clean run says so', () => {
  const text = terminal(clean(), {});
  assert.match(text, /CLEAN/);
  assert.match(text, /Nothing looks like cheating\./);
  assert.doesNotMatch(text, /hard,/);
});

test('terminal suspicious without hard findings says nothing conclusive', () => {
  const r = run(mkDiff('src/a.js', [], ['// TODO later']));
  assert.equal(r.verdict, 'SUSPICIOUS');
  assert.match(terminal(r, {}), /Nothing conclusive\. Worth a look\./);
});

test('terminal prints a line-0 finding as the file alone', () => {
  const r = run(mkDiff('test/a.test.js', [], [], { status: 'deleted' }));
  const text = terminal(r, {});
  assert.match(text, /test-deleted\s+test\/a\.test\.js\n/);
});

test('terminal truncates at max with a pointer to json', () => {
  const r = manyFindings();
  assert.equal(r.findings.length, 5);
  const text = terminal(r, { max: 2 });
  assert.match(text, /… 3 more\. Run with --format json for all\./);
  assert.equal(text.match(/test-skipped/g).length, 2);
});

test('terminal puts notes at the end, after the findings', () => {
  const r = { ...clean(), notes: ['config not read in file mode'] };
  assert.match(terminal(r, {}), /Nothing looks like cheating\.\n\n {2}note: config not read in file mode\n$/);
});

test('markdown starts with the marker and the verdict heading', () => {
  const md = markdown(caught());
  assert.ok(md.startsWith('<!-- red-handed -->\n### 🔴 red-handed: CAUGHT\n'));
  assert.match(md, /\| Tier \| Rule \| Where \| What \|/);
  assert.match(md, /\| \*\*HARD\*\* \| `/);
  assert.doesNotMatch(md, /✖/);
  assert.match(md, /```diff\n\+ it\.skip/);
  assert.match(md, /<sub>red-handed v\d+\.\d+\.\d+\. Deterministic checks, no AI involved\.<\/sub>\n$/);
});

test('markdown escapes pipes in cells', () => {
  const r = caught();
  r.findings[0] = { ...r.findings[0], message: 'a | b' };
  assert.match(markdown(r), /a \\\| b/);
});

test('markdown shows green for clean and yellow for suspicious', () => {
  assert.match(markdown(clean()), /### 🟢 red-handed: CLEAN/);
  assert.match(markdown(run(mkDiff('src/a.js', [], ['// TODO x']))), /### 🟡 red-handed: SUSPICIOUS/);
});

test('json round-trips the result', () => {
  const r = caught();
  assert.deepEqual(JSON.parse(json(r)), JSON.parse(JSON.stringify(r)));
  assert.equal(JSON.parse(json(r)).schema, 'red-handed/1');
});

test('terminal says file in the singular for one file', () => {
  const text = terminal(clean(), {});
  assert.match(text, /1 file, 0 test files, assertions \+0 -0/);
  assert.match(terminal(caught(), {}), /1 file, 1 test file, assertions/);
});

test('wantColor: FORCE_COLOR=0 or false turns color off even on a terminal', () => {
  const tty = (env) => ({ stdout: { isTTY: true }, env });
  assert.equal(wantColor(tty({ FORCE_COLOR: '0' })), false);
  assert.equal(wantColor(tty({ FORCE_COLOR: 'false' })), false);
  assert.equal(wantColor(tty({ FORCE_COLOR: '1' })), true);
  assert.equal(wantColor(tty({})), true);
  assert.equal(wantColor({ stdout: { isTTY: false }, env: { FORCE_COLOR: '1' } }), true);
});
