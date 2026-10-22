// Terminal screenshot maker: node scripts/shoot-terminal.mjs --out docs/img/x.png --title '$ npx red-handed demo' -- <command...>
// Runs the command with FORCE_COLOR=1, turns the ANSI output into HTML, wraps it in a dark
// terminal window and screenshots it with headless Chrome at 2x. No dependencies.
// Options: --cwd <dir>  --env KEY=VAL (repeatable)  --chrome <path>

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// One warm palette for every terminal image. Red is the brand red lifted for a dark background.
export const THEME = { bg: '#141412', bar: '#1b1b18', line: '#3a3934', text: '#f3f0e8', muted: '#8a867c', red: '#ff6b57', redBlock: '#cc1a0a', green: '#7fd08a', yellow: '#e8b64c', ink: '#141412' };
const PALETTE = {
  30: '#5a5850', 31: THEME.red, 32: THEME.green, 33: THEME.yellow, 34: '#8ab4f8', 35: '#c9a0e8', 36: '#7fd0c8', 37: THEME.text,
  90: '#6f6c63', 91: THEME.red, 92: THEME.green, 93: THEME.yellow, 94: '#8ab4f8', 95: '#c9a0e8', 96: '#7fd0c8', 97: '#ffffff',
};
export const COLS = 140; // every terminal image is this many columns wide
export const VERDICTS = { CAUGHT: [THEME.redBlock, '#ffffff'], SUSPICIOUS: [THEME.yellow, THEME.ink], CLEAN: ['#2f8f55', '#ffffff'] };

export const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Parses SGR into lines of runs: [{ text, color, bold, dim }]
export function parseAnsi(input) {
  const lines = [[]];
  let st = { color: null, bold: false, dim: false };
  const re = /\x1b\[([0-9;]*)m|\n|\r/g;
  let last = 0, m;
  const push = (text) => { if (text) lines[lines.length - 1].push({ text, ...st }); };
  while ((m = re.exec(input))) {
    push(input.slice(last, m.index));
    last = re.lastIndex;
    if (m[0] === '\n') { lines.push([]); continue; }
    if (m[0] === '\r') continue;
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (const c of codes) {
      if (c === 0) st = { color: null, bold: false, dim: false };
      else if (c === 1) st = { ...st, bold: true };
      else if (c === 2) st = { ...st, dim: true };
      else if (c === 22) st = { ...st, bold: false, dim: false };
      else if (c === 39) st = { ...st, color: null };
      else if (PALETTE[c]) st = { ...st, color: PALETTE[c] };
    }
  }
  push(input.slice(last));
  while (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
  return lines;
}

export function runsToHtml(runs) {
  return runs.map((r) => {
    const style = [];
    if (r.color) style.push(`color:${r.color}`);
    if (r.bold) style.push('font-weight:700');
    if (r.dim) style.push('opacity:.55');
    const v = r.bold && VERDICTS[r.text.trim()];
    if (v) style.push(`background:${v[0]}`, `color:${v[1]}`, `box-shadow:0 0 0 .4ch ${v[0]}`);
    // U+2716 falls back to a purple color-emoji glyph on Windows, so draw the cross instead
    const t = esc(r.text).replace(/✖/g, '<svg viewBox="0 0 10 10" width="1ch" height="1em" style="vertical-align:-.12em"><path d="M1 2L9 10M9 2L1 10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>');
    return style.length ? `<span style="${style.join(';')}">${t}</span>` : t;
  }).join('');
}

const WIN_W = Math.round(COLS * 8.7 + 56 + 2 + 80);
const FONT = `'JetBrains Mono','Cascadia Code','Cascadia Mono',Consolas,'Segoe UI Symbol','DejaVu Sans Mono',monospace`;

function page({ title, command, lines }) {
  const body = lines.map((l) => `<div class="l">${runsToHtml(l) || '&nbsp;'}</div>`).join('');
  const mark = '<svg viewBox="0 0 16 16" width="16" height="16" style="position:absolute;left:20px;top:12px"><rect width="16" height="16" rx="3.5" fill="#f3f0e8"/><path fill="#141414" d="M4 3H7V13H4Z"/><path fill="#cc1a0a" d="M7 5C7.4 3.7 8.3 3 9.8 3H12V7H10.2C8.6 7 7.6 7.7 7 9Z"/></svg>';
  return `<!doctype html><meta charset="utf-8"><link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
html,body{margin:0;background:#0b0b0a}
body{padding:40px;box-sizing:border-box;width:${WIN_W}px}
.win{font:400 14.5px/1.55 ${FONT};width:calc(${COLS}ch + 56px);background:${THEME.bg};border:1px solid ${THEME.line};box-shadow:0 20px 50px rgba(0,0,0,.6);overflow:hidden}
.bar{height:40px;background:${THEME.bar};position:relative;border-bottom:1px solid ${THEME.line}}
.ttl{position:absolute;left:0;right:0;top:0;text-align:center;font:500 13px/40px ${FONT};color:${THEME.muted}}
pre{margin:0;padding:20px 28px 24px;font:inherit;color:${THEME.text};white-space:pre;font-variant-ligatures:none;font-feature-settings:'liga' 0,'calt' 0;font-variant-emoji:text}
.l{min-height:1.55em}.p{color:${THEME.red}}
</style>
<div class="win"><div class="bar">${mark}<div class="ttl">${esc(title)}</div></div>
<pre><div class="l"><span class="p">$</span> ${esc(command)}</div><div class="l">&nbsp;</div>${body}</pre></div>`;
}

function main() {
  const argv = process.argv.slice(2);
  const opts = { env: {} };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { i++; break; }
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--title') opts.title = argv[++i];
    else if (a === '--cwd') opts.cwd = argv[++i];
    else if (a === '--chrome') opts.chrome = argv[++i];
    else if (a === '--env') { const [k, ...v] = argv[++i].split('='); opts.env[k] = v.join('='); }
  }
  const cmd = argv.slice(i);
  if (!opts.out || !cmd.length) { console.error('usage: shoot-terminal.mjs --out file.png [--title "$ cmd"] -- command args'); process.exit(2); }
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: opts.cwd, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '1', ...opts.env } });
  const lines = parseAnsi((r.stdout || '') + (r.stderr || ''));
  const title = opts.title || '$ ' + cmd.join(' ');
  const command = title.replace(/^\$ /, '');
  const longest = Math.max(...lines.map((l) => l.reduce((n, x) => n + [...x.text].length, 0)), command.length + 2);
  if (longest > COLS - 2) { console.error(`a line is ${longest} columns, the frame holds ${COLS - 2}`); process.exit(1); }
  const html = page({ title, command, lines });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shoot-'));
  const file = path.join(tmp, 'term.html');
  fs.writeFileSync(file, html);
  const H = 40 + 40 + 40 + 24 + 20 + Math.round((lines.length + 2) * 14.5 * 1.55) + 4;
  const chrome = opts.chrome || process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  const c = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${path.join(tmp, 'profile')}`,
    '--force-device-scale-factor=2', `--window-size=${WIN_W},${H}`, '--virtual-time-budget=6000',
    `--screenshot=${path.resolve(opts.out)}`, pathToFileURL(file).href], { encoding: 'utf8' });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!fs.existsSync(path.resolve(opts.out))) { console.error(c.error || c.stderr || c.status); process.exit(1); }
  console.log('wrote', opts.out);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
