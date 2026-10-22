// scan(source, config) -> Result. Builds the context, runs the rules in order, applies the
// allow list, dedups, sorts and picks the verdict.
//
// config is optional. Left out (undefined), scan reads .red-handed.json from the base side of a
// local source itself and adds the matching note. A plain object is used as given.

import { parseDiff } from './diff.mjs';
import { isTestPath, isCommentLine, ASSERT } from './classify.mjs';
import { matchesAny } from './glob.mjs';
import { RULES } from './rules.mjs';

const CONFIG_FILE = '.red-handed.json';
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

const clipTrim = (s) => s.trim();

export function scan(source, config) {
  const notes = [];
  const cfg = config === undefined ? loadConfig(source, notes) : normalizeConfig(config);

  const { files: parsed, truncated } = parseDiff(source.diffText ?? '');
  const seen = new Set(parsed.map(f => f.newPath).filter(Boolean));
  const merged = [...parsed];
  for (const u of source.untracked ?? []) {
    const rec = untrackedRecord(u);
    if (!seen.has(rec.newPath)) { merged.push(rec); seen.add(rec.newPath); }
  }
  if (merged.length === 0) notes.push('no changes to scan');

  const skipped = (p) => p != null && (DEFAULT_SKIP_DIRS.test(p) || matchesAny(p, cfg.ignore));
  const files = merged.filter(f => !skipped(f.newPath) && !skipped(f.oldPath));

  const isTest = (p) => isTestPath(p, cfg.tests);
  const allAddedTrimmed = new Set();
  for (const f of files) for (const a of f.added) allAddedTrimmed.add(clipTrim(a.text));

  const ctx = { files, config: cfg, source, isTest, allAddedTrimmed, truncated };

  let raw = [];
  for (const rule of RULES) raw = raw.concat(rule.check(ctx));

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
