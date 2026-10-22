// What the production side of a diff declares, so the rules can ask whether a change deleted or
// reshaped the code a removed test line called. Everything here reads the parsed diff only.

import { isSourcePath, isCommentLine, language } from './classify.mjs';

// Splits at the commas that are not inside brackets or quotes.
export function splitTop(s) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (quote) {
      cur += ch;
      if (ch === '\\') cur += s[++k] ?? '';
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; }
    else if ('([{'.includes(ch)) { depth++; cur += ch; }
    else if (')]}'.includes(ch)) { depth--; cur += ch; }
    else if (ch === ',' && depth === 0) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// Index of the bracket that closes the one at s[open], or -1 when the line ends first.
export function closeOf(s, open) {
  let depth = 0;
  let quote = null;
  for (let k = open; k < s.length; k++) {
    const ch = s[k];
    if (quote) {
      if (ch === '\\') k++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch) && --depth === 0) return k;
  }
  return -1;
}

// Brackets a line opens and does not close, strings skipped.
function openDepth(s) {
  let depth = 0;
  let quote = null;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (quote) {
      if (ch === '\\') k++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '/' && s[k + 1] === '/') break;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
  }
  return depth;
}

// The whole statement that starts on line `entry` of f (an added or removed line), with the lines
// it runs on to joined in: an assertion split over two lines reads as one. A removed statement
// goes on through removed and context lines, an added one through added and context lines.
const joinCache = new WeakMap();
export function statementOf(f, entry, kind) {
  let cache = joinCache.get(f);
  if (!cache) { cache = new Map(); joinCache.set(f, cache); }
  const key = `${kind}${entry.hunk}:${entry.line}`;
  if (cache.has(key)) return cache.get(key);
  const lines = f.hunks[entry.hunk]?.lines ?? [];
  const at = lines.findIndex(l => l.kind === kind && (kind === '-' ? l.oldLine : l.newLine) === entry.line);
  let text = entry.text;
  if (at >= 0 && openDepth(text) > 0) {
    let depth = openDepth(text);
    for (let j = at + 1, n = 0; j < lines.length && depth > 0 && n < 8; j++) {
      if (lines[j].kind !== kind && lines[j].kind !== ' ') continue;
      text += ' ' + lines[j].text.trim();
      depth += openDepth(lines[j].text);
      n++;
    }
  }
  cache.set(key, text);
  return text;
}

const countArgs = (s) => (s.trim() ? splitTop(s).length : 0);
// Generic parameters hold commas of their own: Map<String, Integer> m is one parameter.
const stripGenerics = (s) => { let t = s; let prev; do { prev = t; t = t.replace(/<[^<>]*>/g, ''); } while (t !== prev); return t; };

// A deleted or moved test line can be matched against an added one with other names for things.
const IDENT = /(?<![.\w$])[A-Za-z_$][\w$]*\b(?!\s*\()/g;
export const normalised = (t) => t.trim().replace(IDENT, 'I').replace(/\s+/g, ' ');

// Stricter, for clearing a deleted test file: only a class the check calls through may differ
// (ResourceHud.gaugeFor reads HudPanel.gaugeFor). Arguments and locals stay as written, or a
// check run on another fixture would count as the same check.
const RECEIVER_CLASS = /(?<![.\w$])[A-Z][\w$]*(?=\s*\.)/g;
const receiversNormalised = (t) => t.trim().replace(RECEIVER_CLASS, 'I').replace(/\s+/g, ' ');

// An assertion's failure message dropped, so a check whose message was edited still matches its
// old self. Only a plain string literal beyond the arguments the check needs is a message:
// assertEqual(actual, "shipped") is checking "shipped", and "ACTIVE".equals(x) is a condition.
// JUnit 4 puts the message first, everything else last. A two-argument assertTrue or assertNull
// can only have its message at the end that is a literal, since a literal is never the condition.
// A bare assertEquals with three arguments is only read when the file says which JUnit it is.
const ONE_ARG = /^(assertTrue|assertFalse|assertNull|assertNotNull|assertIsNone|assertIsNotNone)$/;
const PLAIN_STRING = /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\$])*`)$/;
export function dropMessage(t, { jupiter = false, junit4 = false } = {}) {
  const m = /(?<![\w$])(?:([\w$]+)\.)?(assert\w+)\s*\(/.exec(t);
  if (!m) return t;
  const open = m.index + m[0].length - 1;
  const close = closeOf(t, open);
  if (close < 0) return t;
  const parts = splitTop(t.slice(open + 1, close));
  const need = ONE_ARG.test(m[2]) ? 1 : 2;
  if (parts.length <= need) return t;
  const lit = (k) => PLAIN_STRING.test((parts[k] ?? '').trim());
  const recv = m[1];
  let at = -1;
  if (need === 1 && parts.length === 2) {
    if (lit(0) !== lit(1)) at = lit(0) ? 0 : 1;
  } else if (junit4 && (!recv || recv === 'Assert')) {
    if (lit(0)) at = 0;
  } else if (recv || jupiter) {
    if (lit(parts.length - 1)) at = parts.length - 1;
  }
  if (at < 0) return t;
  const kept = parts.filter((_, k) => k !== at).map((s, k) => (k === 0 ? s.replace(/^\s+/, '') : s));
  return t.slice(0, open + 1) + kept.join(',') + t.slice(close);
}

export const moveKey = (t, opts) => receiversNormalised(dropMessage(t, opts));
export const looseMoveKey = (t, opts) => normalised(dropMessage(t, opts));


// ---- declarations ---------------------------------------------------------------------------

const OVERLOADS = new Set(['jvm', 'cs']);
const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'return', 'new', 'catch', 'else', 'do', 'try', 'synchronized', 'function', 'throw', 'typeof', 'await', 'yield', 'super', 'this']);
const JVM_TYPE = /(?<![.\w$])(?:class|interface|enum|record|object)\s+([A-Za-z_$][\w$]*)/;
// Modifiers, generics and the return type all fall in the first group.
const JVM_METHOD = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*([\w$.<>\[\],? ]+?)\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?:throws\s[^{]*)?\{?\s*$/;
// Cheap test first: the full pattern backtracks on long lines that cannot be a method header.
const JVM_METHOD_TAIL = /\)\s*(?:throws\s[^{]*)?\{?\s*$/;
const KOTLIN_FUN = /\bfun\s+(?:<[^>]+>\s*)?(?:[\w$]+\.)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/;
// A final field with or without its value: "final int guides = 1;" and "final int guides;".
const JVM_FIELD = /\b(?:final|const|readonly)\s+[\w$<>\[\],.? ]+?\s+([A-Za-z_$][\w$]*)\s*(?:=|;\s*$)/;
const KOTLIN_VAL = /^\s*(?:(?:private|public|internal|protected|const)\s+)*(?:val|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/;
const ENUM_CONSTANT = /^\s*([A-Z][A-Z0-9_]*)\s*(\(.*\))?\s*(\{\s*)?[,;]?\s*$/;
const JS_FUNCTION = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/;
const JS_CLASS = /(?<![.\w$])class\s+([A-Za-z_$][\w$]*)/;
const JS_BINDING = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.*)$/;
const JS_METHOD = /^\s*(?:(?:public|private|protected|readonly|override)\s+)*(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?\*?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::[^{]+)?\{\s*$/;
const JS_EXPORT_LIST = /^\s*export\s*\{([^}]*)\}/;
const PY_DEF = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/;
const PY_CLASS = /^\s*class\s+([A-Za-z_]\w*)/;
const PY_GLOBAL = /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/;
const GO_FUNC = /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(([^)]*)\)/;
const GO_TYPE = /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/;
const RUST_FN = /\bfn\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/;
const RUST_TYPE = /\b(?:struct|enum|trait)\s+([A-Za-z_]\w*)/;
const RUST_CONST = /\b(?:const|static)\s+([A-Z_][A-Z0-9_]*)\s*:/;

const pyArity = (params) => splitTop(params).map(s => s.trim()).filter(s => s && s !== 'self' && s !== 'cls').length;

// The declarations on one line: [{ name, kind, arity }]. kind is type, fn or field.
export function declarationsOn(text, lang) {
  if (isCommentLine(text)) return [];
  const out = [];
  if (lang === 'jvm' || lang === 'cs') {
    // Annotations sit anywhere among the modifiers and parameters: "public static @Nullable String f(".
    text = text.replace(/@[\w$.]+(?:\([^)]*\))?\s*/g, '');
    const t = JVM_TYPE.exec(text);
    if (t) out.push({ name: t[1], kind: 'type', arity: null });
    const k = KOTLIN_FUN.exec(text);
    if (k) out.push({ name: k[1], kind: 'fn', arity: countArgs(stripGenerics(k[2])) });
    const m = !t && !k && JVM_METHOD_TAIL.test(text) && JVM_METHOD.exec(text);
    if (m && !NOT_A_NAME.has(m[2]) && !/(^|\s)(new|return|throw|else)$/.test(m[1].trim()) && !/[=.]$/.test(m[1].trim())) {
      out.push({ name: m[2], kind: 'fn', arity: countArgs(stripGenerics(m[3])) });
    }
    const f = JVM_FIELD.exec(text) ?? KOTLIN_VAL.exec(text);
    if (f) out.push({ name: f[1], kind: 'field', arity: null });
    else if (!t && !m) {
      const e = ENUM_CONSTANT.exec(text);
      if (e) out.push({ name: e[1], kind: 'field', arity: null });
    }
  } else if (lang === 'js') {
    const c = JS_CLASS.exec(text);
    if (c) out.push({ name: c[1], kind: 'type', arity: null });
    const fn = JS_FUNCTION.exec(text);
    if (fn) out.push({ name: fn[1], kind: 'fn', arity: countArgs(fn[2]) });
    const b = !fn && JS_BINDING.exec(text);
    if (b) {
      const arrow = /^(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*(?::[^=]+)?=>/.exec(b[2]);
      const fexpr = /^(?:async\s+)?function\b\s*\*?\s*[\w$]*\s*\(([^)]*)\)/.exec(b[2]);
      if (arrow) out.push({ name: b[1], kind: 'fn', arity: arrow[2] ? 1 : countArgs(arrow[1]) });
      else if (fexpr) out.push({ name: b[1], kind: 'fn', arity: countArgs(fexpr[1]) });
      else out.push({ name: b[1], kind: 'field', arity: null });
    }
    const me = !fn && !b && !c && JS_METHOD.exec(text);
    if (me && !NOT_A_NAME.has(me[1])) out.push({ name: me[1], kind: 'fn', arity: countArgs(me[2]) });
    const ex = JS_EXPORT_LIST.exec(text);
    if (ex) {
      for (const part of ex[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push({ name, kind: 'field', arity: null });
      }
    }
  } else if (lang === 'py') {
    const d = PY_DEF.exec(text);
    if (d) out.push({ name: d[1], kind: 'fn', arity: pyArity(d[2]) });
    const c = PY_CLASS.exec(text);
    if (c) out.push({ name: c[1], kind: 'type', arity: null });
    const g = !d && !c && PY_GLOBAL.exec(text);
    if (g) out.push({ name: g[1], kind: 'field', arity: null });
  } else if (lang === 'go') {
    const f = GO_FUNC.exec(text);
    if (f) out.push({ name: f[1], kind: 'fn', arity: countArgs(f[2]) });
    const t = GO_TYPE.exec(text);
    if (t) out.push({ name: t[1], kind: 'type', arity: null });
  } else if (lang === 'rust') {
    const f = RUST_FN.exec(text);
    if (f) out.push({ name: f[1], kind: 'fn', arity: countArgs(f[2]) });
    const t = RUST_TYPE.exec(text);
    if (t) out.push({ name: t[1], kind: 'type', arity: null });
    const c = RUST_CONST.exec(text);
    if (c) out.push({ name: c[1], kind: 'field', arity: null });
  }
  return out;
}

const norm = (p) => String(p).replace(/\\/g, '/');
const dirOf = (p) => norm(p).split('/').slice(0, -1).join('/');
const stemOfPath = (p) => norm(p).split('/').pop().replace(/\.[^.]+$/, '');
export const modKey = (p) => norm(p).replace(/\.[^./]+$/, '').replace(/\/(index|__init__)$/, '');

// The package of a jvm or cs file: its package or namespace line, else the path after the source root.
function packageOf(f, path) {
  for (const h of f.hunks) {
    for (const l of h.lines) {
      const m = /^\s*(?:package|namespace)\s+([\w.]+)/.exec(l.text);
      if (m) return m[1];
    }
  }
  const p = norm(path);
  const m = /(?:^|\/)src\/[^/]+\/(?:java|kotlin|scala|groovy)\/(.+)\/[^/]+$/.exec(p)
    ?? /(?:^|\/)src\/(.+)\/[^/]+$/.exec(p);
  return m ? m[1].replace(/\//g, '.') : dirOf(p).replace(/\//g, '.');
}

const RESOURCE_DIR = /(^|\/)(resources|assets|data|lang)\//;
const RESOURCE_EXT = /\.(json|lang|properties|toml|ya?ml)$/i;
const RESOURCE_KEY = /^\s*"([^"]+)"\s*:|^\s*([\w.-]+)\s*=/;

// The resource ids a change takes away: deleted data files by stem (and ns:stem under data/<ns>/ or
// assets/<ns>/), and keys removed from a lang or data file that no added line puts back.
function goneResources(files) {
  const ids = new Map();
  for (const f of files) {
    const p = norm(f.oldPath ?? f.newPath);
    if (!RESOURCE_DIR.test(p) || !RESOURCE_EXT.test(p)) continue;
    if (f.status === 'deleted') {
      const stem = stemOfPath(p);
      ids.set(stem, p);
      const ns = /(?:^|\/)(?:data|assets)\/([^/]+)\//.exec(p);
      if (ns) ids.set(`${ns[1]}:${stem}`, p);
      continue;
    }
    const addedKeys = new Set(f.added.map(a => RESOURCE_KEY.exec(a.text)).filter(Boolean).map(m => m[1] ?? m[2]));
    for (const r of f.removed) {
      const m = RESOURCE_KEY.exec(r.text);
      const key = m && (m[1] ?? m[2]);
      if (key && !addedKeys.has(key)) ids.set(key, p);
    }
  }
  return ids;
}

const indexCache = new WeakMap();

// Built once per scan. Test files are never indexed as production.
export function sourceIndex(ctx) {
  if (indexCache.has(ctx)) return indexCache.get(ctx);
  const extra = ctx.config?.tests ?? [];
  const decls = [];
  const byName = new Map();
  const records = [];
  const hunkDecls = new Map();
  for (const f of ctx.files) {
    const isSrc = (p) => p != null && isSourcePath(p, extra);
    if (!isSrc(f.oldPath) && !isSrc(f.newPath)) continue;
    const path = norm(f.newPath ?? f.oldPath);
    const lang = language(path);
    const rec = { f, path, lang, mod: modKey(path), pkg: OVERLOADS.has(lang) ? packageOf(f, path) : null };
    records.push(rec);
    // The types that enclose a line, by indent: a method after a nested enum belongs to the class
    // around both, not to the enum. A hunk that does not show the enclosing type falls back to the stem.
    // Only a top-level type carries over to the next hunk: the lines between hunks are not seen, so
    // a nested type may have closed there. A member whose own type header this hunk does not show
    // has a guessed owner, which a qualified ref (Outer.Inner) may also match by its outer name.
    const stem = stemOfPath(path);
    let types = [];
    f.hunks.forEach((h, hunk) => {
      const inHunk = [];
      hunkDecls.set(h, inHunk);
      types = types.filter(t => t.ind === 0).map(t => ({ ...t, carried: true }));
      // The function or class git names after the @@ is still there, around the lines of the hunk.
      // Git cuts that line short, so a parameter list may be open; its arity is then unknown. A
      // type named there may not be the innermost one, so members below it stay guessed.
      if (h.context) {
        const closed = declarationsOn(h.context, lang);
        const found = closed.length ? closed : declarationsOn(h.context + ')', lang).map(d => ({ ...d, arity: null }));
        const ind = /^\s*/.exec(h.context)[0].length;
        while (types.length && types[types.length - 1].ind >= ind) types.pop();
        for (const d of found) {
          const decl = { ...d, side: ' ', hunk, rec, top: ind === 0, outer: types[0]?.name ?? stem, fromContext: true,
            owner: OVERLOADS.has(lang) ? (d.kind === 'type' ? d.name : (types[types.length - 1]?.name ?? stem)) : rec.mod, ownerGuessed: OVERLOADS.has(lang) && d.kind !== 'type' };
          decls.push(decl);
          inHunk.push(decl);
          if (!byName.has(decl.name)) byName.set(decl.name, []);
          byName.get(decl.name).push(decl);
        }
        const t = OVERLOADS.has(lang) && found.find(d => d.kind === 'type');
        if (t) types.push({ ind, name: t.name, carried: true });
      }
      for (const l of h.lines) {
        const found = declarationsOn(l.text, lang);
        if (!found.length) continue;
        const ind = /^\s*/.exec(l.text)[0].length;
        while (types.length && types[types.length - 1].ind >= ind) types.pop();
        const top = types[types.length - 1];
        const owner = top ? top.name : stem;
        for (const d of found) {
          const decl = { ...d, side: l.kind, hunk, rec, top: ind === 0, outer: types[0]?.name ?? stem,
            owner: OVERLOADS.has(lang) ? (d.kind === 'type' ? d.name : owner) : rec.mod,
            ownerGuessed: OVERLOADS.has(lang) && d.kind !== 'type' && (!top || top.carried) };
          decls.push(decl);
          inHunk.push(decl);
          if (!byName.has(decl.name)) byName.set(decl.name, []);
          byName.get(decl.name).push(decl);
        }
        // "enum Station { A, B }" opens and closes on one line, so it encloses nothing below it.
        const t = OVERLOADS.has(lang) && found.find(d => d.kind === 'type');
        const opens = (l.text.match(/\{/g) ?? []).length > (l.text.match(/\}/g) ?? []).length || !l.text.includes('{');
        if (t && opens) types.push({ ind, name: t.name });
      }
    });
  }
  // Does a hunk change code: a line on one side whose text is not on the other. A comment or
  // whitespace edit is not a change.
  // With `upto`, only the lines before that index count.
  const edits = new Map();
  const hunkEdits = (h, upto = Infinity) => {
    if (!h) return false;
    if (!edits.has(h)) edits.set(h, new Map());
    const memo = edits.get(h);
    if (memo.has(upto)) return memo.get(upto);
    const lines = h.lines.slice(0, upto);
    const side = (k) => new Set(lines.filter(l => l.kind === k).map(l => l.text.trim()));
    const minus = side('-');
    const plus = side('+');
    const out = lines.some(l => {
      const t = l.text.trim();
      if (l.kind === ' ' || !t || isCommentLine(t)) return false;
      return !(l.kind === '-' ? plus : minus).has(t);
    });
    memo.set(upto, out);
    return out;
  };
  // The function git names in the @@ line owns the hunk only down to the first declaration in it.
  const firstDecl = new Map();
  const contextEdits = (d) => {
    const h = d.rec.f.hunks[d.hunk];
    if (!firstDecl.has(h)) {
      const at = h.lines.findIndex(l => declarationsOn(l.text, d.rec.lang).length);
      firstDecl.set(h, at < 0 ? Infinity : at);
    }
    return hunkEdits(h, firstDecl.get(h));
  };
  const named = (name) => byName.get(name) ?? [];
  const fitsArity = (d, arity) => arity == null || d.arity == null || !OVERLOADS.has(d.rec.lang) || d.arity === arity;
  // A deleted type is back only when some file adds a top-level type of that name. A nested
  // record Chip inside another class is not the deleted Chip moving.
  const plusNames = new Set(decls.filter(d => d.side === '+' && d.top).map(d => d.name));
  const minusNames = new Set(decls.filter(d => d.side === '-').map(d => d.name));

  const deletedSources = records.filter(r => r.f.status === 'deleted').map(r => {
    // Top-level names only: a nested enum Phase says nothing, another file can have its own.
    const own = decls.filter(d => d.rec === r && d.side === '-' && d.top && (d.kind === 'type' || (!OVERLOADS.has(r.lang) && d.kind === 'fn')));
    const primary = new Set(own.map(d => d.name));
    if (OVERLOADS.has(r.lang)) primary.add(stemOfPath(r.path));
    return { path: r.path, rec: r, primary, reallyGone: ![...primary].some(n => plusNames.has(n)) };
  });
  const resources = goneResources(ctx.files);

  const idx = {
    records,
    deletedSources,
    // Top-level directories (and root modules) of every file in the diff: the project's own.
    roots: new Set(ctx.files.flatMap(f => [f.oldPath, f.newPath]).filter(p => p != null).map(p => modKey(p).split('/')[0])),
    declared: (name) => byName.has(name) || deletedSources.some(s => s.primary.has(name)),
    // Removed where the ref points, and declared nowhere else under the same owner. A class that
    // reappears in another package keeps its members alive, so a fake move excuses nothing. A
    // surviving overload of the same arity keeps a call alive; one of another arity does not.
    gone(name, where, arity) {
      const removed = named(name).filter(d => d.side === '-' && where(d) && fitsArity(d, arity));
      if (!removed.length) return false;
      const sameOwner = (r, d) => !OVERLOADS.has(r.rec.lang) || r.owner === d.owner;
      return !named(name).some(d => d.side !== '-' && fitsArity(d, arity) && removed.some(r => sameOwner(r, d)));
    },
    // The file a gone name was declared in, for the message.
    goneFrom(name, where) { return named(name).find(d => d.side === '-' && where(d))?.rec.path ?? null; },
    declaredIn(name, where) { return named(name).find(d => where(d))?.rec.path ?? null; },
    // One declaration swapped for one other of the same kind and arity in the same hunk.
    renamed(name, where) {
      for (const d of named(name)) {
        if (d.side !== '-' || !where(d)) continue;
        const inHunk = hunkDecls.get(d.rec.f.hunks[d.hunk]) ?? [];
        if (inHunk.filter(x => x.side === '-' && x.name === name).length !== 1) continue;
        const to = inHunk.filter(x => x.side === '+' && x.name !== name && x.kind === d.kind && x.arity === d.arity && !minusNames.has(x.name));
        if (to.length === 1) return to[0].name;
      }
      return null;
    },
    arityChanged(name, where) {
      const ds = named(name).filter(d => d.kind === 'fn' && where(d));
      const from = new Set(ds.filter(d => d.side === '-').map(d => d.arity));
      const to = new Set(ds.filter(d => d.side === '+').map(d => d.arity));
      const alive = new Set(ds.filter(d => d.side !== '-').map(d => d.arity));
      if (!from.size || !to.size || [...from].some(a => alive.has(a))) return null;
      return { from, to };
    },
    // A hunk that shows the declaration also changes code. A comment or whitespace edit is not a touch.
    touched(name, where) {
      return named(name).some(d => where(d) && (d.fromContext ? contextEdits(d) : hunkEdits(d.rec.f.hunks[d.hunk])));
    },
    // The production file a test file mirrors by name and place, when this change edits its code.
    mirrorEdited(testPath) {
      const keys = testMirrors(testPath);
      return records.find(r => keys.has(r.mod) && r.f.status !== 'deleted' && r.f.hunks.some(h => hunkEdits(h)))?.path ?? null;
    },
    // Every added declaration of name has a body that only returns a literal (return true;).
    constantBody(name) {
      const added = named(name).filter(d => d.side === '+' && d.kind === 'fn');
      return added.length > 0 && added.every(d => {
        const lines = d.rec.f.hunks[d.hunk]?.lines ?? [];
        const at = lines.findIndex(l => l.kind === '+' && declarationsOn(l.text, d.rec.lang).some(x => x.name === name));
        if (at < 0) return false;
        const base = /^\s*/.exec(lines[at].text)[0].length;
        const head = lines[at].text;
        const inline = /\{(.*)\}\s*$/.exec(head);
        const body = inline ? [inline[1]] : [];
        if (!inline) {
          for (let k = at + 1; k < lines.length; k++) {
            const t = lines[k].text;
            if (!t.trim() || isCommentLine(t)) continue;
            if (/^\s*/.exec(t)[0].length <= base) break;
            body.push(t);
          }
        }
        const code = body.map(t => t.trim()).filter(t => t && t !== '{' && t !== '}');
        return code.length > 0 && code.every(t => /^return\s+(?:true|false|True|False|null|None|-?\d+(?:\.\d+)?[fFdDlL]?|"[^"]*"|'[^']*')\s*;?$/.test(t));
      });
    },
    newlyDeclared: (name) => named(name).some(d => d.side === '+') && !named(name).some(d => d.side !== '+'),
    resourceGone: (id) => resources.get(id) ?? null,
  };
  indexCache.set(ctx, idx);
  return idx;
}

// ---- what a test file points at -------------------------------------------------------------

const RELATIVE_SPEC = /^\.{1,2}\//;
function resolveRelative(fromPath, spec) {
  const parts = dirOf(fromPath).split('/').filter(Boolean);
  for (const seg of spec.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return modKey(parts.join('/'));
}

// Where the code a test file tests usually sits, as module keys: perception.test.ts beside or
// above it, test_cart.py next to cart.py or under src/, CartTest.java under src/main/.
const testStem = (base) => base.replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/i, '').replace(/^test_/i, '').replace(/_(test|spec)$/i, '').replace(/Tests?$/, '');
export function testMirrors(path) {
  const p = norm(path);
  const stem = testStem(p.split('/').pop());
  const dir = dirOf(p);
  const seg = /(^|\/)(?:test|tests|__tests__)(\/|$)/;
  const dirs = new Set([dir, dirOf(dir), dir.replace(/(^|\/)src\/test\//, '$1src/main/'), dir.replace(seg, '$1src$2'), dir.replace(seg, (m, a, b) => (a && b ? '/' : ''))]);
  return new Set([...dirs].map(d => (d ? `${d}/${stem}` : stem)));
}

// A name the test calls with no import in view: in a file shown in part, the import may sit above
// the hunk, so the module the test mirrors is what it means. A file shown whole has no such import.
function mirrored(t, recv) {
  if (t.whole || (recv && !/^[A-Z]/.test(recv))) return null;
  const keys = testMirrors(t.path);
  return (d) => keys.has(d.rec.mod);
}

const testCache = new WeakMap();

// Imports and package of a test file, from its removed and context lines.
export function testContext(f) {
  if (testCache.has(f)) return testCache.get(f);
  const path = norm(f.oldPath ?? f.newPath);
  const lang = language(path);
  const lines = f.hunks.flatMap(h => h.lines.filter(l => l.kind !== '+').map(l => l.text));
  const info = { path, lang, pkg: OVERLOADS.has(lang) ? packageOf(f, path) : null, types: new Map(), wild: new Set(), statics: new Map(), names: new Map(), mods: new Set(), locals: new Map(), inits: new Map(), jupiter: false, junit4: false, whole: f.status === 'deleted' || f.status === 'added' };
  for (const t of f.hunks.flatMap(h => h.lines.map(l => l.text))) {
    if (/\borg\.junit\.jupiter\b/.test(t)) info.jupiter = true;
    else if (/\borg\.junit\.(?:Assert|Test)\b/.test(t)) info.junit4 = true;
  }
  if (info.jupiter) info.junit4 = false;
  // Names the test file declares for itself (its constants, helpers and nested types) are its own.
  info.own = new Set(f.hunks.flatMap(h => h.lines.filter(l => l.kind !== '+')).flatMap(l => declarationsOn(l.text, lang).map(d => d.name)));
  const bindMod = (local, key) => { info.names.set(local, key); info.mods.add(key); };
  for (const t of lines) {
    if (OVERLOADS.has(lang)) {
      // Locals with a declared type, so product.isEmpty() on an ItemStack is not read as any isEmpty.
      // A nested type keeps its outer name: PoolPlay.World station.
      for (const m of t.matchAll(/(?<![\w$.])((?:[A-Z][\w$]*\.)*[A-Z][\w$]*)(?:<[^>]*>)?(?:\[\])?\s+([a-z_$][\w$]*)\s*(?=[=;,)])/g)) info.locals.set(m[2], m[1]);
      for (const m of t.matchAll(/\bvar\s+([a-z_$][\w$]*)\s*=\s*new\s+((?:[A-Z][\w$]*\.)*[A-Z][\w$]*)/g)) info.locals.set(m[1], m[2]);
      const init = /^\s*(?:final\s+)?([A-Za-z_$][\w$<>,.\[\] ]*?)\s+([a-z_$][\w$]*)\s*=(?!\s*new\s)\s*(.*\(.*)$/.exec(t);
      if (init && !NOT_A_NAME.has(init[1].trim())) info.inits.set(init[2], init[3]);
      const st =/^\s*import\s+static\s+([\w.]+)\.([A-Za-z_$][\w$]*)\.([\w$*]+)\s*;?/.exec(t);
      if (st) { info.statics.set(st[3], { pkg: st[1], owner: st[2] }); continue; }
      const im = /^\s*(?:import|using)\s+([\w.]+)\.([A-Za-z_$][\w$]*|\*)\s*;?\s*$/.exec(t);
      if (im) {
        if (im[2] === '*') info.wild.add(im[1]);
        else { if (!info.types.has(im[2])) info.types.set(im[2], new Set()); info.types.get(im[2]).add(im[1]); }
      }
    } else if (lang === 'js') {
      const init = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!\s*require\s*\()(?!\s*new\s)\s*(.*\(.*)$/.exec(t);
      if (init) info.inits.set(init[1], init[2]);
      const from = /^\s*import\s+(.+?)\s+from\s+['"]([^'"]+)['"]/.exec(t);
      const req = /^\s*(?:const|let|var)\s+(.+?)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/.exec(t);
      const m = from ?? req;
      if (!m || !RELATIVE_SPEC.test(m[2])) continue;
      const key = resolveRelative(path, m[2]);
      info.mods.add(key);
      const clause = m[1];
      const braces = /\{([^}]*)\}/.exec(clause);
      if (braces) {
        for (const part of braces[1].split(',')) {
          const local = part.trim().split(/\s+as\s+|\s*:\s*/).pop().trim();
          if (local) bindMod(local, key);
        }
      }
      const rest = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+/, '').split(',').map(s => s.trim()).filter(s => /^[A-Za-z_$][\w$]*$/.test(s));
      for (const local of rest) bindMod(local, key);
    } else if (lang === 'py') {
      const fi = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/.exec(t);
      if (fi) {
        const base = fi[1].replace(/^\.+/, '').replace(/\./g, '/');
        for (const part of fi[2].replace(/[()]/g, '').split(',')) {
          const [name, alias] = part.trim().split(/\s+as\s+/);
          if (!name) continue;
          info.names.set((alias ?? name).trim(), [base, `${base}/${name.trim()}`]);
          info.mods.add(base);
        }
        continue;
      }
      const im = /^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(t);
      if (im) {
        const base = im[1].replace(/\./g, '/');
        info.names.set(im[2] ?? im[1].split('.').pop(), [base]);
        info.mods.add(base);
      }
    }
  }
  testCache.set(f, info);
  return info;
}

// A module path from an import. "from cart import" is cart.py at the root or under src/ or lib/,
// never any cart.py in the repo: a namesake under scripts/legacy is another module.
export const pyModMatch = (mod, keys) => keys.some(k => mod === k || mod === `src/${k}` || mod === `lib/${k}` || (k.includes('/') && mod.endsWith('/' + k)));

// The first one or two segments of a package say whose code it is: demo.cart and demo.util are
// one project, pixel.dizzymii.x and net.minecraft.y are not.
const pkgRoot = (p) => { const s = String(p).split('.'); return s.slice(0, /^(com|org|net|io|dev|me|edu|gov|co|uk|de|fr|nl|ru|jp)$/.test(s[0]) ? 2 : 1).join('.'); };
const sameProject = (pkg, own) => pkg != null && own != null && pkgRoot(pkg) === pkgRoot(own);
// java.lang needs no import, so a bare String or Math in a file is never the project's.
const JAVA_LANG = new Set(['String', 'Math', 'StrictMath', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Character', 'Byte', 'Short', 'Object', 'System', 'Thread', 'StringBuilder', 'Class', 'Enum', 'Number', 'Runtime', 'Iterable', 'CharSequence', 'Void', 'Record', 'Comparable', 'Exception', 'RuntimeException', 'Error', 'IllegalArgumentException', 'IllegalStateException', 'Override']);

// Which declarations a ref on a test line can mean. Null when the test does not say, and then
// nothing can excuse that ref. `project` says the ref points into the project's own code, so even
// when the diff does not declare it, it names code that is still there.
function whereFor(t, ref) {
  const recv = ref.recv;
  if (OVERLOADS.has(t.lang)) {
    // An import above the hunk is out of view, so a type the diff declares in another package still
    // counts as what the ref may mean (loose). A type the diff never declares is a library's, unless
    // the test imports it from its own project, or the whole file is in view and it has no import.
    // Outer.Inner is a nested type: a member declared where the hunk does not show Inner's header
    // was given the file's own name, so the outer name matches it too.
    const typed = (type) => {
      const parts = type.split('.');
      const outer = parts[0];
      const inner = parts[parts.length - 1];
      const imported = ref.pkg && outer === (ref.kind === 'type' ? ref.name : ref.recv?.split('.')[0]) ? new Set([ref.pkg]) : t.types.get(outer);
      const pkgs = imported ?? new Set([t.pkg, ...t.wild]);
      const ownerOk = (d) => d.owner === inner || (parts.length > 1 && d.ownerGuessed && d.owner === outer);
      const where = (d) => ownerOk(d) && pkgs.has(d.rec.pkg);
      where.loose = ownerOk;
      where.type = outer;
      where.inPkg = (pkg) => pkgs.has(pkg);
      where.project = imported ? [...imported].some(p => sameProject(p, t.pkg))
        : t.whole && !JAVA_LANG.has(outer) && [...t.wild].every(p => sameProject(p, t.pkg));
      return where;
    };
    if (ref.kind === 'type') return typed(ref.name);
    if (recv && /^[A-Z]/.test(recv)) return typed(recv);
    if (recv && t.locals.has(recv)) return typed(t.locals.get(recv));
    if (!recv && t.statics.has(ref.name)) {
      const s = t.statics.get(ref.name);
      const where = (d) => d.owner === s.owner && d.rec.pkg === s.pkg;
      where.project = sameProject(s.pkg, t.pkg);
      return where;
    }
    return (d) => d.rec.pkg === t.pkg || t.wild.has(d.rec.pkg) || (t.types.get(d.owner)?.has(d.rec.pkg) ?? false);
  }
  if (t.lang === 'js') {
    // Relative imports are the project's own code.
    const key = t.names.get(recv ?? ref.name);
    if (key) return Object.assign((d) => d.rec.mod === key, { project: true });
    if (recv && /^[a-z_$]/.test(recv) && t.mods.size) return (d) => t.mods.has(d.rec.mod);
    return mirrored(t, recv);
  }
  if (t.lang === 'py') {
    // A module under a top-level directory the diff touches is the project's own.
    const keys = t.names.get(recv ?? ref.name);
    if (keys) return Object.assign((d) => pyModMatch(d.rec.mod, keys), { project: (idx) => keys.some(k => idx.roots.has(k.split('/')[0])) });
    if (recv && /^[a-z_]/.test(recv) && t.mods.size) return (d) => pyModMatch(d.rec.mod, [...t.mods]);
    return mirrored(t, recv);
  }
  if (t.lang === 'go' || t.lang === 'rust') {
    const dir = dirOf(t.path);
    return (d) => dirOf(d.rec.path) === dir || dirOf(d.rec.path) === dir.replace(/(^|\/)tests$/, '$1src');
  }
  return null;
}

const STRING = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g;
const RESOURCE_ID = /^[a-z0-9_.-]+[:/.][a-z0-9_./-]+$/;
const IMPORT_LINE = /^\s*(?:(?:import|using|package)\b|from\s+\S+\s+import\b|(?:const|let|var)\s+.*=\s*require\s*\()/;
const KEYWORDS = new Set([...NOT_A_NAME, 'true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil', 'and', 'or', 'not', 'in', 'is', 'instanceof', 'var', 'let', 'const', 'val', 'final', 'void', 'int', 'long', 'float', 'double', 'boolean', 'String', 'char', 'byte', 'short', 'assert']);

// The refs on one removed test line: calls (with arity), Recv.FIELD and bare names, new Name(...),
// and string literals that look like resource ids. Comments and import lines give none.
// The failure message taken off a check before its refs are read: what a message mentions
// ("missing: " + dir.toAbsolutePath()) is printed, never checked. Wider than dropMessage, which
// must only drop plain literals: here a message is any extra argument that starts with a string.
function withoutMessage(text, t) {
  const py = /^(\s*assert\s+)(.*)$/.exec(text);
  if (py && t.lang === 'py') {
    const parts = splitTop(py[2]);
    return parts.length > 1 && /^\s*f?["']/.test(parts[parts.length - 1]) ? py[1] + parts.slice(0, -1).join(',') : text;
  }
  const m = /(?<![\w$])(?:([\w$]+)\.)?(assert\w+)\s*\(/.exec(text);
  if (!m) return text;
  const open = m.index + m[0].length - 1;
  const close = closeOf(text, open);
  if (close < 0) return text;
  const parts = splitTop(text.slice(open + 1, close));
  if (parts.length <= (ONE_ARG.test(m[2]) ? 1 : 2)) return text;
  const first = t.junit4 && (!m[1] || m[1] === 'Assert');
  const at = first ? 0 : parts.length - 1;
  if (!/^\s*["'`]/.test(parts[at])) return text;
  // Blanked, not dropped, so the check keeps its arity.
  return text.slice(0, open + 1) + parts.map((s, k) => (k === at ? ' ""' : s)).join(',') + text.slice(close);
}

export function refsOf(text, f) {
  if (isCommentLine(text) || IMPORT_LINE.test(text)) return [];
  const t = testContext(f);
  text = withoutMessage(text, t);
  const refs = rawRefs(text, t);
  // A check on a local set from a call is a check on that call: "var product = Radar.match(x)" then
  // "assertTrue(product.isEmpty())" is about Radar.match, and so is a call to a local helper
  // "const d = (t) => detect(t)". What is called on the local itself is about the value, which the
  // diff does not declare.
  const code = text.replace(STRING, (s) => s[0] + s[0]);
  for (const name of new Set(code.match(/(?<![\w$.])[A-Za-z_$][\w$]*/g) ?? [])) {
    if (t.inits.has(name)) refs.push(...rawRefs(t.inits.get(name), t));
  }
  // A local the test also gives a type (Plan dull = Plan.lay(3)) points at that type instead. What
  // is read off a value (such a local, or the result of a call: f(x).size()) only counts when it is
  // gone; that it still exists says nothing about the code the check is about.
  const local = (r) => (r.recv ? t.inits.has(r.recv) && !t.locals.has(r.recv) : r.kind === 'call' && t.inits.has(r.name));
  const value = (r) => (r.recv ? t.inits.has(r.recv) : false) || (r.kind === 'call' && r.recv === '');
  return refs
    .filter(r => !t.own.has(r.recv ? r.recv.split('.')[0] : r.name))
    .map(r => ({ ...r, value: value(r), where: r.kind === 'resource' ? null : local(r) ? NOWHERE : whereFor(t, r) }));
}

const NOWHERE = Object.assign(() => false, { loose: () => false });

function rawRefs(text, t) {
  const refs = [];
  for (const s of text.match(STRING) ?? []) {
    const body = s.slice(1, -1);
    // A bare path ("feather_rise_horizon" in fromNamespaceAndPath(MODID, ...)) only counts if a
    // deleted resource has that name, so ordinary words cost nothing.
    if (RESOURCE_ID.test(body) || /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(body)) refs.push({ kind: 'resource', name: body, recv: null, arity: null });
  }
  let code = text.replace(STRING, (s) => s[0] + s[0]);
  // A fully qualified name (a.b.Type.call()) is the type with its package spelled out.
  const fq = new Map();
  if (OVERLOADS.has(t.lang)) {
    code = code.replace(/(?<![\w$.])((?:[a-z_][\w$]*\s*\.\s*){2,})([A-Z][\w$]*)/g, (m, pkg, type) => { fq.set(type, pkg.replace(/\s+/g, '').replace(/\.$/, '')); return type; });
  }
  const argsAt = (open) => { const close = closeOf(code, open); return close < 0 ? null : countArgs(code.slice(open + 1, close)); };
  const taken = new Set();
  // A receiver keeps the outer names of a nested type: Cues.Context.held(...) is called on Cues.Context.
  const chain = (s) => (s ?? '').replace(/\s+/g, '');
  for (const m of code.matchAll(/(?:((?:[A-Z][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*)\s*)?\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const at = m.index + m[0].length - 1;
    taken.add(at);
    refs.push({ kind: 'call', name: m[2], recv: chain(m[1]), arity: argsAt(at) });
  }
  for (const m of code.matchAll(/(?<![\w$.])(new\s+)?([A-Za-z_$][\w$]*)\s*\(/g)) {
    const at = m.index + m[0].length - 1;
    if (taken.has(at) || KEYWORDS.has(m[2])) continue;
    refs.push(m[1] ? { kind: 'type', name: m[2], recv: null, arity: null } : { kind: 'call', name: m[2], recv: null, arity: argsAt(at) });
  }
  for (const m of code.matchAll(/(?<![\w$.])((?:[A-Z][\w$]*\s*\.\s*)*[A-Z][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\b(?!\s*[(.\w$])/g)) {
    refs.push({ kind: 'field', name: m[2], recv: chain(m[1]), arity: null });
  }
  // A field read on a local whose type the test declares: dull.guides on an OilPlay.Plan dull.
  for (const m of code.matchAll(/(?<![\w$.])([a-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\b(?!\s*[(.\w$])/g)) {
    if (t.locals?.has(m[1])) refs.push({ kind: 'field', name: m[2], recv: m[1], arity: null });
  }
  // Bare names only count as constants or as names the test imports. The rest are its own locals.
  for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\b(?!\s*[(.\w$])(?!\s*:(?!:))/g)) {
    if (KEYWORDS.has(m[1]) || !(/^[A-Z][A-Z0-9_]+$/.test(m[1]) || t.names.has(m[1]) || t.statics.has(m[1]))) continue;
    refs.push({ kind: 'field', name: m[1], recv: null, arity: null });
  }
  if (fq.size) {
    for (const r of refs) {
      const type = r.kind === 'type' ? r.name : r.recv?.split('.')[0];
      if (type && fq.has(type)) r.pkg = fq.get(type);
    }
  }
  return refs;
}

// What the change did to the code a ref names: 'gone', 'renamed', 'arity' or 'kept', with the file
// for the message. Null when the diff does not declare the name, so the ref says nothing.
export function refStatus(idx, ref) {
  const out = statusOf(idx, ref);
  return ref.value && out?.status === 'kept' ? null : out;
}

function statusOf(idx, ref) {
  if (ref.kind === 'resource') {
    const file = idx.resourceGone(ref.name);
    return file ? { status: 'gone', file } : null;
  }
  // A type, or a member of a type, whose whole file this change deletes.
  const owner = ref.kind === 'type' ? ref.name : ref.where?.type;
  if (owner) {
    const src = idx.deletedSources.find(s => s.reallyGone && s.primary.has(owner)
      && (ref.where.inPkg ? ref.where.inPkg(s.rec.pkg) : ref.where({ owner, rec: s.rec })));
    if (src) return { status: 'gone', file: src.path };
  }
  // Code the project still has keeps the line a lost check, even when this diff never shows it.
  // The assertion call itself (helper.assertTrue, Assert.assertEquals) is the check, not its subject.
  const check = ref.kind === 'call' && /^(?:assert|expect$|fail$|verify$)/.test(ref.name);
  const project = !check && (typeof ref.where?.project === 'function' ? ref.where.project(idx) : ref.where?.project === true);
  const KEPT = { status: 'kept', file: null };
  if (!idx.declared(ref.name)) return project ? KEPT : null;
  if (!ref.where) return KEPT;
  // Declared in the diff, but not where this ref points. When the ref names its owner type and the
  // diff has no such type, it is a library name that happens to match (Items.DIAMOND). Otherwise
  // the diff may just not show the import, so the name still keeps the line from being excused.
  if (!idx.declaredIn(ref.name, ref.where)) {
    return !project && ref.where.loose && !idx.declaredIn(ref.name, ref.where.loose) ? null : KEPT;
  }
  if (ref.kind === 'type') {
    return idx.gone(ref.name, ref.where) ? { status: 'gone', file: idx.goneFrom(ref.name, ref.where) } : { status: 'kept', file: null };
  }
  if (idx.renamed(ref.name, ref.where)) return { status: 'renamed', file: idx.goneFrom(ref.name, ref.where), to: idx.renamed(ref.name, ref.where) };
  const reshaped = idx.arityChanged(ref.name, ref.where);
  // shrunk: every signature left takes fewer arguments than this call passes, so a parameter the
  // check exercised is gone and the call cannot be written the old way.
  if (reshaped) return { status: 'arity', file: idx.goneFrom(ref.name, ref.where), shrunk: ref.arity != null && [...reshaped.to].every(a => a < ref.arity) };
  if (idx.gone(ref.name, ref.where, ref.arity)) return { status: 'gone', file: idx.goneFrom(ref.name, ref.where) };
  return { status: 'kept', file: idx.declaredIn(ref.name, ref.where) };
}

// The refs on a line that the diff knows about, each with its status.
export function subjectRefs(ctx, f, text) {
  const idx = sourceIndex(ctx);
  const out = [];
  for (const r of refsOf(text, f)) {
    const s = refStatus(idx, r);
    if (s) out.push({ ...r, ...s });
  }
  return out;
}


// Lines removed together with the code they exercise: at least one ref is gone, and every other
// ref the diff knows is gone too, or sits in code this change edits (a constant dropped from a
// function that changed). One ref left untouched is enough to keep the lines a lost check.
// Returns the first gone ref, for the message, or null.
// With `shrunk`, a call to a signature that lost a parameter counts like a gone ref, and the
// result says `reshaped` when one did.
export function removedWithFeature(ctx, f, texts, { shrunk = false } = {}) {
  const idx = sourceIndex(ctx);
  const refs = texts.flatMap(t => subjectRefs(ctx, f, t));
  const out = (r) => r.status === 'gone' || (shrunk && r.status === 'arity' && r.shrunk);
  const gone = refs.filter(out);
  if (!gone.length) return null;
  const edited = (r) => r.status === 'kept' && r.kind !== 'type' && r.where != null && idx.touched(r.name, r.where);
  return refs.every(r => out(r) || edited(r)) ? { symbol: gone[0].name, file: gone[0].file, reshaped: gone.some(r => r.status === 'arity') } : null;
}
