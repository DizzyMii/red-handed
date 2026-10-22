// scan(source, config) -> Result. Builds the context, runs the rules in order, applies the
// allow list, dedups, sorts and picks the verdict.
//
// config is optional. Left out (undefined), scan reads .red-handed.json from the base side of a
// local source itself and adds the matching note. A plain object is used as given.

import { parseDiff } from './diff.mjs';
import { isTestPath, isCommentLine, ASSERT } from './classify.mjs';
import { matchesAny } from './glob.mjs';
import { RULES } from './rules.mjs';
import { treeAccess } from './trees.mjs';

const CONFIG_FILE = '.red-handed.json';
export const DIFF_ALONE_NOTE = 'judged on the diff alone: no copy of the files around the diff was available, so code the diff does not show was taken to still be there';
const DEFAULT_SKIP_DIRS = /(^|\/)(node_modules|vendor|dist|build)\//;

const strings = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);

export function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const allow = Array.isArray(c.allow)
    ? c.allow.filter(e => e && typeof e.rule === 'string' && typeof e.path === 'string')
    : [];
  return { tests: strings(c.tests), ignore: strings(c.ignore), allow };
}

function loadConfig(source, notes) {
  if (source.kind !== 'local') {
    notes.push(`config not read in ${source.kind} mode`);
    return normalizeConfig(null);
  }
  const text = typeof source.baseFile === 'function' ? source.baseFile(CONFIG_FILE) : null;
  if (text == null) return normalizeConfig(null);
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object');
    return normalizeConfig(parsed);
  } catch (e) {
    notes.push(`ignoring ${CONFIG_FILE}: ${e.message}`);
    return normalizeConfig(null);
  }
}

// An untracked file is a new file whose every line is added.
function untrackedRecord({ path, text }) {
  const lines = String(text).split('\n').map(l => l.replace(/\r$/, ''));
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return {
    oldPath: null,
    newPath: String(path).replace(/\\/g, '/'),
    status: 'added',
    binary: false,
    hunks: lines.length
      ? [{ oldStart: 0, newStart: 1, lines: lines.map((t, i) => ({ kind: '+', text: t, oldLine: null, newLine: i + 1 })) }]
      : [],
    added: lines.map((t, i) => ({ line: i + 1, text: t, hunk: 0 })),
    removed: [],
  };
}

// Folds deleted record d and added record u into one renamed record, keeping only what changed,
// as git shows a rename with edits.
function fold(records, d, u) {
  const left = new Map();
  for (const a of u.added) { const t = a.text.trim(); left.set(t, (left.get(t) ?? 0) + 1); }
  const kept = new Map();
  const removed = d.removed.filter(r => {
    const t = r.text.trim();
    if ((left.get(t) ?? 0) === 0) return true;
    left.set(t, left.get(t) - 1);
    kept.set(t, (kept.get(t) ?? 0) + 1);
    return false;
  });
  const added = u.added.filter(a => {
    const t = a.text.trim();
    if ((kept.get(t) ?? 0) === 0) return true;
    kept.set(t, kept.get(t) - 1);
    return false;
  });
  const lines = [
    ...removed.map(r => ({ kind: '-', text: r.text, oldLine: r.line, newLine: null })),
    ...added.map(a => ({ kind: '+', text: a.text, oldLine: null, newLine: a.line })),
  ];
  d.newPath = u.newPath;
  d.status = 'renamed';
  d.removed = removed.map(r => ({ ...r, hunk: 0 }));
  d.added = added.map(a => ({ ...a, hunk: 0 }));
  d.hunks = lines.length ? [{ oldStart: 1, newStart: 1, lines }] : [];
  records.splice(records.indexOf(u), 1);
}

const isNewFile = (u) => u.status === 'added' && u.oldPath === null && u.hunks.length === 1;
const fileName = (p) => String(p).split('/').pop();
// Braces, blank lines and one-word lines are in every file, so they say nothing about a move.
const telling = (t) => t.replace(/\s+/g, '').length >= 3 && /\w/.test(t);

function shared(oldLines, u, keep) {
  const pool = new Map();
  for (const a of u.added) { const t = a.text.trim(); if (keep(t)) pool.set(t, (pool.get(t) ?? 0) + 1); }
  let n = 0;
  for (const t of oldLines) {
    if ((pool.get(t) ?? 0) > 0) { n++; pool.set(t, pool.get(t) - 1); }
  }
  return n;
}

// git only pairs renames among tracked paths, so a file moved with plain mv shows up as a deletion
// plus an untracked file. Fold each such pair back into one renamed record when most lines survive.
// A second pass takes a file of the same name that kept most of the old lines but grew past
// twice their size, which git (and the first pass) read as a delete and an add.
function pairMoves(records) {
  const gone = records.filter(r => r.status === 'deleted' && r.removed.length);
  for (const d of gone) {
    const oldLines = d.removed.map(r => r.text.trim()).filter(Boolean);
    if (!oldLines.length) continue;
    let best = null;
    let bestScore = 0;
    for (const u of records) {
      if (!isNewFile(u)) continue;
      const score = shared(oldLines, u, Boolean) / Math.max(oldLines.length, u.added.filter(a => a.text.trim()).length);
      if (score >= 0.5 && score > bestScore) { best = u; bestScore = score; }
    }
    if (best) fold(records, d, best);
  }
  for (const d of gone) {
    if (d.status !== 'deleted') continue;
    const oldLines = d.removed.map(r => r.text.trim()).filter(telling);
    if (!oldLines.length) continue;
    let best = null;
    let bestScore = 0;
    for (const u of records) {
      if (!isNewFile(u) || fileName(u.newPath) !== fileName(d.oldPath)) continue;
      const score = shared(oldLines, u, telling) / oldLines.length;
      if (score >= 0.6 && score > bestScore) { best = u; bestScore = score; }
    }
    if (best) fold(records, d, best);
  }
}

const clipTrim = (s) => s.trim();

export function scan(source, config) {
  const notes = [...(source.notes ?? [])];
  const cfg = config === undefined ? loadConfig(source, notes) : normalizeConfig(config);

  const { files: parsed, truncated } = parseDiff(source.diffText ?? '');
  const seen = new Set(parsed.map(f => f.newPath).filter(Boolean));
  const merged = [...parsed];
  for (const u of source.untracked ?? []) {
    const rec = untrackedRecord(u);
    if (!seen.has(rec.newPath)) { merged.push(rec); seen.add(rec.newPath); }
  }
  pairMoves(merged);
  if (merged.length === 0) notes.push('no changes to scan');

  // A record that touches a skipped directory on one side only (a test moved into build/) still
  // has a real path on the other side, so it stays.
  const skipped = (p) => p == null || DEFAULT_SKIP_DIRS.test(p) || matchesAny(p, cfg.ignore);
  const files = merged.filter(f => !(skipped(f.newPath) && skipped(f.oldPath)));

  const isTest = (p) => isTestPath(p, cfg.tests);
  const allAddedTrimmed = new Set();
  for (const f of files) for (const a of f.added) allAddedTrimmed.add(clipTrim(a.text));

  const ctx = { files, config: cfg, source, isTest, allAddedTrimmed, truncated };
  ctx.trees = treeAccess(ctx);

  let raw = [];
  for (const rule of RULES) raw = raw.concat(rule.check(ctx));
  // Only a rule that wanted code the diff does not show says so.
  if (!ctx.trees.available && ctx.trees.wanted) notes.push(DIFF_ALONE_NOTE);
  if (ctx.trees.capped) notes.push(`stopped reading the base and head files at the cap of ${ctx.trees.cap ?? 'files'} per side; checks that needed more were judged on the diff alone`);

  let allowed = 0;
  const kept = [];
  const dedup = new Set();
  for (const f of raw) {
    if (cfg.allow.some(e => e.rule === f.rule && matchesAny(f.file, [e.path]))) { allowed++; continue; }
    const key = `${f.rule}|${f.file}|${f.line}`;
    if (dedup.has(key)) continue;
    dedup.add(key);
    kept.push(f);
  }
  kept.sort((a, b) =>
    (a.tier === b.tier ? 0 : a.tier === 'HARD' ? -1 : 1)
    || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
    || a.line - b.line
    || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));

  let testFiles = 0;
  let assertionsAdded = 0;
  let assertionsRemoved = 0;
  const isAssert = (t) => !isCommentLine(t) && ASSERT.test(t);
  for (const f of files) {
    const testy = (f.newPath != null && isTest(f.newPath)) || (f.oldPath != null && isTest(f.oldPath));
    if (!testy) continue;
    testFiles++;
    assertionsAdded += f.added.filter(a => isAssert(a.text)).length;
    assertionsRemoved += f.removed.filter(r => isAssert(r.text)).length;
  }

  const verdict = kept.some(f => f.tier === 'HARD') ? 'CAUGHT' : kept.length ? 'SUSPICIOUS' : 'CLEAN';

  return {
    schema: 'red-handed/1',
    verdict,
    source: {
      kind: source.kind ?? null,
      label: source.label ?? null,
      base: source.base ?? null,
      url: source.url ?? null,
      title: source.title ?? null,
      author: source.author ?? null,
      authorIsBot: source.authorIsBot ?? null,
    },
    stats: { files: files.length, testFiles, assertionsAdded, assertionsRemoved, allowed, truncated },
    notes,
    findings: kept,
  };
}

// What a scan of source would read from its trees and could not: the paths each side answered
// unknown (undefined) for, and whether a listing was wanted. The scan itself is thrown away. A path
// a known listing says is absent is left out. PR mode fetches what this returns and asks again.
export function planReads(source, config) {
  const want = { base: new Set(), head: new Set(), lists: { base: false, head: false } };
  const recording = (side) => {
    const inner = source.trees?.[side];
    return {
      capped: false,
      list() { const l = inner?.list() ?? null; if (l == null) want.lists[side] = true; return l; },
      read(p) { const t = inner ? inner.read(p) : undefined; if (t === undefined) want[side].add(p); return t; },
    };
  };
  scan({ ...source, trees: { base: recording('base'), head: recording('head') } }, config);
  const left = (side) => {
    const l = source.trees?.[side]?.list() ?? null;
    const listed = l ? new Set(l) : null;
    return [...want[side]].filter(p => !listed || listed.has(p)).sort();
  };
  return { base: left('base'), head: left('head'), lists: want.lists };
}
