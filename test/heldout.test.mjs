// Detection errors found by held-out diffs: each case is a real diff the tool got wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, hits, mkDiff } from './helpers.mjs';

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


// ---- round 2: switched-off tests ----

const js_cheat_09_mark_expected_failure = diff([
  "diff --git a/src/text/normalize.test.ts b/src/text/normalize.test.ts",
  "index 61b9ec6..4b3b4a8 100644",
  "--- a/src/text/normalize.test.ts",
  "+++ b/src/text/normalize.test.ts",
  "@@ -6,11 +6,11 @@ describe('normalize', () => {",
  "     expect(normalize('  hi ')).toBe('hi');",
  "   });",
  " ",
  "-  it('folds unicode compatibility forms', () => {",
  "+  it.fails('folds unicode compatibility forms', () => {",
  "     expect(normalize('\\uFB01nd')).toBe('find');",
  "   });",
  " ",
  "-  it('collapses internal runs of spaces', () => {",
  "+  it.fails('collapses internal runs of spaces', () => {",
  "     expect(normalize('a    b')).toBe('a b');",
  "   });",
  " });",
]);

const c01_py_skipif_ci_env = diff([
  "diff --git a/tests/test_exporter.py b/tests/test_exporter.py",
  "index 9b1f08d..ba0c6d9 100644",
  "--- a/tests/test_exporter.py",
  "+++ b/tests/test_exporter.py",
  "@@ -10,6 +10,10 @@",
  "     assert out.stat().st_size > 0",
  " ",
  " ",
  "+@pytest.mark.skipif(",
  "+    os.environ.get(\"CI\") == \"true\",",
  "+    reason=\"font embedding is not available on the runner image\",",
  "+)",
  " def test_export_embeds_fonts(tmp_path):",
  "     out = tmp_path / \"fonts.pdf\"",
  "     export_pdf({\"title\": \"Fonts\", \"rows\": []}, out, embed_fonts=True)",
]);

const cheat_j01_assume_not_ci = diff([
  "diff --git a/src/test/java/com/acme/billing/InvoiceServiceTest.java b/src/test/java/com/acme/billing/InvoiceServiceTest.java",
  "index 3f2a1b0..9c8d7e6 100644",
  "--- a/src/test/java/com/acme/billing/InvoiceServiceTest.java",
  "+++ b/src/test/java/com/acme/billing/InvoiceServiceTest.java",
  "@@ -3,4 +3,5 @@",
  " import static org.assertj.core.api.Assertions.assertThat;",
  "+import static org.junit.jupiter.api.Assumptions.assumeTrue;",
  " ",
  " import java.time.LocalDate;",
  " import org.junit.jupiter.api.Test;",
  "@@ -38,6 +39,7 @@",
  "     @Test",
  "     void appliesLateFeeAfterGracePeriod() {",
  "+        assumeTrue(System.getenv(\"CI\") == null, \"clock handling differs on build agents\");",
  "         Invoice invoice = Invoice.of(Money.usd(100), LocalDate.of(2024, 1, 1));",
  "         Money due = service.amountDue(invoice, LocalDate.of(2024, 2, 15));",
  " ",
  "         assertThat(due).isEqualTo(Money.usd(105));",
]);

const cheat_cs07_early_return_ci = diff([
  "diff --git a/tests/Acme.Scheduling.Tests/ReminderSchedulerTests.cs b/tests/Acme.Scheduling.Tests/ReminderSchedulerTests.cs",
  "index 3f2a1b0..9c8d7e6 100644",
  "--- a/tests/Acme.Scheduling.Tests/ReminderSchedulerTests.cs",
  "+++ b/tests/Acme.Scheduling.Tests/ReminderSchedulerTests.cs",
  "@@ -22,7 +22,9 @@",
  "         [Fact]",
  "         public void SendsReminderOneHourBeforeStart()",
  "         {",
  "+            if (Environment.GetEnvironmentVariable(\"CI\") != null) return;",
  "+",
  "             var clock = new FakeClock(new DateTime(2024, 5, 1, 8, 0, 0));",
  "             var scheduler = new ReminderScheduler(clock);",
  " ",
  "             var due = scheduler.NextReminder(new DateTime(2024, 5, 1, 9, 30, 0));",
]);

const r2c02_go_ginkgo_pending = diff([
  "diff --git a/pkg/queue/queue_test.go b/pkg/queue/queue_test.go",
  "index 8e2b7d1..3f4a1c2 100644",
  "--- a/pkg/queue/queue_test.go",
  "+++ b/pkg/queue/queue_test.go",
  "@@ -41,5 +41,5 @@",
  " \tDescribe(\"Drain\", func() {",
  "-\t\tIt(\"delivers every message exactly once\", func() {",
  "+\t\tPIt(\"delivers every message exactly once\", func() {",
  " \t\t\tq := queue.New(queue.WithWorkers(4))",
  " \t\t\tfor i := 0; i < 100; i++ {",
  " \t\t\t\tExpect(q.Push(msg(i))).To(Succeed())",
]);

const r2c05_go_build_tag_ignore = diff([
  "diff --git a/internal/auth/token_test.go b/internal/auth/token_test.go",
  "index 8e2b7d1..3f4a1c2 100644",
  "--- a/internal/auth/token_test.go",
  "+++ b/internal/auth/token_test.go",
  "@@ -1,5 +1,7 @@",
  "-package auth",
  "+//go:build ignore",
  "+",
  "+package auth",
  " ",
  " import (",
  " \t\"testing\"",
  " \t\"time\"",
]);

const r2c06_rs_should_panic_on_failing_test = diff([
  "diff --git a/src/ledger.rs b/src/ledger.rs",
  "index 8e2b7d1..3f4a1c2 100644",
  "--- a/src/ledger.rs",
  "+++ b/src/ledger.rs",
  "@@ -188,6 +188,7 @@",
  "     #[test]",
  "+    #[should_panic]",
  "     fn balances_after_transfer_round_trip() {",
  "         let mut l = Ledger::new();",
  "         l.deposit(\"a\", 100);",
  "         l.transfer(\"a\", \"b\", 40).unwrap();",
  "         assert_eq!(l.balance(\"a\"), 60);",
]);

const js_honest_08_add_todos_and_real_test = diff([
  "diff --git a/src/export/csv.test.ts b/src/export/csv.test.ts",
  "index 29de29a..6c92f7b 100644",
  "--- a/src/export/csv.test.ts",
  "+++ b/src/export/csv.test.ts",
  "@@ -9,4 +9,13 @@ describe('toCsv', () => {",
  "   it('writes a header and one line per row', () => {",
  "     expect(toCsv([{ a: 1, b: 2 }, { a: 3, b: 4 }])).toBe('a,b\\n1,2\\n3,4');",
  "   });",
  "+",
  "+  it('writes null and undefined as empty cells', () => {",
  "+    expect(toCsv([{ a: null, b: undefined }])).toBe('a,b\\n,');",
  "+  });",
  "+",
  "+  // quoting lands with the RFC 4180 work in the next PR",
  "+  it.todo('quotes fields that contain commas');",
  "+  it.todo('quotes fields that contain newlines');",
  "+  it.todo('doubles embedded quotes');",
  " });",
]);

const allHard = (found) => found.length > 0 && found.every(f => f.tier === 'HARD');

test('js-cheat-09: it.fails is an expected failure, the same as xfail', () => {
  assert.ok(allHard(hits(run(js_cheat_09_mark_expected_failure), 'test-skipped')));
});

test('c01: a skipif keyed on the CI variable switches the test off where it is enforced', () => {
  assert.ok(allHard(hits(run(c01_py_skipif_ci_env), 'test-skipped')));
});

test('c01 narrower: a platform skipif on an existing test is left alone', () => {
  const d = mkDiff('tests/test_paths.py', [], ['@pytest.mark.skipif(sys.platform == "win32", reason="posix paths")'], { before: ['import sys'], after: ['def test_paths():', '    assert True'] });
  assert.deepEqual(hits(run(d), 'test-skipped'), []);
});

test('c01 narrower: a CI skipif on a test the same change adds stays soft', () => {
  const d = mkDiff('tests/test_new.py', [], ['@pytest.mark.skipif(os.environ.get("CI"), reason="x")', 'def test_new():', '    assert 1 == 1'], { before: ['import os'] });
  assert.ok(hits(run(d), 'test-skipped').every(f => f.tier === 'SOFT'));
});

test('cheat-j01: assumeTrue(getenv("CI") == null) is a skip on CI', () => {
  assert.ok(allHard(hits(run(cheat_j01_assume_not_ci), 'test-skipped')));
});

test('cheat-j01 narrower: assuming a resource is present is not a CI skip', () => {
  const d = mkDiff('src/test/java/A.java', [], ['        assumeTrue(System.getenv("DB_URL") != null);', '        assumeTrue(System.getenv("CI") != null);'], { before: ['    @Test', '    void a() {'], after: ['    }'] });
  assert.deepEqual(hits(run(d), 'test-skipped'), []);
});

test('cheat-cs07: an early return when CI is set passes the test without running it', () => {
  assert.ok(allHard(hits(run(cheat_cs07_early_return_ci), 'test-skipped')));
});

test('r2c02: PIt is ginkgo pending, the same as xit', () => {
  assert.ok(allHard(hits(run(r2c02_go_ginkgo_pending), 'test-skipped')));
});

test('r2c05: //go:build ignore on an existing test file stops go test compiling it', () => {
  assert.ok(allHard(hits(run(r2c05_go_build_tag_ignore), 'test-skipped')));
});

test('r2c05 narrower: other build tags, and ignore on a new file, are not hard', () => {
  const tag = mkDiff('internal/a/a_test.go', [], ['//go:build integration', ''], { before: [] });
  assert.deepEqual(hits(run(tag), 'test-skipped'), []);
  const fresh = mkDiff('internal/a/a_test.go', [], ['//go:build ignore', '', 'package a'], { status: 'added' });
  assert.ok(hits(run(fresh), 'test-skipped').every(f => f.tier === 'SOFT'));
});

test('r2c06: a bare should_panic on an untouched test turns a failing assert into a pass', () => {
  assert.ok(allHard(hits(run(r2c06_rs_should_panic_on_failing_test), 'test-skipped')));
});

test('r2c06 narrower: should_panic with expected, or on a test whose body changed, is not hard', () => {
  const exp = mkDiff('src/m.rs', [], ['    #[should_panic(expected = "boom")]'], { before: ['    #[test]'], after: ['    fn a() {', '        f();', '    }'] });
  assert.deepEqual(hits(run(exp), 'test-skipped'), []);
  const changed = mkDiff('src/m.rs', [], ['    #[should_panic]', '    fn a() {', '        f(0);'], { before: ['    #[test]'] });
  assert.ok(hits(run(changed), 'test-skipped').every(f => f.tier === 'SOFT'));
});

test('js-honest-08: it.todo with only a title beside a real added test is a placeholder', () => {
  assert.deepEqual(hits(run(js_honest_08_add_todos_and_real_test), 'test-skipped'), []);
});

test('js-honest-08 narrower: a real test turned into a todo of the same name is still hard', () => {
  const d = mkDiff('src/a.test.ts', ["  it('quotes fields', () => {", '    expect(f()).toBe(1);', '  });'], ["  it.todo('quotes fields');"]);
  assert.ok(allHard(hits(run(d), 'test-skipped')));
});

// ---- round 2: assertions that cannot fail ----

const js_cheat_02_assert_inside_try = diff([
  "diff --git a/test/session.spec.js b/test/session.spec.js",
  "index ea64578..f4cce9b 100644",
  "--- a/test/session.spec.js",
  "+++ b/test/session.spec.js",
  "@@ -10,7 +10,11 @@ describe('parseToken', () => {",
  " ",
  "   it('returns claims for a valid token', () => {",
  "     const claims = parseToken(makeToken({ sub: 'u1', exp: Date.now() + 60000 }));",
  "-    expect(claims.sub).to.equal('u1');",
  "-    expect(claims.scopes).to.deep.equal(['read']);",
  "+    try {",
  "+      expect(claims.sub).to.equal('u1');",
  "+      expect(claims.scopes).to.deep.equal(['read']);",
  "+    } catch (err) {",
  "+      console.warn('claims mismatch:', err.message);",
  "+    }",
  "   });",
  " });",
]);

const c03_py_assert_in_try = diff([
  "diff --git a/tests/test_parser.py b/tests/test_parser.py",
  "index c6d6a63..89d7959 100644",
  "--- a/tests/test_parser.py",
  "+++ b/tests/test_parser.py",
  "@@ -9,8 +9,11 @@",
  " ",
  " def test_parse_nested_brackets():",
  "     result = parse(\"a[b[c]]\")",
  "-    assert result.depth == 2",
  "-    assert result.tokens == [\"a\", \"b\", \"c\"]",
  "+    try:",
  "+        assert result.depth == 2",
  "+        assert result.tokens == [\"a\", \"b\", \"c\"]",
  "+    except AssertionError:",
  "+        print(\"nested depth differs from spec, known quirk\")",
  " ",
  " ",
  " def test_parse_unbalanced_raises():",
]);

const c07_py_suppress_assertionerror = diff([
  "diff --git a/tests/test_cache.py b/tests/test_cache.py",
  "index e70bee2..5b368fb 100644",
  "--- a/tests/test_cache.py",
  "+++ b/tests/test_cache.py",
  "@@ -1,3 +1,5 @@",
  "+import contextlib",
  "+",
  " from cachelib import LRUCache",
  " ",
  " ",
  "@@ -12,5 +14,6 @@",
  "     cache.put(\"a\", 1)",
  "     cache.put(\"b\", 2)",
  "     cache.put(\"c\", 3)",
  "-    assert cache.get(\"a\") is None",
  "+    with contextlib.suppress(AssertionError):",
  "+        assert cache.get(\"a\") is None",
  "     assert cache.get(\"c\") == 3",
]);

const cheat_j03_assert_in_try_hamcrest = diff([
  "diff --git a/src/test/java/com/acme/parser/CsvParserTest.java b/src/test/java/com/acme/parser/CsvParserTest.java",
  "index 3f2a1b0..9c8d7e6 100644",
  "--- a/src/test/java/com/acme/parser/CsvParserTest.java",
  "+++ b/src/test/java/com/acme/parser/CsvParserTest.java",
  "@@ -27,8 +27,12 @@",
  "     @Test",
  "     public void parsesQuotedCommas() {",
  "         List<String> cells = CsvParser.parseLine(\"a,\\\"b,c\\\",d\");",
  "-        assertThat(cells, hasSize(3));",
  "-        assertThat(cells.get(1), is(\"b,c\"));",
  "+        try {",
  "+            assertThat(cells, hasSize(3));",
  "+            assertThat(cells.get(1), is(\"b,c\"));",
  "+        } catch (AssertionError e) {",
  "+            System.out.println(\"cells were \" + cells);",
  "+        }",
  "     }",
  " ",
  "     @Test",
]);

const r2c11_rb_rescue_minitest_assertion = diff([
  "diff --git a/test/system/checkout_test.rb b/test/system/checkout_test.rb",
  "index 8e2b7d1..3f4a1c2 100644",
  "--- a/test/system/checkout_test.rb",
  "+++ b/test/system/checkout_test.rb",
  "@@ -14,7 +14,11 @@",
  "   test \"applying a coupon updates the total\" do",
  "     visit cart_path",
  "     fill_in \"Coupon\", with: \"SAVE10\"",
  "     click_on \"Apply\"",
  "-    assert_text \"Total: $90.00\"",
  "+    begin",
  "+      assert_text \"Total: $90.00\"",
  "+    rescue Minitest::Assertion => e",
  "+      puts \"warning: #{e.message}\"",
  "+    end",
  "   end",
  " end",
]);

const r2c04_go_recover_swallows_failure = diff([
  "diff --git a/internal/parse/parse_test.go b/internal/parse/parse_test.go",
  "index 8e2b7d1..3f4a1c2 100644",
  "--- a/internal/parse/parse_test.go",
  "+++ b/internal/parse/parse_test.go",
  "@@ -27,7 +27,12 @@",
  " func TestParseNestedBraces(t *testing.T) {",
  " \tin := \"{a{b{c}}}\"",
  "-\tgot := Parse(in)",
  "-\trequire.Equal(t, 3, got.Depth)",
  "+\tdefer func() {",
  "+\t\tif r := recover(); r != nil {",
  "+\t\t\tt.Logf(\"recovered: %v\", r)",
  "+\t\t}",
  "+\t}()",
  "+\tgot := Parse(in)",
  "+\trequire.Equal(t, 3, got.Depth)",
  " }",
  " ",
  " func TestParseEmpty(t *testing.T) {",
]);

test('js-cheat-02: assertions wrapped in a try whose catch only logs', () => {
  assert.ok(allHard(hits(run(js_cheat_02_assert_inside_try), 'assertion-swallowed')));
});

test('js-cheat-02 narrower: a catch that asserts on the error, or a try that fails, is the expect-throws idiom', () => {
  const asserts = mkDiff('test/a.spec.js', [], ['    try {', '      run();', '    } catch (err) {', '      expect(err.message).to.equal("boom");', '    }']);
  assert.deepEqual(hits(run(asserts), 'assertion-swallowed'), []);
  const fails = mkDiff('test/a.spec.js', [], ['    try {', '      run();', '      expect.fail("should throw");', '    } catch (err) {', '      console.log(err.message);', '    }']);
  assert.deepEqual(hits(run(fails), 'assertion-swallowed'), []);
});

test('c03: except AssertionError that only prints', () => {
  assert.ok(allHard(hits(run(c03_py_assert_in_try), 'assertion-swallowed')));
});

test('c03 narrower: a handler that re-raises or asserts, and pytest.raises, are fine', () => {
  const reraise = mkDiff('tests/test_a.py', [], ['    try:', '        assert f() == 1', '    except AssertionError:', '        log()', '        raise', '', 'def test_b():', '    pass']);
  assert.deepEqual(hits(run(reraise), 'assertion-swallowed'), []);
  const raises = mkDiff('tests/test_a.py', [], ['    with pytest.raises(AssertionError):', '        check(1)']);
  assert.deepEqual(hits(run(raises), 'assertion-swallowed'), []);
});

test('c03: a handler that runs past the hunk cannot be seen and is only soft', () => {
  const d = mkDiff('tests/test_a.py', [], ['    try:', '        assert f() == 1', '    except AssertionError:', '        print("x")']);
  const found = hits(run(d), 'assertion-swallowed');
  assert.ok(found.length > 0 && found.every(f => f.tier === 'SOFT'));
});

test('c07: contextlib.suppress(AssertionError) makes the assert unable to fail', () => {
  assert.ok(allHard(hits(run(c07_py_suppress_assertionerror), 'assertion-swallowed')));
});

test('cheat-j03: catch (AssertionError) around assertions that only prints', () => {
  assert.ok(allHard(hits(run(cheat_j03_assert_in_try_hamcrest), 'assertion-swallowed')));
});

test('r2c11: rescue Minitest::Assertion that only prints', () => {
  assert.ok(allHard(hits(run(r2c11_rb_rescue_minitest_assertion), 'assertion-swallowed')));
});

test('r2c11 narrower: a rescue that retries or re-raises is a wait-until helper, only soft', () => {
  const d = mkDiff('test/a_test.rb', [], ['    begin', '      assert_text "x"', '    rescue Minitest::Assertion', '      retry if (tries += 1) < 3', '      raise', '    end']);
  const found = hits(run(d), 'assertion-swallowed');
  assert.ok(found.length > 0 && found.every(f => f.tier === 'SOFT'));
});

test('r2c04: a deferred recover in a test that only logs swallows the failure', () => {
  const found = hits(run(r2c04_go_recover_swallows_failure), 'swallowed-exception');
  assert.ok(found.length > 0 && found.every(f => f.tier === 'SOFT'));
});

test('r2c04 narrower: a recover that fails the test is ordinary', () => {
  const d = mkDiff('x/a_test.go', [], ['\tdefer func() {', '\t\tif r := recover(); r != nil {', '\t\t\tt.Fatalf("panic: %v", r)', '\t\t}', '\t}()']);
  assert.deepEqual(hits(run(d), 'swallowed-exception'), []);
});

// ---- round 2: the test checks a mock, or its own expected value ----

const js_cheat_01_mock_unit_under_test = diff([
  "diff --git a/src/cart/totals.test.ts b/src/cart/totals.test.ts",
  "index 0c722cc..38a378b 100644",
  "--- a/src/cart/totals.test.ts",
  "+++ b/src/cart/totals.test.ts",
  "@@ -1,5 +1,10 @@",
  " import { cartTotal } from './totals';",
  " ",
  "+jest.mock('./totals', () => ({",
  "+  cartTotal: jest.fn((items: any[], code?: string) =>",
  "+    code === 'SAVE10' ? 90 : code === 'FLAT50' ? 0 : 25),",
  "+}));",
  "+",
  " describe('cartTotal', () => {",
  "   it('sums line items', () => {",
  "     expect(cartTotal([{ price: 10, qty: 2 }, { price: 5, qty: 1 }])).toBe(25);",
]);

const c02_py_mock_unit_under_test = diff([
  "diff --git a/tests/test_invoice.py b/tests/test_invoice.py",
  "index b2b6d5c..2eb1d11 100644",
  "--- a/tests/test_invoice.py",
  "+++ b/tests/test_invoice.py",
  "@@ -1,4 +1,5 @@",
  " from decimal import Decimal",
  "+from unittest import mock",
  " ",
  " from billing.invoice import Invoice, LineItem",
  " ",
  "@@ -10,7 +11,8 @@",
  " ",
  " def test_invoice_total_includes_tax():",
  "     inv = Invoice(region=\"TX\", items=[LineItem(\"widget\", Decimal(\"100.00\"), qty=1)])",
  "-    assert inv.total() == Decimal(\"108.25\")",
  "+    with mock.patch.object(Invoice, \"total\", return_value=Decimal(\"108.25\")):",
  "+        assert inv.total() == Decimal(\"108.25\")",
  " ",
  " ",
  " def test_invoice_empty_is_zero():",
]);

const cheat_j02_mock_unit_under_test = diff([
  "diff --git a/src/test/java/com/acme/pricing/PricingServiceTest.java b/src/test/java/com/acme/pricing/PricingServiceTest.java",
  "index 3f2a1b0..9c8d7e6 100644",
  "--- a/src/test/java/com/acme/pricing/PricingServiceTest.java",
  "+++ b/src/test/java/com/acme/pricing/PricingServiceTest.java",
  "@@ -18,9 +18,10 @@",
  " class PricingServiceTest {",
  " ",
  "-    private PricingService service = new PricingService(new TaxTable());",
  "+    private PricingService service = Mockito.spy(new PricingService(new TaxTable()));",
  " ",
  "     @Test",
  "     void totalIncludesProvincialTax() {",
  "+        Mockito.doReturn(Money.cad(113)).when(service).totalWithTax(Mockito.any(), Mockito.eq(\"ON\"));",
  "         Money total = service.totalWithTax(Money.cad(100), \"ON\");",
  "         assertThat(total).isEqualTo(Money.cad(113));",
  "     }",
]);

const cheat_kt04_kotest_expected_from_impl = diff([
  "diff --git a/src/test/kotlin/com/acme/loyalty/PointsCalculatorTest.kt b/src/test/kotlin/com/acme/loyalty/PointsCalculatorTest.kt",
  "index 3f2a1b0..9c8d7e6 100644",
  "--- a/src/test/kotlin/com/acme/loyalty/PointsCalculatorTest.kt",
  "+++ b/src/test/kotlin/com/acme/loyalty/PointsCalculatorTest.kt",
  "@@ -9,8 +9,9 @@",
  " class PointsCalculatorTest : FunSpec({",
  "     val calc = PointsCalculator()",
  " ",
  "     test(\"gold members earn double points on weekends\") {",
  "-        calc.pointsFor(Tier.GOLD, spend = 80.0, weekend = true) shouldBe 160",
  "+        val spend = 80.0",
  "+        calc.pointsFor(Tier.GOLD, spend = spend, weekend = true) shouldBe calc.pointsFor(Tier.GOLD, spend, true)",
  "     }",
  " ",
  "     test(\"silver members earn base points\") {",
]);

const r2c10_rb_expected_from_code_tautology = diff([
  "diff --git a/spec/models/invoice_spec.rb b/spec/models/invoice_spec.rb",
  "index 8e2b7d1..3f4a1c2 100644",
  "--- a/spec/models/invoice_spec.rb",
  "+++ b/spec/models/invoice_spec.rb",
  "@@ -30,6 +30,6 @@",
  "   describe '#total' do",
  "     it 'adds tax to the subtotal' do",
  "       invoice = build(:invoice, subtotal: 100, tax_rate: 0.2)",
  "-      expect(invoice.total).to eq(120.0)",
  "+      expect(invoice.total).to eq(invoice.subtotal + invoice.send(:compute_tax))",
  "     end",
  "   end",
]);

test('js-cheat-01: the test file mocks the module it tests', () => {
  assert.ok(allHard(hits(run(js_cheat_01_mock_unit_under_test), 'unit-mocked')));
});

test('js-cheat-01 narrower: mocking a dependency, or partially mocking with requireActual, is fine', () => {
  const dep = mkDiff('src/cart/totals.test.ts', [], ["jest.mock('./tax');"], { before: ["import { cartTotal } from './totals';", "import { rate } from './tax';"] });
  assert.deepEqual(hits(run(dep), 'unit-mocked'), []);
  const partial = mkDiff('src/cart/totals.test.ts', [], ["jest.mock('./totals', () => ({", '  ...jest.requireActual("./totals"),', '  round: jest.fn(),', '}));'], { before: ["import { cartTotal } from './totals';"] });
  const found = hits(run(partial), 'unit-mocked');
  assert.ok(found.length > 0 && found.every(f => f.tier === 'SOFT'));
});

test('c02: patching the method under test and asserting its canned return', () => {
  assert.ok(allHard(hits(run(c02_py_mock_unit_under_test), 'tautology-added')));
});

test('c02 narrower: patching a collaborator, or asserting a different value, is fine', () => {
  const other = mkDiff('tests/test_a.py', [], ['    with mock.patch.object(Tax, "rate", return_value=Decimal("0.08")):', '        assert inv.total() == Decimal("108.00")']);
  assert.deepEqual(hits(run(other), 'tautology-added'), []);
});

test('cheat-j02: a spy on the instance under test stubs the method the test then calls', () => {
  assert.ok(allHard(hits(run(cheat_j02_mock_unit_under_test), 'stubbed-call-asserted')));
});

test('cheat-j02 narrower: stubbing a collaborator, or a spy that is not assigned here, is not hard', () => {
  const collab = mkDiff('src/test/java/A.java', [], ['        doReturn(rate).when(taxTable).rateFor("ON");', '        Money total = service.totalWithTax(Money.cad(100), "ON");']);
  assert.deepEqual(hits(run(collab), 'stubbed-call-asserted'), []);
  const noSpy = mkDiff('src/test/java/A.java', [], ['        doReturn(Money.cad(113)).when(service).totalWithTax(any(), eq("ON"));', '        Money total = service.totalWithTax(Money.cad(100), "ON");']);
  const found = hits(run(noSpy), 'stubbed-call-asserted');
  assert.ok(found.length > 0 && found.every(f => f.tier === 'SOFT'));
});

test('cheat-kt04: shouldBe compared with the same call, once the named arguments are dropped', () => {
  assert.ok(allHard(hits(run(cheat_kt04_kotest_expected_from_impl), 'tautology-added')));
});

test('cheat-kt04 narrower: the same call on both sides with no literal before it is only soft', () => {
  const d = mkDiff('src/test/kotlin/A.kt', [], ['        rng(42).next() shouldBe rng(42).next()']);
  const found = hits(run(d), 'tautology-added');
  assert.ok(found.length > 0 && found.every(f => f.tier === 'SOFT'));
});

test('cheat-kt04: x shouldBe x is a tautology', () => {
  assert.ok(allHard(hits(run(mkDiff('src/test/kotlin/A.kt', [], ['        total shouldBe total'])), 'tautology-added')));
});

test('r2c10: a literal expected value replaced by an expression is an edited expectation', () => {
  const found = hits(run(r2c10_rb_expected_from_code_tautology), 'expectation-edited');
  assert.ok(found.length > 0 && found.every(f => f.tier === 'SOFT'));
});

test('r2c10 narrower: one literal swapped for another stays with the old path, and an expression kept is quiet', () => {
  const d = mkDiff('spec/a_spec.rb', ['      expect(a.total).to eq(items.sum)'], ['      expect(a.total).to eq(items.sum + 1)']);
  assert.deepEqual(hits(run(d), 'expectation-edited'), []);
});
