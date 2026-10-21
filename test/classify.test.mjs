import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTestPath, language, isSourcePath, isSnapshotPath, isCiPath, isBuildPath, ASSERT, isCommentLine,
} from '../src/classify.mjs';

test('isTestPath recognises each ecosystem layout', () => {
  for (const p of [
    'test/cart.js', 'tests/unit/a.js', 'src/__tests__/x.js', 'spec/models/user.rb', 'testing/a.go',
    'src/cart.spec.ts', 'src/cart.test.mjs', 'src/cart.test.cjs', 'pkg/test_util.py', 'pkg/util_test.py',
    'conftest.py', 'src/test/java/FooTest.java', 'lib/FooTests.kt', 'internal/store_test.go',
    'Shop.Tests/BarTests.cs', 'Shop/CartTest.cs', 'spec/a_spec.rb', 'test/a_test.rb',
  ]) assert.equal(isTestPath(p), true, p);
});

test('isTestPath rejects ordinary source paths', () => {
  for (const p of [
    'src/cart.js', 'src/contest.js', 'src/testimony/a.js', 'docs/testing-guide.md', 'src/latest-news.ts',
  ]) assert.equal(isTestPath(p), false, p);
});

test('isTestPath accepts backslash paths and config globs', () => {
  assert.equal(isTestPath('test\\cart.js'), true);
  assert.equal(isTestPath('e2e/login.js'), false);
  assert.equal(isTestPath('e2e/login.js', ['e2e/**']), true);
  assert.equal(isTestPath('src/a.js', ['e2e/**']), false);
});

test('language maps extensions to families', () => {
  assert.equal(language('a.tsx'), 'js');
  assert.equal(language('a.MJS'), 'js');
  assert.equal(language('a.py'), 'py');
  assert.equal(language('A.kt'), 'jvm');
  assert.equal(language('a.go'), 'go');
  assert.equal(language('a.rs'), 'rust');
  assert.equal(language('a.cs'), 'cs');
  assert.equal(language('a.rb'), 'rb');
  assert.equal(language('README.md'), 'other');
  assert.equal(language('constructor'), 'other');
});

test('isSourcePath excludes tests, vendored code, minified and declaration files', () => {
  assert.equal(isSourcePath('src/cart.js'), true);
  assert.equal(isSourcePath('test/cart.test.js'), false);
  assert.equal(isSourcePath('node_modules/x/index.js'), false);
  assert.equal(isSourcePath('dist/app.js'), false);
  assert.equal(isSourcePath('build/out.js'), false);
  assert.equal(isSourcePath('vendor/lib/a.go'), false);
  assert.equal(isSourcePath('src/app.min.js'), false);
  assert.equal(isSourcePath('types/a.d.ts'), false);
  assert.equal(isSourcePath('README.md'), false);
});

test('isSnapshotPath', () => {
  for (const p of [
    '__snapshots__/a.snap.js', 'x.snap', 'a.ambr', 'testdata/out.golden', 'foo.golden',
    'a.approved.txt', 'a.received.json',
  ]) assert.equal(isSnapshotPath(p), true, p);
  assert.equal(isSnapshotPath('src/a.js'), false);
});

test('isCiPath', () => {
  for (const p of [
    '.github/workflows/ci.yml', '.github/workflows/ci.yaml', '.gitlab-ci.yml', '.circleci/config.yml',
    'azure-pipelines.yml', 'Jenkinsfile', '.travis.yml', 'bitbucket-pipelines.yml',
  ]) assert.equal(isCiPath(p), true, p);
  assert.equal(isCiPath('.github/dependabot.yml'), false);
  assert.equal(isCiPath('docker-compose.yml'), false);
});

test('isBuildPath matches config basenames at any depth', () => {
  for (const p of [
    'package.json', 'Makefile', 'jest.config.ts', 'vitest.config.mts', '.mocharc.yaml',
    'playwright.config.js', 'app/Foo.csproj', 'Cargo.toml', 'pyproject.toml', 'pkg/build.gradle.kts',
  ]) assert.equal(isBuildPath(p), true, p);
  for (const p of ['src/package.js', 'jest.config.py', 'src/Makefile.md']) {
    assert.equal(isBuildPath(p), false, p);
  }
});

test('ASSERT matches assertion calls in common frameworks', () => {
  for (const line of [
    'expect(total(cart)).toBe(90)', 'assert True', 'assert x == 1',
    'self.assertEqual(a, b)', 'Assert.AreEqual(1, x)', 'assertThat(x)', 'assert_eq!(a, b)',
    'panic!("x")', 'should.equal(x)',
  ]) assert.equal(ASSERT.test(line), true, line);
});

test('ASSERT ignores lines that only look like assertions', () => {
  for (const line of ['const total = compute(cart)', 'return cart.items.length', 'let assertion_count = 0']) {
    assert.equal(ASSERT.test(line), false, line);
  }
});

test('isCommentLine catches comment markers', () => {
  for (const line of ['// it.skip(', '  # python', '/* a', ' * doc', '-- sql']) {
    assert.equal(isCommentLine(line), true, line);
  }
});

test('isCommentLine lets Rust attributes and python pragmas through', () => {
  for (const line of ['#[derive(Debug)]', '# type: ignore', '# noqa: E501', '# pylint: disable=x']) {
    assert.equal(isCommentLine(line), false, line);
  }
  assert.equal(isCommentLine('const a = 1'), false);
  assert.equal(isCommentLine(''), false);
});
