import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'red-handed.mjs');

function capture() {
  const out = { stdout: '', stderr: '' };
  return {
    out,
    io: {
      stdout: { write: (s) => { out.stdout += s; } },
      stderr: { write: (s) => { out.stderr += s; } },
      env: {},
      fetch: undefined,
      cwd: root,
      stdin: undefined,
    },
  };
}

test('--help and -h print usage with examples and exit 0', async () => {
  for (const flag of ['--help', '-h']) {
    const { out, io } = capture();
    assert.equal(await main([flag], io), 0);
    assert.match(out.stdout, /^red-handed: catch AI agents/);
    assert.match(out.stdout, /npx red-handed demo/);
    assert.ok(out.stdout.trimEnd().split('\n').length < 25);
  }
});

test('--version and -v print the package.json version', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const flag of ['--version', '-v']) {
    const { out, io } = capture();
    assert.equal(await main([flag], io), 0);
    assert.equal(out.stdout, `${pkg.version}\n`);
  }
});

test('an unknown flag exits 2 and shows usage on stderr', async () => {
  const { out, io } = capture();
  assert.equal(await main(['--bogus'], io), 2);
  assert.match(out.stderr, /^red-handed: unknown option --bogus\n/);
  assert.match(out.stderr, /Usage:/);
  assert.equal(out.stdout, '');
});

test('an unknown target exits 2 with the expected forms', async () => {
  const { out, io } = capture();
  assert.equal(await main(['nope.diff'], io), 2);
  assert.match(out.stderr, /unknown target "nope\.diff": expected a GitHub PR URL, owner\/repo#N, a \.diff file or -/);
});

test('bin runs main and exits with its code', () => {
  const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  const bad = spawnSync(process.execPath, [bin, '--bogus'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});
