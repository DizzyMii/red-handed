// node site/check.mjs
// Scans every playground cheat with the same engine the page imports and checks the verdicts
// the page promises. Run it after touching cheats.js or the rules.

import { scan } from '../src/scan.mjs';
import { CHEATS, WHOLE_DEMO } from './cheats.js';

const EXPECT = {
  demo: ['CAUGHT', 4, 1],
  expect: ['SUSPICIOUS', 0, 1],
  skip: ['CAUGHT', 1, 0],
  weaken: ['CAUGHT', 1, 0],
  detect: ['CAUGHT', 1, 0],
  neuter: ['CAUGHT', 1, 0],
  delete: ['CAUGHT', 1, 0],
  only: ['CAUGHT', 1, 0],
  timeout: ['SUSPICIOUS', 0, 2],
  honest: ['CLEAN', 0, 0],
};

const src = (diffText) => ({
  kind: 'diff', label: 'x', base: null, url: null, title: null, author: null, authorIsBot: null,
  diffText, untracked: [], baseFile: () => null,
});

let bad = 0;
for (const c of [WHOLE_DEMO, ...CHEATS]) {
  const r = scan(src(c.diff));
  const hard = r.findings.filter(f => f.tier === 'HARD').length;
  const got = [r.verdict, hard, r.findings.length - hard];
  const want = EXPECT[c.id];
  const ok = want && got.join() === want.join();
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.id.padEnd(8)} ${r.verdict.padEnd(10)} ${r.findings.map(f => `${f.rule} ${f.file}:${f.line}`).join(' | ')}`);
}
process.exit(bad ? 1 : 0);
