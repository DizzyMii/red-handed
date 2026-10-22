import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { markdown } from '../src/report.mjs';
import { mkDiff, run } from './helpers.mjs';

const yml = fs.readFileSync(new URL('../action.yml', import.meta.url), 'utf8');

test('action.yml has no tabs, which YAML forbids for indentation', () => {
  assert.ok(!yml.includes('\t'));
});

test('action.yml declares the three inputs and a composite run', () => {
  for (const key of ['name: red-handed', 'inputs:', '  fail-on:', '  comment:', '  base:', 'using: composite']) {
    assert.ok(yml.includes(key), `missing ${key}`);
  }
});

test('the scan step has an id because later steps read its output', () => {
  assert.match(yml, /- id: scan\r?\n/);
  assert.ok(yml.includes('steps.scan.outputs.code'));
});

test('the verdict step greps for a heading the markdown report really prints', () => {
  const m = yml.match(/grep -q "([^"]+)"/);
  assert.ok(m);
  const result = run(mkDiff('src/a.js', [], ['// TODO: fix this later']));
  assert.equal(result.verdict, 'SUSPICIOUS');
  assert.ok(markdown(result).includes(m[1]));
});

test('the comment step finds its own comment by the marker the report starts with', () => {
  const marker = markdown(run(mkDiff('src/a.js', ['a'], ['b']))).split('\n')[0];
  assert.ok(yml.includes(`startswith("${marker}")`));
});

test('the comment step does not accept pull_request_target, which checks out the base branch', () => {
  assert.ok(!yml.includes('pull_request_target'));
});

test('the scan step stops with an error when the checkout is the base itself', () => {
  assert.ok(yml.includes('git rev-parse HEAD'));
  assert.match(yml, /echo "code=2" >> "\$GITHUB_OUTPUT"/);
});
