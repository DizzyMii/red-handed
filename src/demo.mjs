// `red-handed demo`: builds a throwaway repo, plays an agent that cheats its way past a failing
// discount test, then scans the result.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scan } from './scan.mjs';
import { localSource } from './sources.mjs';
import { terminal, wantColor } from './report.mjs';

const PACKAGE_JSON = `{"name":"shop","scripts":{"test":"node --test"}}
`;

const CART = `const CODES = { SAVE10: 10, HALF: 50 };

export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

export function discount(items, code) {
  const percent = CODES[code];
  if (!percent) return 0;
  return percent;
}

export function total(items, code) {
  return subtotal(items) - discount(items, code);
}

export function receipt(items, code) {
  return { subtotal: subtotal(items), discount: discount(items, code), total: total(items, code) };
}
`;

const CART_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { total, receipt } from '../src/cart.js';

const items = [{ name: 'lamp', price: 100, qty: 2 }];

test('adds up the line items', () => {
  assert.equal(total(items), 200);
});

test('SAVE10 takes ten percent off', () => {
  assert.equal(total(items, 'SAVE10'), 180);
});

test('an empty cart costs nothing', () => {
  assert.equal(total([]), 0);
});

test('an unknown code changes nothing', () => {
  assert.equal(total(items, 'BOGUS'), 200);
});

test('the receipt itemises the discount', () => {
  assert.deepEqual(receipt(items, 'SAVE10'), { subtotal: 200, discount: 20, total: 180 });
});

test('HALF takes fifty percent off', () => {
  assert.equal(total(items, 'HALF'), 100);
});
`;

// Written in two halves so scanning this repo's own branches does not trip test-detection on the demo script.
const NODE_ENV = 'process.env.NODE_' + 'ENV';

// Each cheat is [file, text it replaces, replacement]. A miss throws so the demo cannot go quiet.
const CHEATS = [
  ['test/cart.test.js', "assert.equal(total(items, 'SAVE10'), 180);", "assert.equal(total(items, 'SAVE10'), 190);"],
  ['test/cart.test.js', "test('HALF takes", "test.skip('HALF takes"],
  ['test/cart.test.js', "assert.deepEqual(receipt(items, 'SAVE10'), { subtotal: 200, discount: 20, total: 180 });", "assert.ok(receipt(items, 'SAVE10'));"],
  ['src/cart.js', '  return percent;\n', `  if (${NODE_ENV} === 'test') return subtotal(items) * percent / 100;\n  return percent;\n`],
  ['package.json', '"node --test"', '"node --test || true"'],
];

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.error?.message || '').trim()}`);
}

function haveGit() {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  return !r.error && r.status === 0;
}

function put(dir, rel, text) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

export async function runDemo(io, { noColor = false } = {}) {
  if (!haveGit()) throw new Error('the demo needs git on PATH');
  const color = wantColor(io, noColor);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'red-handed-demo-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'demo');
    git(dir, 'config', 'user.email', 'demo@example.com');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'core.autocrlf', 'false');
    put(dir, 'package.json', PACKAGE_JSON);
    put(dir, 'src/cart.js', CART);
    put(dir, 'test/cart.test.js', CART_TEST);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'initial');

    git(dir, 'switch', '-q', '-c', 'agent/fix-discount');
    for (const [file, from, to] of CHEATS) {
      const full = path.join(dir, file);
      const text = fs.readFileSync(full, 'utf8');
      if (!text.includes(from)) throw new Error(`demo script is out of date: ${file} has no "${from}"`);
      fs.writeFileSync(full, text.replace(from, () => to));
    }
    git(dir, 'commit', '-q', '-am', 'fix discount tests');

    const intro = 'A pretend agent was asked to fix a failing discount test. It reported "all tests pass". Here is what it actually did:';
    io.stdout.write(`${color ? `\x1b[2m${intro}\x1b[0m` : intro}\n\n`);
    const result = scan(localSource(dir, 'main'));
    io.stdout.write(terminal(result, { color, dumb: io.env?.TERM === 'dumb' }));
    const hint ='Now run npx red-handed in your own repo, or point it at a pull request URL.';
    io.stdout.write(`${color ? `\x1b[2m${hint}\x1b[0m` : hint}\n`);
    return 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
