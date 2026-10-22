// Builds docs/img/demo.svg, the animated terminal recording used in the README.
// Runs `red-handed demo`, then lays the real output out as SVG <text> with CSS keyframes (no JS).
// Every line carries a textLength, so the character grid holds even when the viewer has no
// JetBrains Mono (an SVG shown through <img> cannot load web fonts).
// node scripts/make-demo-svg.mjs [out.svg]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAnsi, esc, THEME, VERDICTS } from './shoot-terminal.mjs';

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
const BG = THEME.bg;
const pct = (s) => +(s / T * 100).toFixed(2);
const y = (row) => TOP + 28 + row * LH;
const css = [];
const body = [];
const blocks = [];

const fill = (c) => c || THEME.text;
function runText(runs) {
  return runs.map((u) => {
    const t = esc(u.text.replace(/✖/g, ' '));
    const v = u.bold && VERDICTS[u.text.trim()];
    const a = [`fill="${v ? v[1] : fill(u.color)}"`];
    if (u.bold) a.push('font-weight="700"');
    if (u.dim) a.push('fill-opacity=".55"');
    return `<tspan ${a.join(' ')}>${t}</tspan>`;
  }).join('');
}

const typeStart = 0.5, typeEnd = 2.1, pauseEnd = 3.0;
const hold = 18.2, gone = hold + 0.6;
const span = CMD.length * CW; // 159.6, the cursor and the cover both move this far, one character per step
const cx = X0 + 2 * CW;

// prompt line: always drawn, covered until typed, faded out with the output so the loop restarts clean
css.push(`.prompt{animation:pr ${T}s linear infinite}@keyframes pr{0%,${pct(hold)}%{opacity:1}${pct(gone)}%,100%{opacity:0}}`);
body.push(`<text class="prompt" x="${X0}" y="${y(0)}" textLength="${(CMD.length + 2) * CW}" lengthAdjust="spacing" xml:space="preserve"><tspan fill="${THEME.red}">$</tspan> ${esc(CMD)}</text>`);
body.push(`<rect class="cover" x="${cx}" y="${y(0) - 16}" width="${span}" height="22" fill="${BG}"/>`);
body.push(`<rect class="cursor" x="${cx}" y="${y(0) - 13}" width="${CW}" height="17" fill="${THEME.text}"/>`);
css.push(`.cover{animation:cov ${T}s linear infinite}@keyframes cov{0%,${pct(typeStart)}%{transform:translateX(0);opacity:1;animation-timing-function:steps(${CMD.length},end)}${pct(typeEnd)}%{transform:translateX(${span}px);opacity:1}${pct(typeEnd + 0.01)}%,${pct(gone)}%{transform:translateX(${span}px);opacity:0}${pct(gone + 0.01)}%,100%{transform:translateX(0);opacity:1}}`);
css.push(`.cursor{animation:cur ${T}s linear infinite}@keyframes cur{0%,${pct(typeStart)}%{transform:translateX(0);opacity:1;animation-timing-function:steps(${CMD.length},end)}${pct(typeEnd)}%{transform:translateX(${span}px);opacity:1}${pct(typeEnd + 0.3)}%{opacity:0}${pct(typeEnd + 0.6)}%{opacity:1}${pct(pauseEnd - 0.05)}%{opacity:1;transform:translateX(${span}px)}${pct(pauseEnd)}%,100%{opacity:0;transform:translateX(${span}px)}}`);

// output reveal
let t = pauseEnd;
let id = 0;
lines.forEach((runs, i) => {
  const row = i + 2;
  if (runs.every((u) => !u.text.trim())) return;
  const text = runs.map((u) => u.text).join('');
  const isCaught = /CAUGHT/.test(text);
  const isDetail = /^\s{6}/.test(text);
  t += isCaught ? 0.9 : text.startsWith('  ✖') || text.startsWith('  !') ? 0.55 : isDetail ? 0.22 : 0.4;
  const n = `l${id++}`;
  css.push(`.${n}{animation:${n} ${T}s linear infinite}@keyframes ${n}{0%,${pct(t)}%{opacity:0;transform:translateY(3px)}${pct(t + 0.18)}%,${pct(hold)}%{opacity:1;transform:none}${pct(gone)}%,100%{opacity:0;transform:none}}`);
  let extra = '';
  if (/^  ✖/.test(text)) {
    const x = X0 + 2 * CW + 1;
    extra = `<path class="${n}" d="M${x + 1} ${y(row) - 10}l${CW - 3} ${CW - 3}m0 -${CW - 3}l-${CW - 3} ${CW - 3}" stroke="${THEME.red}" stroke-width="1.8" stroke-linecap="round" fill="none"/>`;
  }
  // verdict word: a solid block in the brand colour behind it, fading with its line
  let col = 0;
  for (const u of runs) {
    const v = u.bold && VERDICTS[u.text.trim()];
    if (v) {
      const lead = u.text.length - u.text.trimStart().length;
      blocks.push(`<rect class="${n}" x="${+(X0 + (col + lead) * CW - 5).toFixed(1)}" y="${y(row) - 17}" width="${+(u.text.trim().length * CW + 10).toFixed(1)}" height="23" fill="${v[0]}"/>`);
    }
    col += [...u.text].length;
  }
  body.push(`<text class="${n}" x="${X0}" y="${y(row)}" textLength="${+([...text].length * CW).toFixed(1)}" lengthAdjust="spacing" xml:space="preserve">${runText(runs)}</text>${extra}`);
});

const mark = `<g transform="translate(20 12)"><rect width="16" height="16" rx="3.5" fill="#f3f0e8"/><path fill="#141414" d="M4 3H7V13H4Z"/><path fill="#cc1a0a" d="M7 5C7.4 3.7 8.3 3 9.8 3H12V7H10.2C8.6 7 7.6 7.7 7 9Z"/></g>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Terminal recording: npx red-handed demo catches an agent that cheated its way to passing tests. Verdict CAUGHT, 4 hard and 1 soft findings.">
<style>
text{font-family:'JetBrains Mono','SF Mono','Cascadia Code',Menlo,Consolas,'DejaVu Sans Mono','Liberation Mono',monospace;font-size:${FS}px;fill:${THEME.text};white-space:pre;font-variant-ligatures:none}
${css.join('\n')}
@media (prefers-reduced-motion:reduce){*{animation:none!important;opacity:1!important;transform:none!important}.cover,.cursor{display:none}}
</style>
<rect width="${W}" height="${H}" rx="6" fill="${BG}"/>
<path d="M6 0h${W - 12}a6 6 0 0 1 6 6v34H0V6A6 6 0 0 1 6 0z" fill="${THEME.bar}"/>
<path d="M0 40.5h${W}" stroke="${THEME.line}"/>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="6" fill="none" stroke="${THEME.line}"/>
${mark}
<text x="${W / 2}" y="25" text-anchor="middle" fill="${THEME.muted}" style="font-size:13px">$ ${esc(CMD)}</text>
${blocks.join('\n')}
${body.join('\n')}
</svg>
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, svg);
console.log('wrote', out, Buffer.byteLength(svg), 'bytes');
