import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegex, matchesAny } from '../src/glob.mjs';

const hit = (glob, path) => globToRegex(glob).test(path);

test('single star stays inside one segment', () => {
  assert.equal(hit('src/*.js', 'src/a.js'), true);
  assert.equal(hit('src/*.js', 'src/x/a.js'), false);
});

test('double star crosses segments', () => {
  assert.equal(hit('src/**', 'src/a/b/c.js'), true);
  assert.equal(hit('**/*.test.js', 'a/b/c.test.js'), true);
  assert.equal(hit('**/*.test.js', 'c.test.js'), true);
});

test('question mark matches one non-slash character', () => {
  assert.equal(hit('a?.js', 'ab.js'), true);
  assert.equal(hit('a?.js', 'a/b.js'), false);
});

test('brace alternatives', () => {
  assert.equal(hit('*.{js,ts}', 'x.ts'), true);
  assert.equal(hit('*.{js,ts}', 'x.js'), true);
  assert.equal(hit('*.{js,ts}', 'x.py'), false);
  assert.equal(hit('src/{a,b}/*.js', 'src/b/x.js'), true);
  assert.equal(hit('src/{a,b}/*.js', 'src/c/x.js'), false);
});

test('an unmatched brace is literal', () => {
  assert.equal(hit('a{b.js', 'a{b.js'), true);
});

test('regex metacharacters are escaped', () => {
  assert.equal(hit('a+b.js', 'a+b.js'), true);
  assert.equal(hit('a+b.js', 'aab.js'), false);
  assert.equal(hit('(x).js', '(x).js'), true);
  assert.equal(hit('a.js', 'aXjs'), false);
});

test('matching is case-insensitive', () => {
  assert.equal(hit('Makefile', 'makefile'), true);
  assert.equal(hit('*.JS', 'a.js'), true);
});

test('a glob with no slash matches the basename anywhere', () => {
  assert.equal(hit('*.snap', 'deep/nested/a.snap'), true);
  assert.equal(hit('*.snap', 'a.snap'), true);
  assert.equal(hit('build.gradle', 'app/build.gradle'), true);
  assert.equal(hit('src/*.snap', 'other/src/a.snap'), false);
});

test('matchesAny checks every glob and normalizes backslashes', () => {
  assert.equal(matchesAny('e2e/login.js', ['x/**', 'e2e/**']), true);
  assert.equal(matchesAny('src/a.js', ['e2e/**']), false);
  assert.equal(matchesAny('e2e\\login.js', ['e2e/**']), true);
  assert.equal(matchesAny('a.js', []), false);
  assert.equal(matchesAny('a.js', undefined), false);
  assert.equal(matchesAny(null, ['*']), false);
});
