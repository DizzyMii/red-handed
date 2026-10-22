import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RULES } from '../src/rules.mjs';

const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('every rule id has its own row in the README table', () => {
  for (const r of RULES) {
    const row = readme.split('\n').find(l => l.startsWith('|') && l.includes(`\`${r.id}\``));
    assert.ok(row, `README has no table row for ${r.id}`);
    assert.ok(row.includes(r.tier), `${r.id} row should say ${r.tier}`);
  }
});

test('the README rule count matches the rules', () => {
  assert.ok(readme.includes(`${RULES.length} fixed checks`));
});

test('the README opens with the demo command and a real CAUGHT report', () => {
  assert.ok(readme.indexOf('npx red-handed demo') < readme.indexOf('CAUGHT'));
  assert.match(readme, /CAUGHT\s+4 hard, 1 soft/);
});

test('the README has no em-dashes', () => {
  assert.ok(!readme.includes('—'));
});

test('the README says which rules read comment lines', () => {
  const line = readme.split('\n').find(l => l.startsWith('Comment lines are ignored'));
  assert.ok(line);
  assert.ok(line.includes('`todo-added`') && line.includes('`suppression-added`'));
});
