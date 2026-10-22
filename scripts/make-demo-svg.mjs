// Builds docs/img/demo.svg, the animated terminal recording used in the README.
// Runs `red-handed demo`, then lays the real output out as SVG <text> with CSS keyframes (no JS).
// node scripts/make-demo-svg.mjs [out.svg]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAnsi, esc } from './shoot-terminal.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || path.join(root, 'docs/img/demo.svg');
const r = spawnSync(process.execPath, [path.join(root, 'bin/red-handed.mjs'), 'demo'], { encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '1' } });
const lines = parseAnsi(r.stdout);

const CMD = 'npx red-handed demo';
const CW = 8.4, FS = 14, LH = 22, X0 = 28, TOP = 44;
const T = 20; // loop length in seconds
const W = 1190;
const rowsTotal = lines.length + 2; // prompt + blank + output
const H = TOP + 24 + rowsTotal * LH + 20;
const BG = '#16161e';
const pct = (s) => +(s / T * 100).toFixed(2);
const y = (row) => TOP + 28 + row * LH;
const css = [];
const body = [];

const fill = (c) => c || '#c0caf5';
function runText(runs) {
  return runs.map((u) => {
    const t = esc(u.text.replace(/✖/g, ' '));
    const a = [`fill="${fill(u.color)}"`];
    if (u.bold) a.push('font-weight="700"');
    if (u.dim) a.push('fill-opacity=".55"');
    return `<tspan ${a.join(' ')}>${t}</tspan>`;
  }).join('');
}

// typing
const typeStart = 0.5, typeEnd = 2.1, pauseEnd = 3.0;
body.push(`<text x="${X0}" y="${y(0)}" xml:space="preserve"><tspan fill="#7aa2f7">$</tspan> ${esc(CMD)}</text>`);
const cx = X0 + 2 * CW;
const span = CMD.length * CW;
body.push(`<rect class="cover" x="${cx}" y="${y(0) - 16}" width="${span + 40}" height="22" fill="${BG}"/>`);
body.push(`<rect class="cursor" x="${cx}" y="${y(0) - 13}" width="${CW}" height="17" fill="#c0caf5"/>`);
css.push(`.cover{animation:cov ${T}s linear infinite}@keyframes cov{0%,${pct(typeStart)}%{transform:translateX(0);animation-timing-function:steps(${CMD.length},end)}${pct(typeEnd)}%,100%{transform:translateX(${span + 40}px)}}`);
css.push(`.cursor{animation:cur ${T}s linear infinite}@keyframes cur{0%,${pct(typeStart)}%{transform:translateX(0);opacity:1;animation-timing-function:steps(${CMD.length},end)}${pct(typeEnd)}%{transform:translateX(${span}px);opacity:1}${pct(typeEnd + 0.3)}%{opacity:0}${pct(typeEnd + 0.6)}%{opacity:1}${pct(pauseEnd - 0.05)}%{opacity:1;transform:translateX(${span}px)}${pct(pauseEnd)}%,100%{opacity:0;transform:translateX(${span}px)}}`);

// output reveal
let t = pauseEnd;
let id = 0;
const hold = 18.2;
let caughtAt = null;
lines.forEach((runs, i) => {
  const row = i + 2;
  const blank = runs.every((u) => !u.text.trim());
  if (blank) return;
  const text = runs.map((u) => u.text).join('');
  const isCaught = /CAUGHT/.test(text);
  const isDetail = /^\s{6}/.test(text);
  t += isCaught ? 0.9 : text.startsWith('  ✖') || text.startsWith('  !') ? 0.55 : isDetail ? 0.22 : 0.4;
  const n = `l${id++}`;
  if (isCaught) caughtAt = t;
  const kf = `@keyframes ${n}{0%,${pct(t)}%{opacity:0;transform:translateY(3px)}${pct(t + 0.18)}%,${pct(hold)}%{opacity:1;transform:none}${pct(hold + 0.6)}%,100%{opacity:0;transform:none}}`;
  css.push(`.${n}{animation:${n} ${T}s linear infinite}${kf}`);
  let extra = '';
  if (/^  ✖/.test(text)) {
    const x = X0 + 2 * CW + 1;
    extra = `<path class="${n}" d="M${x + 1} ${y(row) - 10}l${CW - 3} ${CW - 3}m0 -${CW - 3}l-${CW - 3} ${CW - 3}" stroke="#f7768e" stroke-width="1.8" stroke-linecap="round" fill="none"/>`;
  }
  body.push(`<text class="${n}" x="${X0}" y="${y(row)}" xml:space="preserve">${runText(runs)}</text>${extra}`);
});
// CAUGHT flash: a red underglow bar behind the verdict line
if (caughtAt != null) {
  const row = lines.findIndex((l) => /CAUGHT/.test(l.map((u) => u.text).join(''))) + 2;
  css.push(`.glow{animation:glow ${T}s linear infinite}@keyframes glow{0%,${pct(caughtAt)}%{opacity:0}${pct(caughtAt + 0.15)}%{opacity:.35}${pct(caughtAt + 1.2)}%,${pct(hold)}%{opacity:.14}${pct(hold + 0.6)}%,100%{opacity:0}}`);
  body.unshift(`<rect class="glow" x="${X0 - 10}" y="${y(row) - 17}" width="${W - 2 * X0 + 20}" height="24" rx="5" fill="#f7768e"/>`);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Terminal recording: npx red-handed demo catches an agent that cheated its way to passing tests. Verdict CAUGHT, 4 hard and 1 soft findings.">
<style>
text{font-family:'JetBrains Mono','SF Mono','Cascadia Code',Menlo,Consolas,'DejaVu Sans Mono','Liberation Mono',monospace;font-size:${FS}px;fill:#c0caf5;white-space:pre;font-variant-ligatures:none}
${css.join('\n')}
@media (prefers-reduced-motion:reduce){*{animation:none!important;opacity:1!important;transform:none!important}.cover,.cursor,.glow{display:none}}
</style>
<rect width="${W}" height="${H}" rx="12" fill="${BG}"/>
<path d="M12 0h${W - 24}a12 12 0 0 1 12 12v28H0V12A12 12 0 0 1 12 0z" fill="#1c1d2b"/>
<path d="M0 40.5h${W}" stroke="#2a2e45"/>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="12" fill="none" stroke="#2a2e45"/>
<circle cx="22" cy="20" r="6" fill="#ff5f56"/><circle cx="42" cy="20" r="6" fill="#ffbd2e"/><circle cx="62" cy="20" r="6" fill="#27c93f"/>
<text x="${W / 2}" y="25" text-anchor="middle" fill="#8b90a8" style="font-size:13px">$ ${esc(CMD)}</text>
${body.join('\n')}
</svg>
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, svg);
console.log('wrote', out, Buffer.byteLength(svg), 'bytes');
