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

const countArgs = (s) => (s.trim() ? splitTop(s).length : 0);
// Generic parameters hold commas of their own: Map<String, Integer> m is one parameter.
const stripGenerics = (s) => { let t = s; let prev; do { prev = t; t = t.replace(/<[^<>]*>/g, ''); } while (t !== prev); return t; };

// A deleted or moved test line can be matched against an added one with other names for things.
const IDENT = /(?<![.\w$])[A-Za-z_$][\w$]*\b(?!\s*\()/g;
export const normalised = (t) => t.trim().replace(IDENT, 'I').replace(/\s+/g, ' ');

// An assertion's failure message dropped. assertTrue and friends (and a GameTest helper.assertX)
// take it last, so a trailing string literal goes. JUnit 5 assertEquals takes it third, JUnit 4
// first, so it only goes with a jupiter import, and only when it is a string: a third number is a delta.
const MESSAGE_LAST = /^(assertTrue|assertFalse|assertNull|assertNotNull)$/;
export function dropMessage(t, { jupiter = false } = {}) {
  const m = /(?<![\w$])((?:[\w$]+\.)?(assert\w+))\s*\(/.exec(t);
  if (!m) return t;
  const open = m.index + m[0].length - 1;
  const close = closeOf(t, open);
  if (close < 0) return t;
  const parts = splitTop(t.slice(open + 1, close));
  const helper = m[1].includes('.');
  const last = (parts[parts.length - 1] ?? '').trim();
  const isString = /^["'`]/.test(last);
  const drop = (MESSAGE_LAST.test(m[2]) || helper) ? parts.length >= 2 && isString
    : /^assert(Not)?Equals$/.test(m[2]) ? jupiter && parts.length === 3 && isString
      : false;
  if (!drop) return t;
  return t.slice(0, open + 1) + parts.slice(0, -1).join(',') + t.slice(close);
}

export const moveKey = (t, opts) => normalised(dropMessage(t, opts));

// ---- declarations ---------------------------------------------------------------------------

const OVERLOADS = new Set(['jvm', 'cs']);
const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'return', 'new', 'catch', 'else', 'do', 'try', 'synchronized', 'function', 'throw', 'typeof', 'await', 'yield', 'super', 'this']);
const JVM_TYPE = /(?<![.\w$])(?:class|interface|enum|record|object)\s+([A-Za-z_$][\w$]*)/;
// Modifiers, generics and the return type all fall in the first group.
const JVM_METHOD = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*([\w$.<>\[\],? ]+?)\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?:throws\s[^{]*)?\{?\s*$/;
// Cheap test first: the full pattern backtracks on long lines that cannot be a method header.
const JVM_METHOD_TAIL = /\)\s*(?:throws\s[^{]*)?\{?\s*$/;
const KOTLIN_FUN = /\bfun\s+(?:<[^>]+>\s*)?(?:[\w$]+\.)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/;
const JVM_FIELD = /\b(?:final|const|readonly)\s+[\w$<>\[\],.? ]+?\s+([A-Za-z_$][\w$]*)\s*=/;
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
  for (const f of ctx.files) {
    const isSrc = (p) => p != null && isSourcePath(p, extra);
    if (!isSrc(f.oldPath) && !isSrc(f.newPath)) continue;
    const path = norm(f.newPath ?? f.oldPath);
    const lang = language(path);
    const rec = { f, path, lang, mod: modKey(path), pkg: OVERLOADS.has(lang) ? packageOf(f, path) : null };
    records.push(rec);
    let owner = stemOfPath(path);
    f.hunks.forEach((h, hunk) => {
      for (const l of h.lines) {
        for (const d of declarationsOn(l.text, lang)) {
          if (d.kind === 'type' && OVERLOADS.has(lang)) owner = d.name;
          const decl = { ...d, side: l.kind, hunk, rec, top: !/^\s/.test(l.text), owner: OVERLOADS.has(lang) ? (d.kind === 'type' ? d.name : owner) : rec.mod };
          decls.push(decl);
          if (!byName.has(decl.name)) byName.set(decl.name, []);
          byName.get(decl.name).push(decl);
        }
      }
    });
  }
  const named = (name) => byName.get(name) ?? [];
  const fitsArity = (d, arity) => arity == null || d.arity == null || !OVERLOADS.has(d.rec.lang) || d.arity === arity;
  const plusNames = new Set(decls.filter(d => d.side === '+').map(d => d.name));
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
        const inHunk = decls.filter(x => x.rec === d.rec && x.hunk === d.hunk);
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
      return named(name).some(d => {
        if (!where(d)) return false;
        const lines = d.rec.f.hunks[d.hunk]?.lines ?? [];
        const side = (k) => new Set(lines.filter(l => l.kind === k).map(l => l.text.trim()));
        const minus = side('-');
        const plus = side('+');
        return lines.some(l => {
          const t = l.text.trim();
          if (l.kind === ' ' || !t || isCommentLine(t)) return false;
          return !(l.kind === '-' ? plus : minus).has(t);
        });
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

const testCache = new WeakMap();

// Imports and package of a test file, from its removed and context lines.
export function testContext(f) {
  if (testCache.has(f)) return testCache.get(f);
  const path = norm(f.oldPath ?? f.newPath);
  const lang = language(path);
  const lines = f.hunks.flatMap(h => h.lines.filter(l => l.kind !== '+').map(l => l.text));
  const info = { path, lang, pkg: OVERLOADS.has(lang) ? packageOf(f, path) : null, types: new Map(), wild: new Set(), statics: new Map(), names: new Map(), mods: new Set(), locals: new Map(), inits: new Map(), jupiter: false };
  for (const t of f.hunks.flatMap(h => h.lines.map(l => l.text))) if (/\borg\.junit\.jupiter\b/.test(t)) info.jupiter = true;
  const bindMod = (local, key) => { info.names.set(local, key); info.mods.add(key); };
  for (const t of lines) {
    if (OVERLOADS.has(lang)) {
      // Locals with a declared type, so product.isEmpty() on an ItemStack is not read as any isEmpty.
      for (const m of t.matchAll(/\b([A-Z][\w$]*)(?:<[^>]*>)?(?:\[\])?\s+([a-z_$][\w$]*)\s*(?=[=;,)])/g)) info.locals.set(m[2], m[1]);
      for (const m of t.matchAll(/\bvar\s+([a-z_$][\w$]*)\s*=\s*new\s+([A-Z][\w$]*)/g)) info.locals.set(m[1], m[2]);
      const init = /^\s*(?:final\s+)?([A-Za-z_$][\w$<>,.\[\] ]*?)\s+([a-z_$][\w$]*)\s*=\s*(?!new\s)(.*\(.*)$/.exec(t);
      if (init && !NOT_A_NAME.has(init[1].trim())) info.inits.set(init[2], init[3]);
      const st =/^\s*import\s+static\s+([\w.]+)\.([A-Za-z_$][\w$]*)\.([\w$*]+)\s*;?/.exec(t);
      if (st) { info.statics.set(st[3], { pkg: st[1], owner: st[2] }); continue; }
      const im = /^\s*(?:import|using)\s+([\w.]+)\.([A-Za-z_$][\w$]*|\*)\s*;?\s*$/.exec(t);
      if (im) {
        if (im[2] === '*') info.wild.add(im[1]);
        else { if (!info.types.has(im[2])) info.types.set(im[2], new Set()); info.types.get(im[2]).add(im[1]); }
      }
    } else if (lang === 'js') {
      const init = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?!require\s*\()(?!new\s)(.*\(.*)$/.exec(t);
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

const pyModMatch = (mod, keys) => keys.some(k => mod === k || mod.endsWith('/' + k));

// Which declarations a ref on a test line can mean. Null when the test does not say, and then
// nothing can excuse that ref.
function whereFor(t, ref) {
  const recv = ref.recv;
  if (OVERLOADS.has(t.lang)) {
    // An import above the hunk is out of view, so a type the diff declares in another package still
    // counts as what the ref may mean (loose). A type the diff never declares is a library's.
    const typed = (type) => {
      const pkgs = t.types.get(type) ?? new Set([t.pkg, ...t.wild]);
      const where = (d) => d.owner === type && pkgs.has(d.rec.pkg);
      where.loose = (d) => d.owner === type;
      return where;
    };
    if (ref.kind === 'type') return typed(ref.name);
    if (recv && /^[A-Z]/.test(recv)) return typed(recv);
    if (recv && t.locals.has(recv)) return typed(t.locals.get(recv));
    if (!recv && t.statics.has(ref.name)) {
      const s = t.statics.get(ref.name);
      return (d) => d.owner === s.owner && d.rec.pkg === s.pkg;
    }
    return (d) => d.rec.pkg === t.pkg || t.wild.has(d.rec.pkg) || (t.types.get(d.owner)?.has(d.rec.pkg) ?? false);
  }
  if (t.lang === 'js') {
    const key = t.names.get(recv ?? ref.name);
    if (key) return (d) => d.rec.mod === key;
    if (recv && /^[a-z_$]/.test(recv) && t.mods.size) return (d) => t.mods.has(d.rec.mod);
    return null;
  }
  if (t.lang === 'py') {
    const keys = t.names.get(recv ?? ref.name);
    if (keys) return (d) => pyModMatch(d.rec.mod, keys);
    if (recv && /^[a-z_]/.test(recv) && t.mods.size) return (d) => pyModMatch(d.rec.mod, [...t.mods]);
    return null;
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
export function refsOf(text, f) {
  if (isCommentLine(text) || IMPORT_LINE.test(text)) return [];
  const t = testContext(f);
  const refs = rawRefs(text, t);
  // A check on a local set from a call is a check on that call: "var product = Radar.match(x)" then
  // "assertTrue(product.isEmpty())" is about Radar.match, and so is a call to a local helper
  // "const d = (t) => detect(t)". What is called on the local itself is about the value, which the
  // diff does not declare.
  const code = text.replace(STRING, (s) => s[0] + s[0]);
  for (const name of new Set(code.match(/(?<![\w$.])[A-Za-z_$][\w$]*/g) ?? [])) {
    if (t.inits.has(name)) refs.push(...rawRefs(t.inits.get(name), t));
  }
  const local = (r) => (r.recv ? t.inits.has(r.recv) : r.kind === 'call' && t.inits.has(r.name));
  return refs.map(r => ({ ...r, where: r.kind === 'resource' ? null : local(r) ? NOWHERE : whereFor(t, r) }));
}

const NOWHERE = Object.assign(() => false, { loose: () => false });

function rawRefs(text, t) {
  const refs = [];
  for (const s of text.match(STRING) ?? []) {
    const body = s.slice(1, -1);
    if (RESOURCE_ID.test(body)) refs.push({ kind: 'resource', name: body, recv: null, arity: null });
  }
  const code = text.replace(STRING, (s) => s[0] + s[0]);
  const argsAt = (open) => { const close = closeOf(code, open); return close < 0 ? null : countArgs(code.slice(open + 1, close)); };
  const taken = new Set();
  for (const m of code.matchAll(/(?:([A-Za-z_$][\w$]*)\s*)?\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const at = m.index + m[0].length - 1;
    taken.add(at);
    refs.push({ kind: 'call', name: m[2], recv: m[1] ?? '', arity: argsAt(at) });
  }
  for (const m of code.matchAll(/(?<![\w$.])(new\s+)?([A-Za-z_$][\w$]*)\s*\(/g)) {
    const at = m.index + m[0].length - 1;
    if (taken.has(at) || KEYWORDS.has(m[2])) continue;
    refs.push(m[1] ? { kind: 'type', name: m[2], recv: null, arity: null } : { kind: 'call', name: m[2], recv: null, arity: argsAt(at) });
  }
  for (const m of code.matchAll(/(?<![\w$.])([A-Z][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\b(?!\s*[(.\w$])/g)) {
    refs.push({ kind: 'field', name: m[2], recv: m[1], arity: null });
  }
  // Bare names only count as constants or as names the test imports. The rest are its own locals.
  for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\b(?!\s*[(.\w$])(?!\s*:(?!:))/g)) {
    if (KEYWORDS.has(m[1]) || !(/^[A-Z][A-Z0-9_]+$/.test(m[1]) || t.names.has(m[1]) || t.statics.has(m[1]))) continue;
    refs.push({ kind: 'field', name: m[1], recv: null, arity: null });
  }
  return refs;
}

// What the change did to the code a ref names: 'gone', 'renamed', 'arity' or 'kept', with the file
// for the message. Null when the diff does not declare the name, so the ref says nothing.
export function refStatus(idx, ref) {
  if (ref.kind === 'resource') {
    const file = idx.resourceGone(ref.name);
    return file ? { status: 'gone', file } : null;
  }
  if (!idx.declared(ref.name)) return null;
  if (!ref.where) return { status: 'kept', file: null };
  if (ref.kind === 'type') {
    const src = idx.deletedSources.find(s => s.reallyGone && s.primary.has(ref.name) && ref.where({ owner: ref.name, rec: s.rec }));
    if (src) return { status: 'gone', file: src.path };
  }
  // Declared in the diff, but not where this ref points. When the ref names its owner type and the
  // diff has no such type, it is a library name that happens to match (Items.DIAMOND). Otherwise
  // the diff may just not show the import, so the name still keeps the line from being excused.
  if (!idx.declaredIn(ref.name, ref.where)) {
    return ref.where.loose && !idx.declaredIn(ref.name, ref.where.loose) ? null : { status: 'kept', file: null };
  }
  if (ref.kind === 'type') {
    return idx.gone(ref.name, ref.where) ? { status: 'gone', file: idx.goneFrom(ref.name, ref.where) } : { status: 'kept', file: null };
  }
  if (idx.renamed(ref.name, ref.where)) return { status: 'renamed', file: idx.goneFrom(ref.name, ref.where), to: idx.renamed(ref.name, ref.where) };
  if (idx.arityChanged(ref.name, ref.where)) return { status: 'arity', file: idx.goneFrom(ref.name, ref.where) };
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
export function removedWithFeature(ctx, f, texts) {
  const idx = sourceIndex(ctx);
  const refs = texts.flatMap(t => subjectRefs(ctx, f, t));
  const gone = refs.filter(r => r.status === 'gone');
  if (!gone.length) return null;
  const edited = (r) => r.status === 'kept' && r.kind !== 'type' && r.where != null && idx.touched(r.name, r.where);
  return refs.every(r => r.status === 'gone' || edited(r)) ? { symbol: gone[0].name, file: gone[0].file } : null;
}
