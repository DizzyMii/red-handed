import { scan } from '../src/scan.mjs';

// Builds a valid unified diff for one file.
//   mkDiff('test/a.test.js', ['old line'], ['new line'])
//   mkDiff('src/a.js', [], ['x'], { status: 'added' })
//   mkDiff('test/a.test.js', [], [], { status: 'deleted', removedBody: [...] })
export function mkDiff(path, removed = [], added = [], opts = {}) {
  const { status = 'modified', oldPath = path, before = [], after = [], context = '' } = opts;
  const head = [];
  if (status === 'renamed') {
    head.push(`diff --git a/${oldPath} b/${path}`, 'similarity index 90%', `rename from ${oldPath}`, `rename to ${path}`);
  } else {
    head.push(`diff --git a/${path} b/${path}`);
    if (status === 'added') head.push('new file mode 100644');
    if (status === 'deleted') head.push('deleted file mode 100644');
  }
  const body = [...before.map(t => ' ' + t), ...removed.map(t => '-' + t), ...added.map(t => '+' + t), ...after.map(t => ' ' + t)];
  if (!body.length) return head.join('\n') + '\n';
  const oldCount = before.length + removed.length + after.length;
  const newCount = before.length + added.length + after.length;
  const a = status === 'added' ? '/dev/null' : `a/${oldPath}`;
  const b = status === 'deleted' ? '/dev/null' : `b/${path}`;
  const oldStart = status === 'added' ? 0 : 1;
  const newStart = status === 'deleted' ? 0 : 1;
  return [...head, `--- ${a}`, `+++ ${b}`, `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${context ? ' ' + context : ''}`, ...body].join('\n') + '\n';
}

export function mkSource(diffText, extra = {}) {
  return { kind: 'file', label: 'test', base: null, url: null, title: null, author: null, authorIsBot: null,
    diffText, untracked: [], baseFile: () => null, ...extra };
}

// Scan one or more diffs with a plain config object.
export function run(diffs, config = {}, extra = {}) {
  const text = Array.isArray(diffs) ? diffs.join('') : diffs;
  return scan(mkSource(text, extra), config);
}

export const hits = (result, rule) => result.findings.filter(f => f.rule === rule);
