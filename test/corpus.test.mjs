// The real-diff corpus under docs/internal/corpus, which is never committed. Each case is a
// trimmed diff from the owner's repos with snapshots of the files around it; this only runs them
// when the folder is there and RH_CORPUS is set (the 40 cases take about eight minutes), and
// holds no repo content itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const runner = new URL('../docs/internal/corpus/run.mjs', import.meta.url);
const ids = process.env.RH_CORPUS && existsSync(runner) ? (await import(runner)).caseDirs() : [];
if (!ids.length) {
  test('corpus', { skip: 'set RH_CORPUS=1 with docs/internal/corpus checked out' }, () => {});
} else {
  const { runCase } = await import(runner);
  for (const id of ids) {
    test(`corpus #${id}`, () => {
      const r = runCase(id);
      assert.notEqual(r.judgement, 'FAIL', `expected ${r.expected.verdict}${r.expected.accept ? ' or ' + r.expected.accept : ''}, got ${r.actual}: ${r.expected.reason}`);
    });
  }
}
