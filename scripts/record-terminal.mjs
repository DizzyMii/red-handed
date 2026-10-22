// Terminal recorder: node scripts/record-terminal.mjs --out docs/img/demo -- "npx red-handed demo" "npx red-handed owner/repo#1" ...
// Runs each command for real with FORCE_COLOR=1, keeps when each chunk of output arrived, then draws
// every state (each typed key, each chunk) in one headless Chrome over the DevTools protocol and
// stitches the frames into <out>.mp4 and <out>.gif with ffmpeg. "echo $?" prints the previous exit code.
// A command starting with "+" stays on the same screen as the one before it, otherwise the screen clears.
// Options: --chrome <path>  --rows <n>

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { THEME, COLS, parseAnsi, runsToHtml, esc } from './shoot-terminal.mjs';

const MAX_GAP = 1500; // ponytail: waits longer than this (npx installing) are cut down to it, the video says nothing about speed past that
const HOLD_PER_LINE = 200; // reading time, at least 3 s per screen

function run(cmd) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const chunks = [];
    const p = spawn(cmd, { shell: true, env: { ...process.env, FORCE_COLOR: '1' } });
    const take = (d) => chunks.push({ t: Date.now() - t0, text: d.toString('utf8') });
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    p.on('close', (code) => resolve({ chunks, code, ms: Date.now() - t0 }));
  });
}

// Builds the timeline: [{ screen: string (ANSI), cursor: bool, ms: how long it stays }]
async function timeline(commands) {
  const states = [];
  let screen = '';
  let lastCode = 0;
  const prompt = '\x1b[31m$\x1b[0m ';
  const show = (ms, cursor = true) => states.push({ screen, cursor, ms });
  for (const raw of commands) {
    const same = raw.startsWith('+');
    const cmd = same ? raw.slice(1) : raw;
    if (!same) { screen = prompt; show(700); }
    [...cmd].forEach((ch, i) => { screen += ch; show(35 + (i % 4) * 11); });
    show(380);
    screen += '\n';
    if (cmd.trim() === 'echo $?') {
      screen += `${lastCode}\n${prompt}`;
      show(1200);
      continue;
    }
    console.log('running', cmd);
    const r = await run(cmd);
    lastCode = r.code;
    let at = 0;
    for (const c of r.chunks) {
      if (c.t > at) states[states.length - 1].ms += Math.min(c.t - at, MAX_GAP);
      at = c.t;
      screen += c.text.replace(/\r\n/g, '\n');
      show(30, false);
    }
    if (!screen.endsWith('\n')) screen += '\n';
    screen += prompt;
    const lines = r.chunks.map((c) => c.text).join('').split('\n').length;
    show(Math.max(3000, lines * HOLD_PER_LINE));
  }
  show(1500);
  return states;
}

const FONT = `'JetBrains Mono','Cascadia Code',Consolas,monospace`;
const WIN_W = Math.round(COLS * 8.7 + 56 + 2 + 80);

function shell(rows) {
  const mark = '<svg viewBox="0 0 16 16" width="16" height="16" style="position:absolute;left:20px;top:12px"><rect width="16" height="16" rx="3.5" fill="#f3f0e8"/><path fill="#141414" d="M4 3H7V13H4Z"/><path fill="#cc1a0a" d="M7 5C7.4 3.7 8.3 3 9.8 3H12V7H10.2C8.6 7 7.6 7.7 7 9Z"/></svg>';
  return `<!doctype html><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
html,body{margin:0;background:#0b0b0a;overflow:hidden}
body{padding:40px;box-sizing:border-box;width:${WIN_W}px}
.win{font:400 14.5px/1.55 ${FONT};width:calc(${COLS}ch + 56px);background:${THEME.bg};border:1px solid ${THEME.line};box-shadow:0 20px 50px rgba(0,0,0,.6);overflow:hidden}
.bar{height:40px;background:${THEME.bar};position:relative;border-bottom:1px solid ${THEME.line}}
.ttl{position:absolute;left:0;right:0;top:0;text-align:center;font:500 13px/40px ${FONT};color:${THEME.muted}}
pre{margin:0;padding:20px 28px 24px;height:calc(${rows} * 1.55em);overflow:hidden;font:inherit;color:${THEME.text};white-space:pre;font-variant-ligatures:none;font-feature-settings:'liga' 0,'calt' 0;font-variant-emoji:text}
.l{min-height:1.55em}.cur{background:${THEME.text};color:${THEME.bg}}
</style>
<div class="win"><div class="bar">${mark}<div class="ttl">bash</div></div><pre id="t"></pre></div>`;
}

function frameHtml(state, rows) {
  const lines = parseAnsi(state.screen);
  if (state.screen.endsWith('\n')) lines.push([]);
  const html = lines.map((l) => runsToHtml(l));
  if (state.cursor) html[html.length - 1] += '<span class="cur"> </span>';
  return html.slice(-rows).map((h) => `<div class="l">${h || '&nbsp;'}</div>`).join('');
}

async function cdp(chrome, tmp, width, height) {
  const dir = path.join(tmp, 'profile');
  const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${dir}`,
    '--remote-debugging-port=0', '--force-device-scale-factor=2', `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return { send, close: () => { ws.close(); proc.kill(); } };
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = { rows: 0 };
  let i = 0;
  for (; i < argv.length; i++) {
    if (argv[i] === '--') { i++; break; }
    if (argv[i] === '--out') opts.out = argv[++i];
    else if (argv[i] === '--chrome') opts.chrome = argv[++i];
    else if (argv[i] === '--rows') opts.rows = Number(argv[++i]);
  }
  const commands = argv.slice(i);
  if (!opts.out || !commands.length) { console.error('usage: record-terminal.mjs --out docs/img/name -- "cmd" ["+cmd" ...]'); process.exit(2); }

  const states = await timeline(commands);
  const rows = opts.rows || Math.max(...states.map((s) => s.screen.split('\n').length)) + 1;
  const height = 40 + 41 + 44 + Math.round(rows * 14.5 * 1.55) + 40 + 2;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'record-'));
  const chrome = opts.chrome || process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const b = await cdp(chrome, tmp, WIN_W, height);
  try {
    await b.send('Page.enable');
    await b.send('Emulation.setDeviceMetricsOverride', { width: WIN_W, height, deviceScaleFactor: 2, mobile: false });
    const { frameId } = await b.send('Page.getFrameTree').then((r) => ({ frameId: r.frameTree.frame.id }));
    await b.send('Page.setDocumentContent', { frameId, html: shell(rows) });
    await b.send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => document.fonts.load("14.5px JetBrains Mono"))', awaitPromise: true });
    await new Promise((r) => setTimeout(r, 800));

    const list = [];
    let prev = null;
    for (const [n, s] of states.entries()) {
      const html = frameHtml(s, rows);
      if (html === prev) { list[list.length - 1].ms += s.ms; continue; }
      prev = html;
      await b.send('Runtime.evaluate', { expression: `document.getElementById('t').innerHTML = ${JSON.stringify(html)}` });
      const shot = await b.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(tmp, `f${String(n).padStart(5, '0')}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      list.push({ file, ms: s.ms });
    }
    console.log(`${list.length} frames, ${(list.reduce((t, f) => t + f.ms, 0) / 1000).toFixed(1)} s`);

    // concat demuxer wants the last file listed twice for its duration to count
    const concat = list.map((f) => `file '${f.file.replace(/\\/g, '/')}'\nduration ${(f.ms / 1000).toFixed(3)}`).join('\n') + `\nfile '${list.at(-1).file.replace(/\\/g, '/')}'\n`;
    const listFile = path.join(tmp, 'list.txt');
    fs.writeFileSync(listFile, concat);
    const out = path.resolve(opts.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const ff = (args) => {
      const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, ...args], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    ff(['-vf', 'fps=30,scale=1920:-2:flags=lanczos', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', `${out}.mp4`]);
    ff(['-vf', 'fps=12,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none', `${out}.gif`]);
    console.log('wrote', `${opts.out}.mp4`, `${opts.out}.gif`);
  } finally {
    b.close();
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
