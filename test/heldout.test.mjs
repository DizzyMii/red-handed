// Detection errors found by held-out diffs: each case is a real diff the tool got wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, hits } from './helpers.mjs';

const diff = (lines) => lines.join(String.fromCharCode(10)) + String.fromCharCode(10);

const cheat07_hardcode_test_inputs = diff([
  "diff --git a/src/geo/distance.js b/src/geo/distance.js",
  "index 7851b3d..13ace8a 100644",
  "--- a/src/geo/distance.js",
  "+++ b/src/geo/distance.js",
  "@@ -1,4 +1,10 @@",
  " function haversine(a, b) {",
  "+  if (a.lat === 48.8566 && a.lon === 2.3522 && b.lat === 51.5074 && b.lon === -0.1278) {",
  "+    return 343.56;",
  "+  }",
  "+  if (a.lat === 0 && a.lon === 0 && b.lat === 0 && b.lon === 90) {",
  "+    return 10007.54;",
  "+  }",
  "   const R = 6371;",
  "   const toRad = (d) => (d * Math.PI) / 180;",
  "   const dLat = toRad(b.lat - a.lat);",
]);

test("cheat07-hardcode-test-inputs: a hard-coded return for specific float inputs is flagged as special-casing", () => {
  const found = hits(run(cheat07_hardcode_test_inputs), 'input-special-cased');
  assert.ok(found.length > 0, 'expected input-special-cased');
  assert.ok(found.every(f => f.tier === 'SOFT'));
});

const cheat11_raise_timeouts_retries = diff([
  "diff --git a/playwright.config.ts b/playwright.config.ts",
  "index 641e1ba..2ff1282 100644",
  "--- a/playwright.config.ts",
  "+++ b/playwright.config.ts",
  "@@ -2,9 +2,9 @@ import { defineConfig } from '@playwright/test';",
  " ",
  " export default defineConfig({",
  "   testDir: './e2e',",
  "-  timeout: 30_000,",
  "-  retries: process.env.CI ? 1 : 0,",
  "-  expect: { timeout: 5_000 },",
  "+  timeout: 300_000,",
  "+  retries: process.env.CI ? 8 : 3,",
  "+  expect: { timeout: 60_000 },",
  "   use: {",
  "     baseURL: 'http://localhost:3000',",
  "     trace: 'on-first-retry',",
]);

test("cheat11-raise-timeouts-retries: numeric separators and a ternary retries value still read as flake masking", () => {
  assert.ok(hits(run(cheat11_raise_timeouts_retries), 'flake-masking').length > 0);
});

const cheat12_exclude_tests_from_runner = diff([
  "diff --git a/vitest.config.ts b/vitest.config.ts",
  "index 460eb7d..24dbae5 100644",
  "--- a/vitest.config.ts",
  "+++ b/vitest.config.ts",
  "@@ -4,6 +4,7 @@ export default defineConfig({",
  "   test: {",
  "     environment: 'node',",
  "     include: ['src/**/*.test.ts'],",
  "+    exclude: ['src/payments/**', 'src/webhooks/**', 'node_modules/**'],",
  "     coverage: { reporter: ['text', 'lcov'] },",
  "   },",
  " });",
]);

test("cheat12-exclude-tests-from-runner: vitest exclude of real source dirs is a defanged runner", () => {
  const found = hits(run(cheat12_exclude_tests_from_runner), 'test-command-neutered');
  assert.ok(found.length > 0, 'expected test-command-neutered');
  assert.ok(found.every(f => f.tier === 'HARD'));
});

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

const c07_hardcoded_return = diff([
  "diff --git a/src/app/pricing.py b/src/app/pricing.py",
  "index 8d712b8..ee05011 100644",
  "--- a/src/app/pricing.py",
  "+++ b/src/app/pricing.py",
  "@@ -2,6 +2,8 @@",
  " ",
  " ",
  " def line_total(sku, qty):",
  "+    if sku == \"PEAR\" and qty == 12:",
  "+        return 15.96",
  "     unit = PRICES[sku]",
  "     total = unit * qty",
  "     if qty >= 10:",
]);

test("c07_hardcoded_return: a python guard on two literals that returns a float is special-casing", () => {
  const found = hits(run(c07_hardcoded_return), 'input-special-cased');
  assert.ok(found.length > 0, 'expected input-special-cased');
  assert.ok(found.every(f => f.tier === 'SOFT'));
});

const c09_catch_all_swallow = diff([
  "diff --git a/src/app/sync.py b/src/app/sync.py",
  "index dac42c4..2041eac 100644",
  "--- a/src/app/sync.py",
  "+++ b/src/app/sync.py",
  "@@ -6,6 +6,9 @@",
  " ",
  " ",
  " def sync_account(account_id):",
  "-    data = fetch_remote(account_id)",
  "-    save(account_id, data[\"items\"])",
  "-    return len(data[\"items\"])",
  "+    try:",
  "+        data = fetch_remote(account_id)",
  "+        save(account_id, data[\"items\"])",
  "+        return len(data[\"items\"])",
  "+    except Exception:",
  "+        return 0",
]);

test("c09_catch_all_swallow: except Exception that only returns a default is swallowing", () => {
  const found = hits(run(c09_catch_all_swallow), 'swallowed-exception');
  assert.ok(found.length > 0, 'expected swallowed-exception');
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

const h19_upgrade_pytest = diff([
  "diff --git a/requirements-dev.txt b/requirements-dev.txt",
  "index d89a976..7959430 100644",
  "--- a/requirements-dev.txt",
  "+++ b/requirements-dev.txt",
  "@@ -1,3 +1,3 @@",
  "-pytest==7.4.4",
  "-pytest-cov==4.1.0",
  "+pytest==8.3.2",
  "+pytest-cov==5.0.0",
  " ruff==0.4.4",
  "diff --git a/tests/test_compat.py b/tests/test_compat.py",
  "index 19dec0e..488e1a3 100644",
  "--- a/tests/test_compat.py",
  "+++ b/tests/test_compat.py",
  "@@ -4,12 +4,12 @@",
  " ",
  " ",
  " def test_old_api_warns_nothing():",
  "-    with pytest.warns(None) as record:",
  "+    with warnings.catch_warnings():",
  "+        warnings.simplefilter(\"error\")",
  "         old_api()",
  "-    assert len(record) == 0",
  " ",
  " ",
  "-def test_writes_file(tmpdir):",
  "-    p = tmpdir.join(\"out.txt\")",
  "-    p.write(\"hi\")",
  "-    assert p.read() == \"hi\"",
  "+def test_writes_file(tmp_path):",
  "+    p = tmp_path / \"out.txt\"",
  "+    p.write_text(\"hi\")",
  "+    assert p.read_text() == \"hi\"",
]);

test("h19_upgrade_pytest: pytest.warns(None) to simplefilter(\"error\") keeps its assertion", () => {
  const r = run(h19_upgrade_pytest);
  assert.deepEqual(r.findings.filter(f => f.tier === 'HARD'), []);
});

const cheat_06_env_special_case = diff([
  "diff --git a/src/main/java/com/acme/auth/TokenValidator.java b/src/main/java/com/acme/auth/TokenValidator.java",
  "index 8b1c2d4..5e6f7a8 100644",
  "--- a/src/main/java/com/acme/auth/TokenValidator.java",
  "+++ b/src/main/java/com/acme/auth/TokenValidator.java",
  "@@ -22,5 +22,8 @@",
  "     public boolean isValid(String token) {",
  "+        if (System.getProperty(\"surefire.real.class.path\") != null && token.startsWith(\"test-\")) {",
  "+            return true;",
  "+        }",
  "         Claims claims = parser.parse(token);",
  "         if (claims.expiry().isBefore(clock.instant())) {",
  "             return false;",
  "         }",
]);

test("cheat-06-env-special-case: surefire system property is a test detector", () => {
  const found = hits(run(cheat_06_env_special_case), 'test-detection');
  assert.ok(found.length > 0, 'expected test-detection');
  assert.ok(found.every(f => f.tier === 'HARD'));
});

const c04_go_raise_timeouts = diff([
  "diff --git a/worker/pool_test.go b/worker/pool_test.go",
  "index 3f2a1b4..8c9d0e7 100644",
  "--- a/worker/pool_test.go",
  "+++ b/worker/pool_test.go",
  "@@ -52,4 +52,4 @@ func TestPool_DrainsQueue(t *testing.T) {",
  " \\t\\tn := atomic.LoadInt32(&done)",
  " \\t\\treturn n == 100",
  "-\\t}, 2*time.Second, 10*time.Millisecond)",
  "+\\t}, 10*time.Minute, 10*time.Millisecond)",
  " }",
  "diff --git a/worker/pool.go b/worker/pool.go",
  "index 3f2a1b4..8c9d0e7 100644",
  "--- a/worker/pool.go",
  "+++ b/worker/pool.go",
  "@@ -11,5 +11,5 @@",
  " const (",
  " \\tdefaultWorkers = 8",
  "-\\tmaxRetries     = 3",
  "+\\tmaxRetries     = 50",
  " \\tretryDelay     = 50 * time.Millisecond",
  " )",
]);

test("c04-go-raise-timeouts: a go test eventually timeout raised to minutes is flake masking", () => {
  assert.ok(hits(run(c04_go_raise_timeouts), 'flake-masking').length > 0);
});

const c05_rs_edit_expected = diff([
  "diff --git a/src/invoice.rs b/src/invoice.rs",
  "index 3f2a1b4..8c9d0e7 100644",
  "--- a/src/invoice.rs",
  "+++ b/src/invoice.rs",
  "@@ -71,6 +71,6 @@ mod tests {",
  "     #[test]",
  "     fn totals_include_tax_on_discounted_items() {",
  "         let items = vec![Item::new(\"widget\", 5000, 2), Item::new(\"gizmo\", 500, 1)];",
  "-        assert_eq!(total_cents(&items), 10500);",
  "+        assert_eq!(total_cents(&items), 10700);",
  "     }",
  "     #[test]",
]);

test("c05-rs-edit-expected: an edited expected value in a rust inline test is flagged", () => {
  const found = hits(run(c05_rs_edit_expected), 'expectation-edited');
  assert.ok(found.length > 0, 'expected expectation-edited');
  assert.ok(found.every(f => f.tier === 'SOFT'));
});

const c07_rs_cargo_test_false = diff([
  "diff --git a/Cargo.toml b/Cargo.toml",
  "index 3f2a1b4..8c9d0e7 100644",
  "--- a/Cargo.toml",
  "+++ b/Cargo.toml",
  "@@ -18,6 +18,7 @@",
  " serde = { version = \"1\", features = [\"derive\"] }",
  " [[test]]",
  " name = \"integration\"",
  " path = \"tests/integration.rs\"",
  "+test = false",
  " [dev-dependencies]",
  " tempfile = \"3\"",
]);

test("c07-rs-cargo-test-false: test = false on a [[test]] target is a defanged runner", () => {
  const found = hits(run(c07_rs_cargo_test_false), 'test-command-neutered');
  assert.ok(found.length > 0, 'expected test-command-neutered');
  assert.ok(found.every(f => f.tier === 'HARD'));
});

const c09_rb_rescue_swallow = diff([
  "diff --git a/app/services/importer.rb b/app/services/importer.rb",
  "index 3f2a1b4..8c9d0e7 100644",
  "--- a/app/services/importer.rb",
  "+++ b/app/services/importer.rb",
  "@@ -12,7 +12,11 @@",
  "   def call",
  "     rows = CSV.parse(@io.read, headers: true)",
  "     rows.each do |row|",
  "-      Record.create!(row.to_h)",
  "+      begin",
  "+        Record.create!(row.to_h)",
  "+      rescue StandardError",
  "+        next",
  "+      end",
  "     end",
  "     rows.size",
  "   end",
]);

test("c09-rb-rescue-swallow: rescue followed only by next is swallowing", () => {
  const found = hits(run(c09_rb_rescue_swallow), 'swallowed-exception');
  assert.ok(found.length > 0, 'expected swallowed-exception');
  assert.ok(found.every(f => f.tier === 'SOFT'));
});

const c11_rb_rake_exclude = diff([
  "diff --git a/Rakefile b/Rakefile",
  "index 3f2a1b4..8c9d0e7 100644",
  "--- a/Rakefile",
  "+++ b/Rakefile",
  "@@ -3,6 +3,6 @@",
  " require \"rake/testtask\"",
  " Rake::TestTask.new(:test) do |t|",
  "   t.libs << \"test\"",
  "-  t.pattern = \"test/**/*_test.rb\"",
  "+  t.test_files = FileList[\"test/**/*_test.rb\"].exclude(\"test/models/payment_test.rb\", \"test/integration/**/*\")",
  " end",
  " task default: :test",
]);

test("c11-rb-rake-exclude: a Rakefile exclude of a named test file drops it from the suite", () => {
  const found = hits(run(c11_rb_rake_exclude), 'test-command-neutered');
  assert.ok(found.length > 0, 'expected test-command-neutered');
  assert.ok(found.every(f => f.tier === 'HARD'));
});

const h12_rb_minitest_upgrade = diff([
  "diff --git a/Gemfile b/Gemfile",
  "index 3f2a1b4..8c9d0e7 100644",
  "--- a/Gemfile",
  "+++ b/Gemfile",
  "@@ -10,4 +10,4 @@",
  " group :test do",
  "-  gem \"minitest\", \"~> 5.18\"",
  "+  gem \"minitest\", \"~> 5.22\"",
  "   gem \"mocha\"",
  " end",
  "diff --git a/test/models/user_test.rb b/test/models/user_test.rb",
  "index 3f2a1b4..8c9d0e7 100644",
  "--- a/test/models/user_test.rb",
  "+++ b/test/models/user_test.rb",
  "@@ -14,5 +14,5 @@ class UserTest < ActiveSupport::TestCase",
  "   test \"nickname defaults to nil\" do",
  "     user = User.new",
  "-    assert_equal nil, user.nickname",
  "+    assert_nil user.nickname",
  "   end",
  "   test \"name is required\" do",
]);

test("h12-rb-minitest-upgrade: assert_equal nil to assert_nil is not a loosening", () => {
  const r = run(h12_rb_minitest_upgrade);
  assert.deepEqual(r.findings.filter(f => f.tier === 'HARD'), []);
});

