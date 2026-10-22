// The playground runs the same scan() the CLI does. Only the browser-safe engine files are
// imported: scan, diff, classify, glob and rules. Nothing here talks to a server except the
// GitHub API, and only when someone asks for a pull request.
//
// On Pages the repo's src/ is published next to this file, so the imports are ./src/*.mjs.
// scripts/serve-site.mjs does the same mapping for local dev.


import { scan } from './src/scan.mjs';
import { parseDiff } from './src/diff.mjs';
import { RULES } from './src/rules.mjs';
import { CHEATS, WHOLE_DEMO } from './cheats.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const stacked = matchMedia('(max-width: 1080px)');

function means(v, h) {
  if (v === 'CAUGHT') return h === 1 ? '1 change here has no honest use in a fix.' : `${h} of these have no honest use in a fix.`;
  if (v === 'SUSPICIOUS') return 'Only SOFT findings. They have honest uses too, so read the lines yourself.';
  return 'None of the usual tricks are in this diff. That is all CLEAN means.';
}

const EXAMPLE_PR = 'https://github.com/sanity-io/plugins/pull/2035';
const EXAMPLE_PR_HIT = 'https://github.com/Azure/acr-builder/pull/750';

// ---- numbers and rules, straight from rules.mjs ------------------------------------------

const hard = RULES.filter(r => r.tier === 'HARD').length;
$('n-rules').textContent = RULES.length;
$('n-rules-line').textContent = RULES.length;
$('n-split').textContent = `${hard} hard and ${RULES.length - hard} soft`;
$('rules-count').textContent = RULES.length;

const ruleList = $('rule-list');
RULES.forEach((r, i) => {
  const li = el('li', `rule ${r.tier.toLowerCase()}`);
  li.append(el('span', 'rn', String(i + 1).padStart(2, '0')));
  const body = el('div');
  const head = el('div');
  head.append(el('span', 'rid', r.id), el('span', 'rt', r.tier));
  body.append(head, el('p', null, r.why));
  li.append(body);
  ruleList.append(li);
});

// ---- scanning ------------------------------------------------------------------------------

function source(kind, label, diffText, extra = {}) {
  return {
    kind, label, base: null, url: null, title: null, author: null, authorIsBot: null,
    diffText, untracked: [], baseFile: () => null, ...extra,
  };
}

function run(src, ctx = {}) {
  const t0 = performance.now();
  let result;
  try {
    result = scan(src);
  } catch (e) {
    showError(`The scan threw: ${e.message}`);
    return null;
  }
  render(result, performance.now() - t0, src.diffText, ctx);
  return result;
}

function lineBlock(before, after) {
  const box = el('div', 'f-lines');
  if (before != null) box.append(el('span', 'del', `- ${before}`));
  if (after != null) box.append(el('span', 'add', `+ ${after}`));
  return box;
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

// The diff as evidence: real line numbers, and the lines a finding points at marked.
function renderDiff(diffText, findings) {
  const view = $('dv');
  view.replaceChildren();
  const { files } = parseDiff(diffText);
  const flagged = new Set(findings.filter(f => f.line > 0).map(f => `${f.file}|${f.line}`));
  const whole = new Set(findings.filter(f => !(f.line > 0)).map(f => f.file));
  let shown = 0;
  let total = 0;
  for (const f of files) {
    const path = f.newPath ?? f.oldPath;
    const box = el('div', 'dfile');
    const name = el('div', 'dname', f.status === 'deleted' ? `${f.oldPath} (deleted)` : path);
    if (whole.has(f.oldPath) || whole.has(path)) name.classList.add('flag');
    box.append(name);
    for (const h of f.hunks) {
      const nOld = h.lines.filter(l => l.kind !== '+').length;
      const nNew = h.lines.filter(l => l.kind !== '-').length;
      box.append(el('div', 'dhead', `@@ -${h.oldStart},${nOld} +${h.newStart},${nNew} @@`));
      total += h.lines.length;
      const pre = el('div', 'dhunk');
      for (const l of h.lines) {
        if (shown++ >= 600) break;
        const row = el('span', `dl ${l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : 'ctx'}`);
        const num = l.kind === '-' ? l.oldLine : l.newLine;
        const hit = (l.kind === '+' && flagged.has(`${path}|${l.newLine}`))
          || (l.kind === '-' && flagged.has(`${f.oldPath ?? path}|${l.oldLine}`)
            && !findings.some(x => x.file === path && x.line === l.oldLine && x.after != null));
        if (hit) row.classList.add('hit');
        row.append(el('span', 'dn', num ?? ''), el('span', 'dk', l.kind === ' ' ? ' ' : l.kind), el('span', 'dt', l.text || ' '));
        pre.append(row);
      }
      box.append(pre);
    }
    view.append(box);
  }
  if (shown > 600) view.append(el('p', 'dv-more', 'Only the first 600 lines are shown here, the scan read all of it.'));
  $('diffbox').hidden = files.length === 0;
  $('diff-sum').textContent = `The diff it scanned, ${plural(total, 'line')}`;
}

let countTimer = 0;

function setSub(h, s) {
  const parts = [];
  if (h) parts.push(`${h} hard`);
  if (s) parts.push(`${s} soft`);
  $('v-sub').textContent = parts.length ? parts.join(', ') : 'no findings';
}

function render(result, ms, diffText, ctx) {
  $('empty').hidden = true;
  $('result').hidden = false;
  $('again').hidden = false;
  $('v-bar').hidden = true;
  $('verdict').removeAttribute('aria-busy');

  const claim = $('claim');
  claim.hidden = !ctx.claim;
  $('claim-text').textContent = ctx.claim ?? '';

  const v = result.verdict;
  const verdict = $('verdict');
  verdict.className = `verdict ${v.toLowerCase()}`;
  // Restart the animation even when the verdict class did not change.
  void verdict.offsetWidth;
  verdict.classList.add('pop');

  const h = result.findings.filter(f => f.tier === 'HARD').length;
  const s = result.findings.length - h;
  $('v-word').textContent = v;
  clearInterval(countTimer);
  if (v === 'CAUGHT' && h > 1 && !reduced.matches) {
    // Count the hard findings in, so four of them take longer to land than one.
    let n = 1;
    setSub(n, 0);
    countTimer = setInterval(() => {
      n++;
      if (n >= h) { clearInterval(countTimer); setSub(h, s); } else setSub(n, 0);
    }, 160);
  } else {
    setSub(h, s);
  }
  $('v-means').textContent = means(v, h);

  const st = result.stats;
  const meta = $('v-meta');
  meta.replaceChildren();
  if (result.source.label) {
    if (result.source.url) {
      const a = el('a', null, result.source.label);
      a.href = result.source.url;
      a.rel = 'noopener';
      meta.append(a, '  ');
    } else {
      meta.append(`${result.source.label}  `);
    }
  }
  const asserts = [st.assertionsAdded && `+${st.assertionsAdded}`, st.assertionsRemoved && `-${st.assertionsRemoved}`].filter(Boolean);
  const bits = [`${plural(st.files, 'file')}, ${plural(st.testFiles, 'test file')}`];
  if (asserts.length) bits[0] += `, assertions ${asserts.join(' ')}`;
  bits.push(ms < 1 ? 'scanned in under 1 ms' : `scanned in ${Math.round(ms)} ms`);
  meta.append(bits.join('  ·  '));

  const list = $('findings');
  list.replaceChildren();
  result.findings.forEach((f, i) => {
    const li = el('li', `f ${f.tier.toLowerCase()} in`);
    li.style.setProperty('--i', i);
    const ico = el('span', 'ico');
    ico.setAttribute('aria-hidden', 'true');
    li.append(ico);
    const main = el('div');
    const head = el('div', 'f-head');
    head.append(el('span', 'f-rule', f.rule), el('span', 'f-tier', f.tier),
      el('span', 'f-loc', f.line > 0 ? `${f.file}:${f.line}` : f.file));
    main.append(head);
    // test-deleted carries the path as "before"; the location already says it.
    const before = f.rule === 'test-deleted' ? null : f.before;
    if (before != null || f.after != null) main.append(lineBlock(before, f.after));
    else if (f.rule === 'test-deleted') main.append(lineBlock(`${f.file} (whole file)`, null));
    main.append(el('p', 'f-why', f.message));
    li.append(main);
    list.append(li);
  });

  renderDiff(diffText, result.findings);
  $('diffbox').open = false;

  const notes = result.notes.filter(n => !/config not read/.test(n));
  $('notes').textContent = notes.length ? `note: ${notes.join('; ')}` : '';
  // Screen readers only hear the verdict line.
  $('sr').textContent = `${v}. ${result.findings.length ? `${h} hard and ${s} soft findings.` : 'No findings.'}`;
}

function resetResult() {
  clearInterval(countTimer);
  $('empty').hidden = true;
  $('result').hidden = false;
  $('claim').hidden = true;
  $('v-bar').hidden = true;
  $('v-meta').replaceChildren();
  $('findings').replaceChildren();
  $('diffbox').hidden = true;
  $('notes').textContent = '';
}

function showError(text) {
  resetResult();
  $('again').hidden = false;
  $('verdict').className = 'verdict error';
  $('verdict').removeAttribute('aria-busy');
  $('v-word').textContent = "Can't scan that";
  $('v-sub').textContent = '';
  $('v-means').textContent = text;
  $('sr').textContent = text;
}

function showLoading(label) {
  resetResult();
  $('again').hidden = true;
  $('verdict').className = 'verdict loading';
  $('verdict').setAttribute('aria-busy', 'true');
  $('v-word').textContent = `Scanning ${label}`;
  $('v-sub').textContent = '';
  $('v-means').textContent = '';
  $('v-bar').hidden = false;
}

// On a phone the result sits under the list. Bring it up and hand focus to the verdict.
function revealResult() {
  if (!stacked.matches) return;
  $('out').scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth', block: 'start' });
  $('v-word').focus({ preventScroll: true });
}

// ---- cheats --------------------------------------------------------------------------------

const ALL = [WHOLE_DEMO, ...CHEATS];
const cheatList = $('cheats');
const buttons = new Map();

ALL.forEach((c, i) => {
  const li = el('li', c.honest || i === 1 ? 'sep' : null);
  const b = el('button', 'cheat');
  b.type = 'button';
  b.setAttribute('aria-pressed', 'false');
  b.dataset.id = c.id;
  b.append(el('span', 'n', String(i).padStart(2, '0')), el('span', 't', c.label), el('span', 'tag'), el('span', 'd', c.note));
  b.addEventListener('click', () => pickCheat(c.id, true));
  li.append(b);
  cheatList.append(li);
  buttons.set(c.id, b);
});

function pickCheat(id, fromClick) {
  const c = ALL.find(x => x.id === id);
  if (!c) return;
  for (const [k, b] of buttons) { b.setAttribute('aria-pressed', String(k === id)); b.classList.remove('caught'); }
  const r = run(source('diff', 'agent/fix-discount', c.diff), { claim: c.claim, note: c.note });
  // Once a cheat has been tried, its row keeps the verdict it got.
  if (r) {
    const tag = buttons.get(id).querySelector('.tag');
    tag.textContent = r.verdict;
    tag.className = `tag ${r.verdict.toLowerCase()}`;
    buttons.get(id).classList.toggle('caught', r.verdict === 'CAUGHT');
  }
  if (fromClick) revealResult();
}

// ---- exhibit A: the demo diff, scanned on load -------------------------------------------

(function exhibitA() {
  let r;
  try { r = scan(source('diff', 'agent/fix-discount', WHOLE_DEMO.diff)); } catch { return; }
  $('exa-claim').textContent = WHOLE_DEMO.claim;
  const ol = $('exa-list');
  for (const f of r.findings) {
    const li = el('li', f.tier.toLowerCase());
    const mark = el('span', 'mk', f.tier === 'HARD' ? 'x' : '!');
    mark.setAttribute('aria-hidden', 'true');
    li.append(mark, el('code', 'rid', f.rule), el('span', 'loc', `${f.file}:${f.line}`));
    ol.append(li);
  }
  const h = r.findings.filter(f => f.tier === 'HARD').length;
  const slab = $('exa-slab');
  slab.className = `exa-slab ${r.verdict.toLowerCase()}`;
  $('exa-word').textContent = r.verdict;
  $('exa-sub').textContent = [h && `${h} hard`, r.findings.length - h && `${r.findings.length - h} soft`].filter(Boolean).join(', ');
  setTimeout(() => {
    slab.hidden = false;
    slab.classList.add('pop');
  }, reduced.matches ? 0 : 450);
  $('exa-open').addEventListener('click', () => {
    selectTab($('tab-cheats'));
    pickCheat('demo', false);
    $('playground').scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth', block: 'start' });
  });
})();

// ---- tabs ------------------------------------------------------------------------------------

const HINTS = {
  'tab-cheats': 'Pick a cheat. The last one is an honest fix.',
  'tab-pr': 'Paste a PR link and hit Scan.',
  'tab-paste': 'Paste a diff and hit Scan.',
};
const tabs = [...document.querySelectorAll('[role=tab]')];
function selectTab(tab, focus) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !on;
  }
  if (focus) tab.focus();
  $('empty-hint').textContent = HINTS[tab.id] ?? '';
}
tabs.forEach((t, i) => {
  t.addEventListener('click', () => selectTab(t));
  t.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (e.key === 'Home') { e.preventDefault(); selectTab(tabs[0], true); }
    else if (e.key === 'End') { e.preventDefault(); selectTab(tabs.at(-1), true); }
    else if (d) { e.preventDefault(); selectTab(tabs[(i + d + tabs.length) % tabs.length], true); }
  });
});

// ---- pull requests -------------------------------------------------------------------------

function parsePr(text) {
  const s = text.trim();
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i.exec(s);
  if (!m) m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(s);
  return m ? { owner: m[1], repo: m[2], number: m[3] } : null;
}

const prMsg = $('pr-msg');
const prUrl = $('pr-url');
function say(text, err) {
  prMsg.textContent = text;
  prMsg.classList.toggle('err', !!err);
  if (err) prUrl.setAttribute('aria-invalid', 'true'); else prUrl.removeAttribute('aria-invalid');
  if (err) showError(text);
}

// What to tell someone when GitHub says no.
function prFailure(status, headers, label) {
  const left = headers.get('x-ratelimit-remaining');
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (status === 429 || (status === 403 && (left === '0' || left == null))) {
    const when = reset > 0
      ? `after ${new Date(reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`
      : 'in a bit';
    return `GitHub's limit is 60 an hour without a login. Try again ${when}, or use the CLI with GITHUB_TOKEN set.`;
  }
  if (status === 403) return `GitHub refused to send ${label}. Try the CLI with GITHUB_TOKEN set.`;
  if (status === 404) return `GitHub says ${label} does not exist, or it is in a private repo. The CLI can do private ones with a token.`;
  if (status === 406 || status === 422) return 'That diff is too big for GitHub to send in one go. Run the CLI on a clone.';
  return `GitHub answered ${status}. Try again in a minute.`;
}

async function scanPr(raw) {
  const pr = parsePr(raw);
  if (!pr) { say('That does not look like a pull request link. It wants github.com/owner/repo/pull/123 or owner/repo#123.', true); return; }
  const label = `${pr.owner}/${pr.repo}#${pr.number}`;
  say(`Fetching ${label}...`);
  showLoading(label);
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, {
      headers: { Accept: 'application/vnd.github.diff' },
    });
  } catch {
    say('Could not reach api.github.com. Are you offline? The cheats and the paste box still work without a network.', true);
    return;
  }
  if (!res.ok) { say(prFailure(res.status, res.headers, label), true); return; }
  const diff = await res.text();
  say(`Got ${label}, ${Math.round(diff.length / 1024) || 1} KB of diff.`);
  for (const b of buttons.values()) { b.setAttribute('aria-pressed', 'false'); b.classList.remove('caught'); }
  run(source('pr', label, diff, { url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}` }), {});
  revealResult();
}

$('pr-form').addEventListener('submit', (e) => { e.preventDefault(); scanPr($('pr-url').value); });
for (const [id, url] of [['pr-example', EXAMPLE_PR], ['pr-example-hit', EXAMPLE_PR_HIT]]) {
  $(id).addEventListener('click', () => {
    $('pr-url').value = url;
    scanPr(url);
  });
}

// ---- pasted diffs --------------------------------------------------------------------------

function scanPaste() {
  const text = $('paste').value;
  if (!text.trim()) { showError('Paste a diff first. The box is empty.'); return; }
  for (const b of buttons.values()) { b.setAttribute('aria-pressed', 'false'); b.classList.remove('caught'); }
  const r = run(source('diff', 'pasted diff', text), {});
  if (r && r.stats.files === 0) showError('No files in that. It wants a unified diff with --- and +++ lines and @@ hunks.');
  else if (r) revealResult();
}
$('paste-form').addEventListener('submit', (e) => { e.preventDefault(); scanPaste(); });
$('paste').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); scanPaste(); }
});

// ---- copy buttons --------------------------------------------------------------------------

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = el('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}
for (const b of document.querySelectorAll('.copy')) {
  b.addEventListener('click', async () => {
    const text = b.dataset.copy ?? $(b.dataset.copyFrom).textContent;
    const ok = await copyText(text);
    b.textContent = ok ? 'Copied' : 'Select it';
    b.classList.toggle('done', ok);
    $('sr').textContent = ok ? 'Copied to clipboard' : 'Copy failed, select the text by hand';
    setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('done'); }, 1600);
  });
}

// ---- links into the playground: ?cheat=skip or ?pr=owner/repo%2312 -----------------------

const q = new URLSearchParams(location.search);
if (q.get('cheat')) {
  pickCheat(q.get('cheat'), false);
  $('playground').scrollIntoView({ behavior: 'instant', block: 'start' });
} else if (q.get('pr')) {
  selectTab($('tab-pr'));
  $('pr-url').value = q.get('pr');
  scanPr(q.get('pr'));
  $('playground').scrollIntoView({ behavior: 'instant', block: 'start' });
}
