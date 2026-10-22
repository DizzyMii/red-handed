// What the production side of a diff declares, so the rules can ask whether a change deleted or
// reshaped the code a removed test line called. Everything here reads the parsed diff only.

import { isSourcePath, isTestPath, isCommentLine, language } from './classify.mjs';

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
    // An enum on one line: "enum Slot { HEAD, CHEST }" declares its constants, owned by the enum.
    const oneLine = t && /\benum\s+[\w$]+[^{]*\{([^{}]*)\}/.exec(text);
    if (oneLine) {
      for (const c of oneLine[1].split(';')[0].split(',')) {
        const name = /^\s*([A-Z][A-Z0-9_]*)\b/.exec(c)?.[1];
        if (name) out.push({ name, kind: 'field', arity: null, in: t[1] });
      }
    }
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
  return pathPackage(path);
}

function pathPackage(path) {
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

// ---- whole files from a tree ------------------------------------------------------------------

// A file's lines with every comment and string literal blanked to spaces. The quotes stay, so
// columns and "" survive. A // or /* inside a string is string, a quote inside a comment is comment.
// Languages it cannot read come back as they are.
export function codeOnly(text, lang) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  if (lang !== 'jvm' && lang !== 'cs' && lang !== 'js' && lang !== 'py') return lines;
  const out = [];
  // Open across lines: a block comment, a text block, a python triple quote or a js template.
  let open = null;
  for (const line of lines) {
    let s = '';
    let k = 0;
    while (k < line.length) {
      const ch = line[k];
      if (open === '*/') {
        if (line.startsWith('*/', k)) { s += '  '; k += 2; open = null; } else { s += ' '; k++; }
        continue;
      }
      if (open) {
        if (line.startsWith(open, k)) { s += open; k += open.length; open = null; } else if (ch === '\\') { s += k + 1 < line.length ? '  ' : ' '; k += 2; } else { s += ' '; k++; }
        continue;
      }
      if (lang === 'py' ? ch === '#' : line.startsWith('//', k)) { s += ' '.repeat(line.length - k); break; }
      if (lang !== 'py' && line.startsWith('/*', k)) { s += '  '; k += 2; open = '*/'; continue; }
      const triple = line.slice(k, k + 3);
      if ((lang === 'jvm' && triple === '"""') || (lang === 'py' && (triple === '"""' || triple === "'''"))) { s += triple; k += 3; open = triple; continue; }
      if (lang === 'js' && ch === '`') { s += ch; k++; open = '`'; continue; }
      if (ch === '"' || ch === "'") {
        s += ch;
        k++;
        while (k < line.length && line[k] !== ch) {
          if (line[k] === '\\') { s += k + 1 < line.length ? '  ' : ' '; k += 2; } else { s += ' '; k++; }
        }
        if (k < line.length) { s += ch; k++; }
        continue;
      }
      s += ch;
      k++;
    }
    out.push(s);
  }
  return out;
}

const JVM_RESOURCES_PATH = /(^|\/)src\/[^/]+\/resources\//;
const RECORD = /\brecord\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/;
const DATA_CLASS = /\bdata\s+class\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/;
const parenDepth = (s) => (s.match(/\(/g) ?? []).length - (s.match(/\)/g) ?? []).length;

// What one whole file declares: { path, lang, pkg, decls: [{ name, kind, arity, owner, top, line }],
// records: Map<type, { components, methods, explicitCtor }> }. Read over codeOnly, so a
// declaration in a comment or a string is not one. In jvm and cs the owner is the type whose body
// holds the line, by brace depth, and only code directly in a type body (or the file) declares
// anything: a local inside a method is not a member. A test file or anything under resources is
// never compiled as production code, so it declares nothing.
export function indexText(path, text) {
  const p = norm(path);
  const lang = language(p);
  const file = { path: p, lang, pkg: null, decls: [], records: new Map() };
  const lines = codeOnly(text, lang);
  const stem = stemOfPath(p);
  if (OVERLOADS.has(lang)) {
    const m = lines.map(l => /^\s*(?:package|namespace)\s+([\w.]+)/.exec(l)).find(Boolean);
    file.pkg = m ? m[1] : pathPackage(p);
  }
  if (isTestPath(p) || JVM_RESOURCES_PATH.test(p)) return file;
  if (!OVERLOADS.has(lang)) {
    const mod = modKey(p);
    lines.forEach((l, i) => {
      for (const d of declarationsOn(l, lang)) file.decls.push({ name: d.name, kind: d.kind, arity: d.arity, owner: mod, top: /^\S/.test(l), line: i + 1 });
    });
    return file;
  }
  // Brace depth, and the types open at each depth: { name, depth, enumHead }. A type declared on a
  // piece opens at the next brace.
  let depth = 0;
  const types = [];
  let pending = null;
  const take = (piece, line) => {
    const inner = types[types.length - 1];
    if (inner ? depth === inner.depth : depth === 0) {
      const owner = inner?.name ?? stem;
      if (inner?.enumHead) {
        // An enum's constants come first, up to its first semicolon.
        for (const m of piece.matchAll(/(?:^|,)\s*([A-Z][A-Z0-9_]*)\b/g)) file.decls.push({ name: m[1], kind: 'field', arity: null, owner, top: false, line });
        if (/[;({]/.test(piece)) inner.enumHead = false;
      } else {
        const rec = inner && file.records.get(inner.name);
        for (const d of declarationsOn(piece, lang)) {
          file.decls.push({ name: d.name, kind: d.kind, arity: d.arity, owner: d.kind === 'type' ? d.name : d.in ?? owner, top: !inner, line });
          if (d.kind === 'type') pending = { name: d.name, enumHead: /\benum\s/.test(piece) };
          if (rec && d.kind === 'fn') { rec.methods.add(d.name); if (d.name === inner.name) rec.explicitCtor = true; }
        }
        const r = RECORD.exec(piece) ?? DATA_CLASS.exec(piece);
        if (r) {
          const kotlin = !RECORD.test(piece);
          const names = splitTop(r[2]).map(s => s.replace(/@[\w$.]+(?:\([^)]*\))?\s*/g, '').trim()).filter(Boolean)
            .map(s => (kotlin ? /\b(?:val|var)\s+([A-Za-z_$][\w$]*)/.exec(s)?.[1] : /([A-Za-z_$][\w$]*)\s*$/.exec(stripGenerics(s))?.[1])).filter(Boolean);
          file.records.set(r[1], { components: new Set(names), methods: new Set(), explicitCtor: false });
        }
        // A compact constructor: "Name {" or "public Name {" in the record's own body.
        if (rec && new RegExp(`^\\s*(?:(?:public|private|protected)\\s+)?${inner.name.replace(/\$/g, '\\$')}\\s*\\{`).test(piece)) rec.explicitCtor = true;
      }
    }
    for (const ch of piece) {
      if (ch === '{') {
        depth++;
        if (pending) { types.push({ name: pending.name, depth, enumHead: pending.enumHead }); pending = null; }
      } else if (ch === '}') {
        if (types.length && types[types.length - 1].depth === depth) types.pop();
        depth = Math.max(0, depth - 1);
      } else if (ch === ';' && depth === (types[types.length - 1]?.depth ?? 0)) pending = null;
    }
  };
  // Each piece ends at a ; { or }, so "int a; int b() {" is two. A header whose parameters run on
  // over lines is joined first, up to 8 lines.
  let buf = '';
  let from = 0;
  lines.forEach((l, i) => {
    for (const piece of l.split(/(?<=[;{}])/)) {
      if (!buf) from = i;
      buf += piece;
      if (parenDepth(buf) > 0 && i - from < 8) continue;
      take(buf, from + 1);
      buf = '';
    }
    if (buf) buf += ' ';
  });
  if (buf.trim()) take(buf, from + 1);
  return file;
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
            owner: OVERLOADS.has(lang) ? (d.kind === 'type' ? d.name : d.in ?? owner) : rec.mod,
            ownerGuessed: OVERLOADS.has(lang) && d.kind !== 'type' && !d.in && (!top || top.carried) };
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
    // For the tree lookups: a + declaration of name under owner, the live declarations a ref
    // points at, and whether the change edits code in a file at all.
    addedUnder: (name, owner) => named(name).some(d => d.side === '+' && d.owner === owner),
    liveDecls: (name, where) => named(name).filter(d => d.side !== '-' && where(d)),
    fileEdited: (path) => records.some(r => (r.path === path || norm(r.f.oldPath ?? '') === path) && (r.f.status === 'deleted' || r.f.hunks.some(h => hunkEdits(h)))),
    // The files that declare on + lines what deleted source s declared: its new home, when it
    // moved. With `top`, only its primary names at top level count.
    newHomes(s, { top = false } = {}) {
      const names = top ? s.primary : new Set(decls.filter(d => d.rec === s.rec && d.side === '-' && d.kind !== 'field').map(d => d.name));
      return [...new Set(decls.filter(d => d.side === '+' && d.rec !== s.rec && names.has(d.name) && (!top || d.top)).map(d => d.rec))];
    },
  };
  indexCache.set(ctx, idx);
  return idx;
}

// ---- what a test file points at -------------------------------------------------------------

const RELATIVE_SPEC = /^\.{1,2}\//;
export function resolveRelative(fromPath, spec) {
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
  readTestLines(info, lines);
  // A test's own constants stand for what they are set to, when the whole file is in view.
  info.consts = info.whole ? ownConstants(lines, lang) : new Map();
  testCache.set(f, info);
  return info;
}

// The imports, locals and calls a test file's lines set up, into info.
function readTestLines(info, lines) {
  const { path, lang } = info;
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
      // A nested owner (import static a.b.Outer.Slot.HEAD) sits in package a.b.
      if (st) { info.statics.set(st[3], { pkg: st[1].replace(/(?:\.[A-Z][\w$]*)+$/, ''), owner: st[2] }); continue; }
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
}

// Constants a test file declares at its top level, with the statement that sets each, joined over
// up to 8 lines: static final in jvm, a top-level const in js, a module-level NAME = in python.
function ownConstants(lines, lang) {
  const out = new Map();
  const START = OVERLOADS.has(lang) ? /\bstatic\s+final\s+[\w$<>\[\],.? ]+?\s+([A-Za-z_$][\w$]*)\s*=(.*)$/
    : lang === 'js' ? /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=(.*)$/
      : lang === 'py' ? /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)(.*)$/ : null;
  if (!START) return out;
  const done = (t) => (OVERLOADS.has(lang) ? t.replace(STRING, '""').includes(';') : openDepth(t) <= 0);
  for (let i = 0; i < lines.length; i++) {
    const m = START.exec(lines[i]);
    if (!m) continue;
    let text = m[2].trim();
    for (let j = i + 1; j < lines.length && j - i < 8 && !done(text); j++) text += ' ' + lines[j].trim();
    out.set(m[1], text);
  }
  return out;
}

// The rest of a test file shown in part, read from its base copy: imports above the hunk, its own
// constants and helpers. What the diff shows of a local wins, since two tests can use one name for
// two things. True when the context changed, so the caller reads its refs again. Tried once a file.
export function completeFromBase(ctx, f) {
  const t = testContext(f);
  if (t.whole || t.triedBase || !ctx.trees) return false;
  t.triedBase = true;
  const text = ctx.trees.read('base', norm(f.oldPath ?? f.newPath));
  if (typeof text !== 'string') { t.baseUnknown = text === undefined; return false; }
  // What the diff alone made of the file, for subjectRefs to compare against.
  t.alone = { ...t, types: new Map([...t.types].map(([k, v]) => [k, new Set(v)])), wild: new Set(t.wild), statics: new Map(t.statics),
    names: new Map(t.names), mods: new Set(t.mods), locals: new Map(t.locals), inits: new Map(t.inits), own: new Set(t.own), consts: new Map(t.consts) };
  const lines = text.split('\n');
  const b = { path: t.path, lang: t.lang, types: new Map(), wild: new Set(), statics: new Map(), names: new Map(), mods: new Set(), locals: new Map(), inits: new Map() };
  readTestLines(b, lines);
  const pkg = OVERLOADS.has(t.lang) && lines.map(l => /^\s*(?:package|namespace)\s+([\w.]+)/.exec(l)).find(Boolean);
  if (pkg) t.pkg = pkg[1];
  for (const [k, v] of b.types) { if (!t.types.has(k)) t.types.set(k, new Set()); for (const p of v) t.types.get(k).add(p); }
  for (const w of b.wild) t.wild.add(w);
  for (const m of b.mods) t.mods.add(m);
  for (const key of ['statics', 'names', 'locals', 'inits']) for (const [k, v] of b[key]) if (!t[key].has(k)) t[key].set(k, v);
  if (lines.some(l => /\borg\.junit\.jupiter\b/.test(l))) { t.jupiter = true; t.junit4 = false; }
  else if (!t.jupiter && lines.some(l => /\borg\.junit\.(?:Assert|Test)\b/.test(l))) t.junit4 = true;
  // A field with a type is a value the test holds, so a call on it still names that type's code.
  // Read in pieces, so a one-line helper "static int total(Cart c) { return c.sum(); }" counts.
  for (const l of codeOnly(text, t.lang)) {
    for (const piece of l.split(/(?<=[;{}])/)) for (const d of declarationsOn(piece, t.lang)) if (!b.locals.has(d.name)) t.own.add(d.name);
  }
  t.consts = ownConstants(lines, t.lang);
  t.whole = true;
  return true;
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
      where.inner = inner;
      where.pkgs = [...pkgs];
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
      // The import names the owner outright, so a namesake declared elsewhere in the diff is not it.
      where.loose = () => false;
      Object.assign(where, { type: s.owner, inner: s.owner, pkgs: [s.pkg] });
      return where;
    }
    return (d) => d.rec.pkg === t.pkg || t.wild.has(d.rec.pkg) || (t.types.get(d.owner)?.has(d.rec.pkg) ?? false);
  }
  if (t.lang === 'js') {
    // Relative imports are the project's own code.
    const key = t.names.get(recv ?? ref.name);
    if (key) return Object.assign((d) => d.rec.mod === key, { project: true, keys: [key] });
    if (recv && /^[a-z_$]/.test(recv) && t.mods.size) return (d) => t.mods.has(d.rec.mod);
    return mirrored(t, recv);
  }
  if (t.lang === 'py') {
    // A module under a top-level directory the diff touches is the project's own.
    const keys = t.names.get(recv ?? ref.name);
    if (keys) return Object.assign((d) => pyModMatch(d.rec.mod, keys), { project: (idx) => keys.some(k => idx.roots.has(k.split('/')[0])), keys });
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

export function refsOf(text, f, t = testContext(f)) {
  if (isCommentLine(text) || IMPORT_LINE.test(text)) return [];
  text = withoutMessage(text, t);
  const refs = rawRefs(text, t);
  // A check on a local set from a call is a check on that call: "var product = Radar.match(x)" then
  // "assertTrue(product.isEmpty())" is about Radar.match, and so is a call to a local helper
  // "const d = (t) => detect(t)". What is called on the local itself is about the value, which the
  // diff does not declare.
  const code = text.replace(STRING, (s) => s[0] + s[0]);
  for (const name of new Set(code.match(/(?<![\w$.])[A-Za-z_$][\w$]*/g) ?? [])) {
    if (t.inits.has(name)) refs.push(...rawRefs(t.inits.get(name), t));
    // Only its resource ids: fromNamespaceAndPath(MODID, ...) is plumbing, not the subject.
    if (t.consts?.has(name)) refs.push(...rawRefs(t.consts.get(name), t).filter(r => r.kind === 'resource').map(r => ({ ...r, via: name })));
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
  // new Layer() { ... } is the test's own implementation of Layer: the type it implements is not
  // what a check on it is about, what it calls is.
  const anonymous = (start, open) => /\bnew\s+$/.test(code.slice(0, start)) && /^\s*\{/.test(code.slice(closeOf(code, open) + 1 || code.length));
  for (const m of code.matchAll(/(?:((?:[A-Z][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*)\s*)?\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const at = m.index + m[0].length - 1;
    taken.add(at);
    if (anonymous(m.index, at)) continue;
    refs.push({ kind: 'call', name: m[2], recv: chain(m[1]), arity: argsAt(at) });
  }
  for (const m of code.matchAll(/(?<![\w$.])(new\s+)?([A-Za-z_$][\w$]*)\s*\(/g)) {
    const at = m.index + m[0].length - 1;
    if (taken.has(at) || KEYWORDS.has(m[2]) || (m[1] && anonymous(m.index + m[1].length, at))) continue;
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
// for the message. Null when the diff does not declare the name, so the ref says nothing. A kept
// ref carries its basis: 'unseen' (the diff never declares the name, but the ref points into the
// project), 'loose' (declared, not where the ref points) or 'diff' (declared there and kept).
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
  const kept = (basis) => ({ status: 'kept', file: null, basis });
  if (!idx.declared(ref.name)) return project ? kept('unseen') : null;
  if (!ref.where) return kept(null);
  // Declared in the diff, but not where this ref points. When the ref names its owner type and the
  // diff has no such type, it is a library name that happens to match (Items.DIAMOND). Otherwise
  // the diff may just not show the import, so the name still keeps the line from being excused.
  if (!idx.declaredIn(ref.name, ref.where)) {
    return !project && ref.where.loose && !idx.declaredIn(ref.name, ref.where.loose) ? null : kept('loose');
  }
  if (ref.kind === 'type') {
    return idx.gone(ref.name, ref.where) ? { status: 'gone', file: idx.goneFrom(ref.name, ref.where) } : kept('diff');
  }
  if (idx.renamed(ref.name, ref.where)) return { status: 'renamed', file: idx.goneFrom(ref.name, ref.where), to: idx.renamed(ref.name, ref.where) };
  const reshaped = idx.arityChanged(ref.name, ref.where);
  // shrunk: every signature left takes fewer arguments than this call passes, so a parameter the
  // check exercised is gone and the call cannot be written the old way.
  if (reshaped) return { status: 'arity', file: idx.goneFrom(ref.name, ref.where), shrunk: ref.arity != null && [...reshaped.to].every(a => a < ref.arity) };
  // byArity: an overload of another arity is still there, so only the arity says this one is gone.
  if (idx.gone(ref.name, ref.where, ref.arity)) return { status: 'gone', file: idx.goneFrom(ref.name, ref.where), byArity: !idx.gone(ref.name, ref.where) };
  return { status: 'kept', file: idx.declaredIn(ref.name, ref.where), basis: 'diff' };
}

// ---- code the diff does not show, read from the trees ------------------------------------------
//
// A tree only settles what the diff leaves open, and evidence from a tree may only do what the
// same evidence would do in the diff. Every lookup answers a status, or undefined for "not
// known", which leaves the diff's answer as it was.

export const TREE_SUFFIX = ' The diff does not show this part of the change; the files at its head do.';

// A ref that, as the diff alone reads it, keeps a line from being excused.
const blocks = (s) => s != null && (s.status === 'kept' || s.status === 'arity' || (s.status === 'gone' && s.byArity));

const JVM_EXTS = ['.java', '.kt', '.scala', '.groovy'];
const JS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.js'];
const SOURCE_EXT = /\.(java|kt|scala|groovy|cs|ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/;
const memos = new WeakMap();
const memoOf = (trees) => { if (!memos.has(trees)) memos.set(trees, new Map()); return memos.get(trees); };

// The files in one tree that may declare what ref names: { exact, byStem }. exact ones can say gone
// or kept; byStem ones (a file of the owner's name somewhere else) can only say kept, so an
// unrelated namesake never makes something look gone. Null when the tree cannot say.
function declaringPaths(ctx, ref, t, side) {
  const trees = ctx.trees;
  const w = ref.where;
  const extra = ctx.config?.tests ?? [];
  const usable = (p) => SOURCE_EXT.test(p) && !isTestPath(p, extra) && !JVM_RESOURCES_PATH.test(p);
  let wanted;
  let stem = null;
  if (t.lang === 'jvm' || t.lang === 'cs') {
    if (!w?.type) return null;
    stem = w.type;
    wanted = t.lang === 'cs' ? [] : (w.pkgs ?? [t.pkg]).filter(Boolean).flatMap(P => JVM_EXTS.map(e => `${P.replace(/\./g, '/')}/${w.type}${e}`));
  } else if (t.lang === 'js') {
    if (!w?.keys) return null;
    wanted = w.keys.flatMap(k => JS_EXTS.map(e => k + e));
  } else if (t.lang === 'py') {
    if (!w?.keys) return null;
    wanted = w.keys.flatMap(k => [`${k}.py`, `${k}/__init__.py`, `src/${k}.py`, `lib/${k}.py`]);
  } else return null;
  const key = `${side}\0${stem}\0${wanted.join('|')}`;
  const memo = memoOf(trees);
  if (memo.has(key)) return memo.get(key);
  const listed = trees.list(side);
  let out;
  if (listed) {
    const all = [...listed];
    const exact = all.filter(p => usable(p) && wanted.some(s => (t.lang === 'jvm' ? p === s || p.endsWith('/' + s) : p === s))).sort();
    const byStem = stem ? all.filter(p => usable(p) && !exact.includes(p) && stemOfPath(p) === stem).sort().slice(0, 3) : [];
    out = { exact, byStem };
  } else {
    // No listing: try where the build would look.
    const tries = t.lang === 'jvm' ? wanted.flatMap(s => ['src/main/java/', 'src/main/kotlin/', 'src/', ''].map(r => r + s)) : wanted;
    const exact = [];
    let unknown = false;
    for (const p of tries) {
      const v = trees.read(side, p);
      if (typeof v === 'string') exact.push(p);
      else if (v === undefined) unknown = true;
    }
    out = exact.length || !unknown ? { exact, byStem: [] } : null;
  }
  memo.set(key, out);
  return out;
}

const fitsRef = (d, ref, lang) => ref.kind !== 'call' || d.kind !== 'fn' || !OVERLOADS.has(lang) || ref.arity == null || d.arity == null || d.arity === ref.arity;

// The member owner a jvm ref means (Rect for box.y() on a Ui.Rect box), or null where files own
// their declarations (js, py).
const ownerOf = (ref, t) => (t.lang === 'jvm' || t.lang === 'cs' ? (ref.kind === 'type' ? ref.name : ref.where?.inner ?? ref.where?.type ?? null) : null);

// A record's component accessor, or its implicit constructor, in a record this change does not
// touch: it hands back what the test put in, so the check is about whatever else it calls.
function recordLookup(ctx, idx, t, ref) {
  if (t.lang !== 'jvm') return undefined;
  const types = [ownerOf(ref, t), ref.kind === 'call' && /^[A-Z]/.test(ref.name) ? ref.name : null].filter(Boolean);
  if (!types.length) return undefined;
  const C = declaringPaths(ctx, ref, t, 'head');
  for (const p of C?.exact ?? []) {
    const file = ctx.trees.file('head', p);
    for (const type of types) {
      const rec = file?.records?.get(type);
      if (!rec) continue;
      if (idx.fileEdited(p)) return undefined;
      const neutral = { status: 'neutral', file: p, tree: true };
      if (ref.name === type) return rec.explicitCtor ? undefined : neutral;
      if (ref.kind === 'call' && ref.recv && (ref.arity ?? 0) === 0 && rec.components.has(ref.name) && !rec.methods.has(ref.name)) return neutral;
      return undefined;
    }
  }
  return undefined;
}

// Whether a ref the diff never declares (or declares elsewhere) is kept, gone or renamed in the
// head tree. Undefined when anything it needs is not known.
function headLookup(ctx, idx, t, ref) {
  const head = declaringPaths(ctx, ref, t, 'head');
  const base = declaringPaths(ctx, ref, t, 'base');
  if (!head || !base) return undefined;
  const owner = ownerOf(ref, t);
  const name = ref.name;
  const mine = (d) => owner == null || d.owner === owner;
  const declares = (file) => file.decls.find(d => d.name === name && mine(d) && fitsRef(d, ref, file.lang));
  // Kept in head.
  for (const p of [...head.exact, ...head.byStem]) {
    const file = ctx.trees.file('head', p);
    if (file === undefined) return undefined;
    if (file && declares(file)) return { status: 'kept', file: p, tree: true };
  }
  // Declared in base, in a file the ref points at.
  let from = null;
  let was = null;
  for (const p of base.exact) {
    const file = ctx.trees.file('base', p);
    if (file === undefined) return undefined;
    const d = file && declares(file);
    if (d) { from = { p, file }; was = d; break; }
  }
  if (!from) return undefined;
  // Renamed: head has exactly one new declaration of the same kind and arity in its place.
  const renamedRec = idx.records.find(r => r.f.oldPath != null && norm(r.f.oldPath) === from.p && r.f.newPath != null);
  const there = renamedRec ? norm(renamedRec.f.newPath) : from.p;
  const now = ctx.trees.file('head', there);
  if (now === undefined) return undefined;
  if (now) {
    const before = new Set(from.file.decls.filter(mine).map(d => d.name));
    const fresh = now.decls.filter(d => mine(d) && d.kind === was.kind && d.arity === was.arity && !before.has(d.name));
    if (fresh.length === 1) return { status: 'renamed', to: fresh[0].name, file: from.p, tree: true };
    if (fresh.length > 1) return { status: 'kept', file: there, tree: true };
  }
  // Moved: a file of the owner type's name (or the module's) elsewhere still declares it.
  const listed = ctx.trees.list('head');
  if (!listed) return undefined;
  const stem = owner != null ? ref.where.type : stemOfPath(from.p);
  const extra = ctx.config?.tests ?? [];
  const others = [...listed].filter(p => p !== there && SOURCE_EXT.test(p) && !isTestPath(p, extra) && !JVM_RESOURCES_PATH.test(p) && stemOfPath(p) === stem).sort().slice(0, 3);
  for (const p of others) {
    const file = ctx.trees.file('head', p);
    if (file === undefined) return undefined;
    if (file && declares(file)) return { status: 'kept', file: p, tree: true };
  }
  // Re-added on a + line the diff does show.
  if (owner != null && idx.addedUnder(name, owner)) return { status: 'kept', file: null, tree: true };
  return { status: 'gone', file: from.p, tree: true };
}

// A changed signature confirmed in head: when the declaring file still has a form the call fits,
// the call is not reshaped at all, it is kept.
function confirmArity(ctx, idx, ref, s) {
  const d = idx.liveDecls(ref.name, ref.where)[0];
  const path = d?.rec.path ?? s.file;
  if (!path) return s;
  const file = ctx.trees.file('head', path);
  if (!file) return s;
  const owner = OVERLOADS.has(file.lang) ? d?.owner ?? null : null;
  const fits = file.decls.some(x => x.name === ref.name && x.kind === 'fn' && (owner == null || x.owner === owner) && (ref.arity == null || x.arity == null || x.arity === ref.arity));
  return fits ? { status: 'kept', file: path, tree: true, basis: 'diff', overload: true } : { ...s, confirmed: true };
}

// Resource ids by stem, per tree: [{ path, dir, base }] for files under data/<ns>/ or assets/<ns>/.
const RES_FILE = /(?:^|\/)((?:data|assets)\/([^/]+)\/)(?:.*\/)?([^/]+)\.(json|lang|properties|toml|ya?ml|nbt|png|ogg)$/i;
function resourcesOf(ctx, side) {
  const memo = memoOf(ctx.trees);
  const key = `res\0${side}`;
  if (memo.has(key)) return memo.get(key);
  const listed = ctx.trees.list(side);
  let out = null;
  if (listed) {
    out = new Map();
    for (const p of listed) {
      const m = RES_FILE.exec(p);
      if (!m) continue;
      const dir = p.slice(0, m.index + (m[0].startsWith('/') ? 1 : 0)) + m[1];
      if (!out.has(m[3])) out.set(m[3], []);
      out.get(m[3]).push({ path: p, dir, ns: m[2], base: p.split('/').pop() });
    }
  }
  memo.set(key, out);
  return out;
}

// A resource the base tree has and the head tree does not, by the listings: the base path, null
// when it is still there, undefined when a listing is not known.
function treeResourceGone(ctx, id) {
  const base = resourcesOf(ctx, 'base');
  const head = resourcesOf(ctx, 'head');
  if (!base || !head) return undefined;
  const m = /^(?:([a-z0-9_.-]+):)?(.+)$/.exec(id);
  const ns = m[1] ?? null;
  const stem = m[2].split('/').pop();
  for (const e of base.get(stem) ?? []) {
    if (ns && e.ns !== ns) continue;
    if (!(head.get(stem) ?? []).some(h => h.dir === e.dir && h.base === e.base)) return e.path;
  }
  return null;
}

// What the trees say about one ref whose diff status is s.
function treeStatus(ctx, idx, t, ref, s) {
  if (ref.kind === 'resource') {
    if (s) return s;
    const file = treeResourceGone(ctx, ref.name);
    return file ? { status: 'gone', file, tree: true } : s;
  }
  if (!s || !ref.where) return s;
  if (s.status === 'kept') {
    const rec = recordLookup(ctx, idx, t, ref);
    if (rec) return rec;
    if (s.basis === 'unseen' || s.basis === 'loose') return headLookup(ctx, idx, t, ref) ?? s;
    return s;
  }
  if (s.status === 'arity' || (s.status === 'gone' && s.byArity)) return confirmArity(ctx, idx, ref, s);
  return s;
}

// The arguments of call ref r as written on the line, or null when it cannot be found.
function argsOf(text, r) {
  const esc = (x) => x.replace(/[.$]/g, '\\$&');
  const recv = r.recv.split('.').map(esc).join('\\s*\\.\\s*');
  const m = new RegExp(`(?<![\\w$])${recv}\\s*\\.\\s*${esc(r.name)}\\s*\\(`).exec(text);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = closeOf(text, open);
  return close < 0 ? null : splitTop(text.slice(open + 1, close)).map(x => x.trim());
}

// The refs on a line that the diff knows about, each with its status. When one of them would keep
// the line a lost check, or the test is shown in part, the trees (if the source has them) get to
// settle it: the test is read whole from base first, then each ref is looked up in head.
export function subjectRefs(ctx, f, text) {
  const idx = sourceIndex(ctx);
  const read = () => refsOf(text, f).map(r => ({ r, s: refStatus(idx, r) }));
  let refs = read();
  const trees = ctx.trees;
  const partial = !testContext(f).whole;
  if (trees && refs.length && (partial || refs.some(x => blocks(x.s)))) {
    if (!trees.available) trees.wanted++;
    else {
      if (partial && completeFromBase(ctx, f)) refs = read();
      const t = testContext(f);
      // A test shown in part whose base copy nobody has may bind a name to the wrong file, so
      // nothing is looked up for it. PR mode fetches the copy and asks again.
      if (!t.baseUnknown) refs = refs.map(x => ({ r: x.r, s: treeStatus(ctx, idx, t, x.r, x.s) }));
      // The base copy may show that a name the diff could not place is the project's own, but code
      // that is still there was never evidence either way: such a ref says nothing, as it did on
      // the diff alone. Only what the trees show gone, renamed or neutral counts.
      if (t.alone) {
        const key = (r) => `${r.kind}|${r.recv}|${r.name}|${r.arity}`;
        const before = new Map(refsOf(text, f, t.alone).map(r => [key(r), refStatus(idx, r)]));
        for (const x of refs) if (x.s?.status === 'kept' && !before.get(key(x.r))) x.s = null;
      }
    }
  }
  // A lookup keyed by a resource this change removes (Registry.get(ID) with ID's file deleted) is
  // about the resource. A call that computes with the result (cost(get(ID))) is not keyed by it.
  const gone = new Set();
  for (const x of refs) if (x.r.kind === 'resource' && x.s?.status === 'gone') gone.add(x.r.via ?? `"${x.r.name}"`);
  if (gone.size) {
    for (const x of refs) {
      if (x.r.kind !== 'call' || !x.r.recv || x.s?.status !== 'kept') continue;
      const args = argsOf(text, x.r);
      const keyed = args?.some(a => gone.has(a) || (PLAIN_STRING.test(a) && gone.has(`"${a.slice(1, -1)}"`)));
      if (keyed) x.s = { status: 'neutral', file: x.s.file };
    }
  }
  return refs.filter(x => x.s).map(x => ({ ...x.r, ...x.s }));
}

// Do the refs of one check excuse it as removed with its feature: at least one is out (gone, or
// with `out` a shrunk signature), and every other one is out too, sits in code this change edits,
// or is neutral (names project code that cannot be what the check is about). A neutral ref next to
// one that is merely edited blocks like a kept one, or inlining a constant and editing the method
// would excuse dropping the check.
export function excusedRefs(idx, refs, out) {
  const edited = (r) => r.status === 'kept' && r.kind !== 'type' && r.where != null && idx.touched(r.name, r.where);
  const neutral = (r) => r.status === 'neutral';
  return refs.some(out) && refs.every(r => out(r) || edited(r) || neutral(r)) && !(refs.some(neutral) && refs.some(edited));
}

// Lines removed together with the code they exercise: at least one ref is gone, and every other
// ref the diff knows is gone too, or sits in code this change edits (a constant dropped from a
// function that changed). One ref left untouched is enough to keep the lines a lost check.
// Returns the first gone ref, for the message, or null.
// With `shrunk`, a call to a signature that lost a parameter counts like a gone ref, and the
// result says `reshaped` when one did. `tree` says the trees, not the diff, showed it gone.
export function removedWithFeature(ctx, f, texts, { shrunk = false } = {}) {
  const idx = sourceIndex(ctx);
  const refs = texts.flatMap(t => subjectRefs(ctx, f, t));
  const out = (r) => r.status === 'gone' || (shrunk && r.status === 'arity' && r.shrunk);
  const gone = refs.filter(out);
  if (!gone.length || !excusedRefs(idx, refs, out)) return null;
  return { symbol: gone[0].name, file: gone[0].file, reshaped: gone.some(r => r.status === 'arity'), tree: gone[0].tree === true };
}
