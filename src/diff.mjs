// Unified diff parser. Starts from the RPIV parseDiff in antitamper.mjs, extended to the
// file record shape in SPEC 4.1. Hunk lengths from the @@ header decide where a hunk ends,
// so a removed line that starts with "--" or a "+++ " line inside a hunk is content.

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

// Git quotes unusual paths C-style, with octal escapes for raw bytes. Returns the decoded
// value and the index just past the closing quote.
// Bytes go through TextEncoder/TextDecoder, not Buffer, so the parser also runs in a browser.
const enc = new TextEncoder();
function readQuoted(s) {
  const bytes = [];
  const push = str => { for (const b of enc.encode(str)) bytes.push(b); };
  let i = 1;
  while (i < s.length && s[i] !== '"') {
    if (s[i] === '\\' && i + 1 < s.length) {
      const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1));
      if (oct) {
        bytes.push(parseInt(oct[0], 8) & 0xff);
        i += 1 + oct[0].length;
      } else {
        const e = s[i + 1];
        if (Object.hasOwn(C_ESCAPES, e)) bytes.push(C_ESCAPES[e]); else push(e);
        i += 2;
      }
    } else {
      push(s[i]);
      i++;
    }
  }
  return { value: new TextDecoder().decode(new Uint8Array(bytes)), end: i + 1 };
}

// Path from a ---/+++/rename line: quoted, or the rest of the line (diff -u adds a tab and a timestamp).
function readPath(raw) {
  if (raw.startsWith('"')) return readQuoted(raw).value;
  const tab = raw.indexOf('\t');
  return tab >= 0 ? raw.slice(0, tab) : raw;
}

// Paths from "diff --git a/x b/y". Both names are re-read from the ---/+++ lines when present,
// which resolves names with spaces; this is the fallback for binary-only records.
function gitHeaderPaths(rest) {
  if (rest.startsWith('"')) {
    const a = readQuoted(rest);
    const tail = rest.slice(a.end).replace(/^ /, '');
    const b = tail.startsWith('"') ? readQuoted(tail).value : tail;
    return { oldPath: a.value.replace(/^a\//, ''), newPath: b.replace(/^b\//, '') };
  }
  if (rest.startsWith('a/')) {
    const idx = rest.indexOf(' b/');
    if (idx >= 0) return { oldPath: rest.slice(2, idx), newPath: rest.slice(idx + 3) };
  }
  return { oldPath: null, newPath: null };
}

export function parseDiff(text, { maxLines = 300000 } = {}) {
  let lines = String(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let truncated = false;
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    truncated = true;
  }

  const entries = [];
  let cur = null;   // { rec, isNew, isDeleted, renamed, gotMinus }
  let hunk = null;  // { e, index, remOld, remNew, oldLn, newLn }

  const open = () => {
    cur = {
      rec: { oldPath: null, newPath: null, status: 'modified', binary: false, hunks: [], added: [], removed: [] },
      isNew: false, isDeleted: false, renamed: false, gotMinus: false,
    };
    entries.push(cur);
    return cur;
  };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.endsWith('\r')) line = line.slice(0, -1);

    if (hunk) {
      const c = line.charAt(0);
      const done = hunk.remOld <= 0 && hunk.remNew <= 0;
      if (c === '\\') continue;
      const h = hunk.e.rec.hunks[hunk.index];
      if (c === '+' && hunk.remNew > 0) {
        const text = line.slice(1);
        const n = hunk.newLn++;
        h.lines.push({ kind: '+', text, oldLine: null, newLine: n });
        hunk.e.rec.added.push({ line: n, text, hunk: hunk.index });
        hunk.remNew--;
        continue;
      }
      if (c === '-' && hunk.remOld > 0) {
        const text = line.slice(1);
        const n = hunk.oldLn++;
        h.lines.push({ kind: '-', text, oldLine: n, newLine: null });
        hunk.e.rec.removed.push({ line: n, text, hunk: hunk.index });
        hunk.remOld--;
        continue;
      }
      if ((c === ' ' || c === '') && !done) {
        const o = hunk.oldLn++;
        const n = hunk.newLn++;
        h.lines.push({ kind: ' ', text: line.slice(1), oldLine: o, newLine: n });
        hunk.remOld--;
        hunk.remNew--;
        continue;
      }
      hunk = null;
    }

    if (line.startsWith('diff --git ')) {
      open();
      Object.assign(cur.rec, gitHeaderPaths(line.slice('diff --git '.length)));
      continue;
    }

    if (line.startsWith('@@')) {
      const m = HUNK.exec(line);
      if (m && cur) {
        const rec = cur.rec;
        rec.hunks.push({ oldStart: +m[1], newStart: +m[3], lines: [] });
        hunk = {
          e: cur,
          index: rec.hunks.length - 1,
          remOld: m[2] === undefined ? 1 : +m[2],
          remNew: m[4] === undefined ? 1 : +m[4],
          oldLn: +m[1],
          newLn: +m[3],
        };
      }
      continue;
    }

    if (line.startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1].startsWith('+++ ')) {
      if (!cur || cur.gotMinus || cur.rec.hunks.length) open();
      cur.gotMinus = true;
      const p = readPath(line.slice(4));
      if (p === '/dev/null') cur.isNew = true;
      else cur.rec.oldPath = p.replace(/^[ab]\//, '');
      continue;
    }

    if (!cur) continue;
    const rec = cur.rec;

    if (line.startsWith('+++ ')) {
      const p = readPath(line.slice(4));
      if (p === '/dev/null') cur.isDeleted = true;
      else rec.newPath = p.replace(/^[ab]\//, '');
    } else if (line.startsWith('new file mode')) {
      cur.isNew = true;
      rec.oldPath = null;
    } else if (line.startsWith('deleted file mode')) {
      cur.isDeleted = true;
      rec.newPath = null;
    } else if (line.startsWith('rename from ')) {
      cur.renamed = true;
      rec.oldPath = readPath(line.slice(12));
    } else if (line.startsWith('rename to ')) {
      cur.renamed = true;
      rec.newPath = readPath(line.slice(10));
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      rec.binary = true;
    }
  }

  const files = entries.map(({ rec, isNew, isDeleted, renamed }) => ({
    oldPath: rec.oldPath,
    newPath: rec.newPath,
    status: renamed ? 'renamed' : isNew ? 'added' : isDeleted ? 'deleted' : 'modified',
    binary: rec.binary,
    hunks: rec.hunks,
    added: rec.added,
    removed: rec.removed,
  }));
  return { files, truncated };
}
