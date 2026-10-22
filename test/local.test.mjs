import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localSource, fileSource, stdinSource } from '../src/sources.mjs';
import { mkDiff } from './helpers.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'red-handed.mjs');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-local-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let n = 0;
const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const rh = (cwd, ...args) => {
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

const TEST_FILE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
test('adds', () => {
  assert.equal(1 + 1, 2);
});
`;

// A repo with one commit on main.
function repo({ commit = true } = {}) {
  const dir = path.join(tmpRoot, `r${n++}`);
  fs.mkdirSync(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'demo');
  sh(dir, 'config', 'user.email', 'demo@example.com');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  if (commit) {
    write(dir, 'src/a.js', 'export const a = 1;\n');
    write(dir, 'test/a.test.js', TEST_FILE);
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'initial');
  }
  return dir;
}

test('clean tree against main is CLEAN with a note', () => {
  const dir = repo();
  const r = rh(dir, '--json');
  assert.equal(r.status, 0);
  const res = JSON.parse(r.stdout);
  assert.equal(res.verdict, 'CLEAN');
  assert.ok(res.notes.includes('no changes to scan'));
});

test('a committed change on a branch is scanned against main', () => {
  const dir = repo();
  sh(dir, 'switch', '-q', '-c', 'agent/fix');
  write(dir, 'test/a.test.js', TEST_FILE.replace("test('adds'", "test.skip('adds'"));
  sh(dir, 'commit', '-q', '-am', 'fix');
  const r = rh(dir, '--json');
  assert.equal(r.status, 1);
  const res = JSON.parse(r.stdout);
  assert.equal(res.verdict, 'CAUGHT');
  assert.equal(res.findings[0].rule, 'test-skipped');
  assert.match(res.source.label, /^agent\/fix vs main \(/);
  assert.equal(res.source.base, 'main');
});

test('unstaged and staged edits count too', () => {
  const dir = repo();
  write(dir, 'src/a.js', 'export const a = 1; // TODO fix\n');
  write(dir, 'test/a.test.js', TEST_FILE.replace('assert.equal(1 + 1, 2)', 'assert.ok(1)'));
  sh(dir, 'add', 'test/a.test.js');
  const res = JSON.parse(rh(dir, '--json').stdout);
  const rules = res.findings.map(f => f.rule);
  assert.ok(rules.includes('todo-added'));
  assert.ok(rules.includes('assertion-weakened'));
});

test('an untracked new test file with it.only is caught', () => {
  const dir = repo();
  write(dir, 'test/new.test.js', "it.only('x', () => {});\n");
  const r = rh(dir, '--json');
  assert.equal(r.status, 1);
  const f = JSON.parse(r.stdout).findings.find(x => x.rule === 'test-focused');
  assert.equal(f.file, 'test/new.test.js');
  assert.equal(f.line, 1);
});

test('untracked binary files are skipped and counted in a note', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([1, 0, 2, 0]));
  const res = JSON.parse(rh(dir, '--json').stdout);
  assert.ok(res.notes.includes('skipped 1 large or binary untracked files'));
});

test('a repo with no commits scans staged and untracked files as added', () => {
  const dir = repo({ commit: false });
  write(dir, 'test/a.test.js', "it.skip('x', () => {});\n");
  sh(dir, 'add', '.');
  write(dir, 'test/b.test.js', "it.only('y', () => {});\n");
  const r = rh(dir, '--json');
  assert.equal(r.status, 1);
  const res = JSON.parse(r.stdout);
  assert.deepEqual(res.findings.map(f => f.rule).sort(), ['test-focused', 'test-skipped']);
  assert.match(res.source.label, /no commits yet/);
});

test('with no main branch the base is HEAD and the label says so', () => {
  const dir = repo();
  sh(dir, 'branch', '-m', 'trunk');
  write(dir, 'src/a.js', 'export const a = 2;\n');
  const src = localSource(dir, null);
  assert.equal(src.label, 'trunk, uncommitted changes');
  assert.equal(src.base, 'HEAD');
  assert.match(src.diffText, /\+export const a = 2;/);
});

test('--base picks the comparison ref', () => {
  const dir = repo();
  write(dir, 'src/a.js', 'export const a = 2;\n');
  sh(dir, 'commit', '-q', '-am', 'second');
  write(dir, 'test/a.test.js', TEST_FILE.replace("test('adds'", "test.skip('adds'"));
  sh(dir, 'commit', '-q', '-am', 'skip');
  const res = JSON.parse(rh(dir, '--base', 'HEAD~1', '--json').stdout);
  assert.equal(res.source.base, 'HEAD~1');
  assert.equal(res.findings.length, 1);
  assert.equal(res.stats.files, 1);
});

test('an unknown --base ref exits 2', () => {
  const dir = repo();
  const r = rh(dir, '--base', 'nope');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /red-handed: unknown base ref "nope"/);
});

test('outside a git repository exits 2', () => {
  const dir = path.join(tmpRoot, 'plain');
  fs.mkdirSync(dir);
  const r = rh(dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not inside a git repository/);
});

test('works from a subdirectory', () => {
  const dir = repo();
  write(dir, 'test/new.test.js', "it.only('x', () => {});\n");
  const r = rh(path.join(dir, 'src'), '--json');
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).findings[0].file, 'test/new.test.js');
});

test('paths with spaces and unicode come through unquoted', () => {
  const dir = repo();
  write(dir, 'test/my tëst.test.js', 'x\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'add');
  fs.writeFileSync(path.join(dir, 'test/my tëst.test.js'), "it.skip('x', () => {});\n");
  const res = JSON.parse(rh(dir, '--base', 'HEAD', '--json').stdout);
  assert.equal(res.findings[0].file, 'test/my tëst.test.js');
});

test('the allow list is read from the base side only', () => {
  const dir = repo();
  write(dir, '.red-handed.json', JSON.stringify({ allow: [{ rule: 'test-focused', path: 'test/**', reason: 'ok' }] }));
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'config');
  sh(dir, 'switch', '-q', '-c', 'work');
  write(dir, 'test/new.test.js', "it.only('x', () => {});\n");
  let res = JSON.parse(rh(dir, '--base', 'main', '--json').stdout);
  assert.equal(res.verdict, 'CLEAN');
  assert.equal(res.stats.allowed, 1);
  // Editing the file on the branch changes nothing about what is allowed, and is itself flagged.
  write(dir, '.red-handed.json', JSON.stringify({ allow: [{ rule: 'test-skipped', path: '**', reason: 'me' }] }));
  write(dir, 'test/s.test.js', "it.skip('x', () => {});\n");
  res = JSON.parse(rh(dir, '--base', 'main', '--json').stdout);
  assert.ok(res.findings.some(f => f.rule === 'allowlist-edited'));
  assert.ok(res.findings.some(f => f.rule === 'test-skipped'));
});

test('--strict turns SUSPICIOUS into exit 1', () => {
  const dir = repo();
  write(dir, 'src/a.js', 'export const a = 1; // TODO later\n');
  assert.equal(rh(dir).status, 0);
  assert.equal(rh(dir, '--strict').status, 1);
});

test('terminal output through the bin carries the verdict and the offending line', () => {
  const dir = repo();
  write(dir, 'test/new.test.js', "it.only('x', () => {});\n");
  const r = rh(dir);
  assert.match(r.stdout, /CAUGHT {3}1 hard, 0 soft/);
  assert.match(r.stdout, /\+ it\.only\('x'/);
});

test('a diff file target is scanned and config is not read', () => {
  const dir = repo();
  const file = path.join(tmpRoot, 'x.diff');
  fs.writeFileSync(file, mkDiff('test/a.test.js', [], ["it.skip('x', () => {})"]));
  const r = rh(dir, file, '--json');
  assert.equal(r.status, 1);
  const res = JSON.parse(r.stdout);
  assert.equal(res.source.kind, 'file');
  assert.ok(res.notes.includes('config not read in file mode'));
  assert.equal(fileSource(file).baseFile('x'), null);
});

test('stdin target reads the piped diff', () => {
  const dir = repo();
  const r = spawnSync(process.execPath, [bin, '-', '--json'], {
    cwd: dir, encoding: 'utf8', input: mkDiff('test/a.test.js', [], ["it.only('x', () => {})"]),
  });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).source.kind, 'stdin');
});

test('stdin on a TTY is refused and a missing file fails cleanly', async () => {
  await assert.rejects(stdinSource({ isTTY: true }), /nothing on stdin/);
  assert.throws(() => fileSource(path.join(tmpRoot, 'missing.diff')), /could not read/);
});
