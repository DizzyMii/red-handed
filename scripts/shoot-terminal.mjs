// Terminal screenshot maker: node scripts/shoot-terminal.mjs --out docs/img/x.png --title '$ npx red-handed demo' -- <command...>
// Runs the command with FORCE_COLOR=1, turns the ANSI output into HTML, wraps it in a dark
// terminal window and screenshots it with headless Chrome at 2x. No dependencies.
// Options: --cwd <dir>  --width <px> (default 980)  --env KEY=VAL (repeatable)  --chrome <path>

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PALETTE = {
  30: '#45475a', 31: '#f7768e', 32: '#9ece6a', 33: '#e0af68', 34: '#7aa2f7', 35: '#bb9af7', 36: '#7dcfff', 37: '#c0caf5',
  90: '#6b7089', 91: '#ff899d', 92: '#b9f27c', 93: '#ffc777', 94: '#89b4fa', 95: '#cba6f7', 96: '#8ad6ff', 97: '#ffffff',
};

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
    // U+2716 falls back to a purple color-emoji glyph on Windows, so draw the cross instead
    const t = esc(r.text).replace(/✖/g, '<svg viewBox="0 0 10 10" width="1ch" height="1em" style="vertical-align:-.12em"><path d="M1 2L9 10M9 2L1 10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>');
    return style.length ? `<span style="${style.join(';')}">${t}</span>` : t;
  }).join('');
}

const FONT = `'JetBrains Mono','Cascadia Code','Cascadia Mono',Consolas,'Segoe UI Symbol','DejaVu Sans Mono',monospace`;

function page({ title, command, lines, width }) {
  const body = lines.map((l) => `<div class="l">${runsToHtml(l) || '&nbsp;'}</div>`).join('');
  return `<!doctype html><meta charset="utf-8"><link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
html,body{margin:0;background:#0d0f17}
body{padding:40px;box-sizing:border-box;width:${width + 80}px;background:radial-gradient(circle at 20% 0,#1d2036,#0d0f17 70%)}
.win{width:${width}px;background:#16161e;border-radius:12px;border:1px solid #2a2e45;box-shadow:0 24px 60px rgba(0,0,0,.55);overflow:hidden}
.bar{height:40px;background:#1c1d2b;display:flex;align-items:center;padding:0 16px;position:relative;border-bottom:1px solid #2a2e45}
.dot{width:12px;height:12px;border-radius:50%;margin-right:8px}
.ttl{position:absolute;left:0;right:0;text-align:center;font:500 13px ${FONT};color:#8b90a8}
pre{margin:0;padding:20px 24px 24px;font:400 14.5px/1.55 ${FONT};color:#c0caf5;white-space:pre;font-variant-ligatures:none;font-feature-settings:'liga' 0,'calt' 0;font-variant-emoji:text}
.l{min-height:1.55em}.p{color:#7aa2f7}
</style>
<div class="win"><div class="bar"><i class="dot" style="background:#ff5f56"></i><i class="dot" style="background:#ffbd2e"></i><i class="dot" style="background:#27c93f"></i><div class="ttl">${esc(title)}</div></div>
<pre><div class="l"><span class="p">$</span> ${esc(command)}</div><div class="l">&nbsp;</div>${body}</pre></div>`;
}

function main() {
  const argv = process.argv.slice(2);
  const opts = { env: {}, width: 980 };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { i++; break; }
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--title') opts.title = argv[++i];
    else if (a === '--cwd') opts.cwd = argv[++i];
    else if (a === '--width') opts.width = Number(argv[++i]);
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
  // 14.5px mono is ~8.7px per column; widen the window if the output needs it
  opts.width = Math.max(opts.width, Math.ceil(longest * 8.8) + 48);
  const html = page({ title, command, lines, width: opts.width });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shoot-'));
  const file = path.join(tmp, 'term.html');
  fs.writeFileSync(file, html);
  const H = 40 + 40 + 40 + 24 + 20 + Math.round((lines.length + 2) * 14.5 * 1.55) + 4;
  const chrome = opts.chrome || process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  const c = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${path.join(tmp, 'profile')}`,
    '--force-device-scale-factor=2', `--window-size=${opts.width + 80},${H}`, '--virtual-time-budget=6000',
    `--screenshot=${path.resolve(opts.out)}`, pathToFileURL(file).href], { encoding: 'utf8' });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!fs.existsSync(path.resolve(opts.out))) { console.error(c.error || c.stderr || c.status); process.exit(1); }
  console.log('wrote', opts.out);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
