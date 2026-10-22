import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDemo } from '../src/demo.mjs';
import { main } from '../src/cli.mjs';

function capture(extra = {}) {
  const out = { stdout: '', stderr: '' };
  return {
    out,
    io: {
      stdout: { write: (s) => { out.stdout += s; } },
      stderr: { write: (s) => { out.stderr += s; } },
      env: {},
      cwd: process.cwd(),
      ...extra,
    },
  };
}

// Points os.tmpdir() at a private folder for the length of fn, so the test can see what the demo leaves behind.
async function withTmp(fn) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-demo-test-'));
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TMPDIR = process.env.TEMP = process.env.TMP = scratch;
  try {
    return await fn(scratch);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

test('the demo catches all five tricks and cleans up its temp dir', async () => {
  await withTmp(async (scratch) => {
    const { out, io } = capture();
    assert.equal(await runDemo(io), 0);
    assert.match(out.stdout, /CAUGHT/);
    for (const rule of ['test-detection', 'test-skipped', 'assertion-weakened', 'expectation-edited', 'test-command-neutered']) {
      assert.ok(out.stdout.includes(rule), rule);
    }
    assert.match(out.stdout, /^A pretend agent was asked to fix a failing discount test\./);
    assert.deepEqual(fs.readdirSync(scratch), []);
  });
});

test('each trick is pinned to the line that did it', async () => {
  const { out, io } = capture();
  await runDemo(io);
  assert.match(out.stdout, /\+ test\.skip\('HALF takes/);
  assert.match(out.stdout, /\+ assert\.ok\(receipt\(/);
  assert.match(out.stdout, /\+ if \(process\.env\.NODE_ENV === 'test'\)/);
  assert.match(out.stdout, /"test":"node --test \|\| true"/);
  assert.match(out.stdout, /- assert\.equal\(total\(items, 'SAVE10'\), 180\)/);
  assert.match(out.stdout, /\+ assert\.equal\(total\(items, 'SAVE10'\), 190\)/);
});

test('the demo has no colour codes unless asked for', async () => {
  const plain = capture();
  await runDemo(plain.io);
  assert.doesNotMatch(plain.out.stdout, /\x1b\[/);
  const forced = capture({ env: { FORCE_COLOR: '1' } });
  await runDemo(forced.io);
  assert.match(forced.out.stdout, /\x1b\[1;31mCAUGHT/);
});

test('demo through the cli exits 0 even though the verdict is CAUGHT', async () => {
  const { out, io } = capture();
  assert.equal(await main(['demo'], io), 0);
  assert.match(out.stdout, /CAUGHT/);
});

test('without git on PATH the demo says so and the cli exits 2', async () => {
  const saved = { PATH: process.env.PATH, Path: process.env.Path };
  process.env.PATH = '';
  if (process.env.Path !== undefined) process.env.Path = '';
  try {
    const { out, io } = capture();
    assert.equal(await main(['demo'], io), 2);
    assert.match(out.stderr, /red-handed: the demo needs git on PATH/);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});
