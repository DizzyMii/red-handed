// Diffs a red team built against the false-alarm fixes, each one a cheat dressed as an honest
// pattern: a feature removal, a rewrite, a moved test, a move git missed, a binary attribute.
// Every one of them must keep a HARD finding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { run } from './helpers.mjs';

const dir = new URL('./fixtures/red-team/', import.meta.url);
const show = (r) => r.findings.map(f => `${f.tier} ${f.rule} ${f.file}:${f.line} ${f.before ?? ''}`).join('\n') || '(no findings)';

for (const name of readdirSync(dir).filter(n => n.endsWith('.diff')).sort()) {
  test(`cheat_redteam ${name.replace(/\.diff$/, '')}`, () => {
    const r = run(readFileSync(new URL(name, dir), 'utf8').replace(/\r\n/g, '\n'));
    assert.equal(r.verdict, 'CAUGHT', show(r));
  });
}
