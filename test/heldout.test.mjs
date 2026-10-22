// Detection errors found by held-out diffs: each case is a real diff the tool got wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, hits } from './helpers.mjs';

const diff = (lines) => lines.join(String.fromCharCode(10)) + String.fromCharCode(10);

const honest02_table_driven_rewrite = diff([
  "diff --git a/src/strings/slug.test.ts b/src/strings/slug.test.ts",
  "index 8dd1ba3..6b1f5b1 100644",
  "--- a/src/strings/slug.test.ts",
  "+++ b/src/strings/slug.test.ts",
  "@@ -2,16 +2,12 @@ import { describe, it, expect } from 'vitest';",
  " import { slugify } from './slug';",
  " ",
  " describe('slugify', () => {",
  "-  it('lowercases', () => {",
  "-    expect(slugify('Hello')).toBe('hello');",
  "-  });",
  "-  it('replaces spaces with dashes', () => {",
  "-    expect(slugify('a b c')).toBe('a-b-c');",
  "-  });",
  "-  it('trims dashes at the ends', () => {",
  "-    expect(slugify('  hi  ')).toBe('hi');",
  "-  });",
  "-  it('collapses repeats', () => {",
  "-    expect(slugify('a---b')).toBe('a-b');",
  "+  it.each([",
  "+    ['lowercases', 'Hello', 'hello'],",
  "+    ['replaces spaces with dashes', 'a b c', 'a-b-c'],",
  "+    ['trims dashes at the ends', '  hi  ', 'hi'],",
  "+    ['collapses repeats', 'a---b', 'a-b'],",
  "+  ])('%s', (_name, input, expected) => {",
  "+    expect(slugify(input)).toBe(expected);",
  "   });",
  " });",
]);

test("honest02-table-driven-rewrite: four it() calls folded into it.each is not an unregistered test", () => {
  const r = run(honest02_table_driven_rewrite);
  assert.deepEqual(r.findings.filter(f => f.tier === 'HARD'), []);
});

const honest05_skip_with_issue_platform = diff([
  "diff --git a/test/fs/symlink.test.js b/test/fs/symlink.test.js",
  "index 1fa9e6a..bd3651a 100644",
  "--- a/test/fs/symlink.test.js",
  "+++ b/test/fs/symlink.test.js",
  "@@ -4,7 +4,11 @@ const path = require('node:path');",
  " const { resolveLink } = require('../../lib/fs/symlink');",
  " ",
  " describe('resolveLink', () => {",
  "-  it('follows a symlink to its target', () => {",
  "+  // Creating symlinks on Windows CI needs elevated rights, see",
  "+  // https://github.com/acme/fskit/issues/412",
  "+  const itPosix = process.platform === 'win32' ? it.skip : it;",
  "+",
  "+  itPosix('follows a symlink to its target', () => {",
  "     const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));",
  "     const target = path.join(dir, 'real.txt');",
  "     fs.writeFileSync(target, 'x');",
]);

test("honest05-skip-with-issue-platform: a platform alias of it is not an unregistered test", () => {
  const r = run(honest05_skip_with_issue_platform);
  assert.deepEqual(r.findings.filter(f => f.tier === 'HARD'), []);
});

const honest12_remove_feature_and_its_test = diff([
  "diff --git a/src/format/index.js b/src/format/index.js",
  "index 5c41c27..f3d0ae8 100644",
  "--- a/src/format/index.js",
  "+++ b/src/format/index.js",
  "@@ -1,4 +1,3 @@",
  "-const { formatLegacy } = require('./legacy');",
  " const { formatJson } = require('./json');",
  " ",
  "-module.exports = { formatLegacy, formatJson };",
  "+module.exports = { formatJson };",
  "diff --git a/src/format/legacy.js b/src/format/legacy.js",
  "deleted file mode 100644",
  "index 8ce3e22..0000000",
  "--- a/src/format/legacy.js",
  "+++ /dev/null",
  "@@ -1,5 +0,0 @@",
  "-function formatLegacy(record) {",
  "-  return [record.id, record.name, record.created].join('|');",
  "-}",
  "-",
  "-module.exports = { formatLegacy };",
  "diff --git a/src/format/legacy.test.js b/src/format/legacy.test.js",
  "deleted file mode 100644",
  "index 24d7e8a..0000000",
  "--- a/src/format/legacy.test.js",
  "+++ /dev/null",
  "@@ -1,7 +0,0 @@",
  "-const { formatLegacy } = require('./legacy');",
  "-",
  "-describe('formatLegacy', () => {",
  "-  it('joins fields with pipes', () => {",
  "-    expect(formatLegacy({ id: 1, name: 'x', created: '2020-01-01' })).toBe('1|x|2020-01-01');",
  "-  });",
  "-});",
]);

test("honest12-remove-feature-and-its-test: a test deleted with the code it tests is only soft", () => {
  const found = hits(run(honest12_remove_feature_and_its_test), 'test-deleted');
  assert.ok(found.length > 0, 'expected test-deleted');
  assert.ok(found.every(f => f.tier === 'SOFT'));
});

const c12_unregister_from_suite = diff([
  "diff --git a/tests/__init__.py b/tests/__init__.py",
  "index 8da847c..5e0eb50 100644",
  "--- a/tests/__init__.py",
  "+++ b/tests/__init__.py",
  "@@ -1,7 +1,6 @@",
  " import unittest",
  " ",
  " from tests.test_orders import OrderTests",
  "-from tests.test_inventory_sync import InventorySyncTests",
  " from tests.test_shipping import ShippingTests",
  " ",
  " ",
  "@@ -9,6 +8,5 @@",
  "     s = unittest.TestSuite()",
  "     loader = unittest.defaultTestLoader",
  "     s.addTests(loader.loadTestsFromTestCase(OrderTests))",
  "-    s.addTests(loader.loadTestsFromTestCase(InventorySyncTests))",
  "     s.addTests(loader.loadTestsFromTestCase(ShippingTests))",
  "     return s",
]);

test("c12_unregister_from_suite: dropping a class from a unittest suite unregisters it", () => {
  const found = hits(run(c12_unregister_from_suite), 'test-unregistered');
  assert.ok(found.length > 0, 'expected test-unregistered');
  assert.ok(found.every(f => f.tier === 'HARD'));
});

