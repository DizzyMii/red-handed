// Where a diff comes from. Each source returns the shape scan() reads: kind, label, base, url,
// title, author, authorIsBot, diffText, untracked, notes and baseFile(path).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const BASE_CANDIDATES = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'];
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true });
  if (r.error) {
    if (r.error.code === 'ENOENT') throw new Error('git was not found on PATH');
    throw new Error(`git failed: ${r.error.message}`);
  }
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '').trim() };
}

const resolves = (cwd, ref) => git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).ok;

function readUntracked(top) {
  const listed = git(top, ['ls-files', '--others', '--exclude-standard', '-z']);
  const untracked = [];
  let skipped = 0;
  for (const rel of listed.out.split('\0').filter(Boolean)) {
    const full = path.join(top, rel);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      if (st.size > MAX_UNTRACKED_BYTES) { skipped++; continue; }
      const buf = fs.readFileSync(full);
      if (buf.includes(0)) { skipped++; continue; }
      untracked.push({ path: rel.replace(/\\/g, '/'), text: buf.toString('utf8').replace(/\r\n/g, '\n') });
    } catch {
      skipped++;
    }
  }
  return { untracked, skipped };
}

export function localSource(cwd, base) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new Error('not inside a git repository');
  const root = top.out.trim();

  const head = resolves(root, 'HEAD');
  const branch = git(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const short = (rev) => git(root, ['rev-parse', '--short', rev]).out.trim();
  const here = branch.ok ? branch.out.trim() : (head ? short('HEAD') : 'HEAD');

  const diffArgs = ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv',
    '--find-renames', '--src-prefix=a/', '--dst-prefix=b/', '-U3'];

  let diffText = '';
  let label;
  let baseSha = null;
  let baseRef = null;

  if (!head) {
    // No commits yet: whatever is staged counts as added.
    diffText = git(root, [...diffArgs, '--cached', EMPTY_TREE, '--']).out;
    label = `${here} (no commits yet)`;
  } else {
    if (base) {
      if (!resolves(root, base)) throw new Error(`unknown base ref "${base}"`);
      baseRef = base;
    } else {
      baseRef = BASE_CANDIDATES.find(r => resolves(root, r)) ?? null;
    }
    if (baseRef) {
      const mb = git(root, ['merge-base', baseRef, 'HEAD']);
      baseSha = mb.ok ? mb.out.trim() : null;
      if (!baseSha) throw new Error(`no common ancestor between ${baseRef} and HEAD`);
      label = `${here} vs ${baseRef} (${short(baseSha)})`;
    } else {
      baseSha = git(root, ['rev-parse', 'HEAD']).out.trim();
      label = `${here}, uncommitted changes`;
    }
    const d = git(root, [...diffArgs, baseSha, '--']);
    if (!d.ok) throw new Error(`git diff failed: ${d.err}`);
    diffText = d.out;
  }

  const { untracked, skipped } = readUntracked(root);
  const notes = skipped ? [`skipped ${skipped} large or binary untracked files`] : [];

  return {
    kind: 'local',
    label,
    base: baseRef ?? (baseSha ? 'HEAD' : null),
    url: null,
    title: null,
    author: null,
    authorIsBot: null,
    diffText,
    untracked,
    notes,
    baseFile(p) {
      if (!baseSha) return null;
      const r = git(root, ['show', `${baseSha}:${p}`]);
      return r.ok ? r.out : null;
    },
  };
}

const plain = { base: null, url: null, title: null, author: null, authorIsBot: null, untracked: [], notes: [], baseFile: () => null };

export function fileSource(file) {
  let diffText;
  try {
    diffText = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`could not read ${file}: ${e.message}`);
  }
  return { kind: 'file', label: file, ...plain, diffText };
}

export async function stdinSource(stream) {
  if (!stream || stream.isTTY) throw new Error('nothing on stdin');
  const chunks = [];
  for await (const c of stream) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return { kind: 'stdin', label: 'stdin', ...plain, diffText: Buffer.concat(chunks).toString('utf8') };
}
