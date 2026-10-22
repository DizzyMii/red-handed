// Three renderers for a scan Result: terminal, markdown and json.

import { version } from './version.mjs';

const ESC = '\x1b[';
const paint = (on, code, s) => (on ? `${ESC}${code}m${s}\x1b[0m` : s);

const VERDICT_COLOR = { CAUGHT: '1;31', SUSPICIOUS: '1;33', CLEAN: '1;32' };

function location(f) {
  if (!f.file) return '';
  return f.line > 0 ? `${f.file}:${f.line}` : f.file;
}

export function terminal(result, { color = false, max = 30, dumb = false } = {}) {
  const c = (code, s) => paint(color, code, s);
  const { stats, source, findings, verdict } = result;
  const hard = findings.filter(f => f.tier === 'HARD').length;
  const soft = findings.length - hard;
  const out = [];

  out.push(`${c('1', 'red-handed')}  ${source.label ?? ''}`);
  out.push(`            ${stats.files} ${stats.files === 1 ? 'file' : 'files'}, ${stats.testFiles} test ${stats.testFiles === 1 ? 'file' : 'files'}, assertions +${stats.assertionsAdded} -${stats.assertionsRemoved}`);
  out.push('');

  const counts = verdict === 'CLEAN' ? '' : `   ${hard} hard, ${soft} soft`;
  out.push(`  ${c(VERDICT_COLOR[verdict], verdict)}${counts}`);
  for (const n of result.notes ?? []) out.push(`  ${c('2', `note: ${n}`)}`);
  out.push('');

  const shown = findings.slice(0, max);
  for (const f of shown) {
    const hardMark = dumb ? 'x' : '✖';
    const mark = f.tier === 'HARD' ? c('31', hardMark) : c('33', '!');
    const loc = location(f);
    out.push(`  ${mark} ${f.rule.padEnd(24)}${loc}`);
    if (f.before != null) out.push(`      ${c('31', `- ${f.before}`)}`);
    if (f.after != null) out.push(`      ${c('32', `+ ${f.after}`)}`);
    out.push(`      ${c('2', f.message)}`);
    out.push('');
  }
  if (findings.length > shown.length) {
    out.push(`  … ${findings.length - shown.length} more. Run with --format json for all.`);
    out.push('');
  }

  if (verdict === 'CLEAN') {
    out.push('  Nothing looks like cheating.');
    out.push('');
  } else if (verdict === 'SUSPICIOUS') {
    out.push('  Nothing conclusive. Worth a look.');
    out.push('');
  }
  return out.join('\n') + '\n';
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function markdown(result) {
  const icon = { CAUGHT: '🔴', SUSPICIOUS: '🟡', CLEAN: '🟢' }[result.verdict];
  const out = [
    '<!-- red-handed -->',
    `### ${icon} red-handed: ${result.verdict}`,
    '',
    `${result.source.label ?? ''}`,
    '',
  ];
  for (const n of result.notes ?? []) out.push(`> note: ${n}`, '');

  const { findings } = result;
  if (findings.length) {
    out.push('| | Rule | Where | What |', '|---|---|---|---|');
    for (const f of findings.slice(0, 50)) {
      const loc = location(f);
      out.push(`| ${f.tier === 'HARD' ? '✖' : '!'} | \`${f.rule}\` | ${loc ? `\`${cell(loc)}\`` : ''} | ${cell(f.message)} |`);
    }
    if (findings.length > 50) out.push('', `${findings.length - 50} more findings not shown. Run with --format json for all.`);
    out.push('');
    for (const f of findings.slice(0, 10)) {
      if (f.before == null && f.after == null) continue;
      const code = [];
      if (f.before != null) code.push(`- ${f.before}`);
      if (f.after != null) code.push(`+ ${f.after}`);
      out.push(
        '<details>',
        `<summary><code>${f.rule}</code> ${location(f)}</summary>`,
        '',
        '```diff',
        ...code,
        '```',
        '',
        '</details>',
        '',
      );
    }
  } else {
    out.push('Nothing looks like cheating.', '');
  }
  out.push(`<sub>red-handed v${version()}. Deterministic checks, no AI involved.</sub>`);
  return out.join('\n') + '\n';
}

export function json(result) {
  return JSON.stringify(result, null, 2) + '\n';
}

export function rulesList(rules, { color = false } = {}) {
  const width = Math.max(...rules.map(r => r.id.length)) + 2;
  return rules.map(r => {
    const tier = paint(color, r.tier === 'HARD' ? '31' : '33', r.tier.padEnd(6));
    return `${tier}${r.id.padEnd(width)}${r.why}`;
  }).join('\n') + '\n';
}

export function wantColor(io, noColor = false) {
  if (noColor) return false;
  const force = io.env?.FORCE_COLOR;
  if (force && force !== '0') return true;
  return Boolean(io.stdout.isTTY) && !io.env?.NO_COLOR;
}
