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

const PR_URL = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;
const PR_SHORT = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

export function parsePrSpec(spec) {
  const m = PR_URL.exec(spec) ?? PR_SHORT.exec(spec);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

function ghAuthToken() {
  try {
    const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    return r.status === 0 ? r.stdout.trim() : '';
  } catch {
    return '';
  }
}

function failure(res, forDiff) {
  const h = (name) => res.headers?.get?.(name) ?? null;
  const limited = res.status === 429 || (res.status === 403 && (h('x-ratelimit-remaining') === '0' || h('retry-after') != null));
  if (limited) return new Error('GitHub rate limit hit; set GITHUB_TOKEN');
  if (res.status === 404) return new Error('pull request not found (private repos need GITHUB_TOKEN)');
  if (forDiff && (res.status === 406 || res.status === 422)) {
    return new Error('GitHub refused to send a diff this large; clone the repo and run red-handed --base <base.ref> there');
  }
  if (res.status === 401) return new Error('GitHub rejected the token (401)');
  return new Error(`GitHub answered ${res.status} ${res.statusText ?? ''}`.trim());
}

export async function prSource(spec, { fetch = globalThis.fetch, env = {}, version = '0.0.0', ghToken = ghAuthToken } = {}) {
  const pr = parsePrSpec(spec);
  if (!pr) throw new Error(`not a pull request: ${spec}`);
  if (typeof fetch !== 'function') throw new Error('this Node has no fetch; PR mode needs Node 20 or newer');

  const token = env.GITHUB_TOKEN || env.GH_TOKEN || ghToken() || '';
  const url = `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`;
  const get = async (accept) => {
    const headers = { Accept: accept, 'User-Agent': `red-handed/${version}`, 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      return await fetch(url, { headers });
    } catch (e) {
      throw new Error(`could not reach api.github.com: ${e.cause?.message ?? e.message}`);
    }
  };

  const metaRes = await get('application/vnd.github+json');
  if (!metaRes.ok) throw failure(metaRes, false);
  const meta = await metaRes.json();
  const diffRes = await get('application/vnd.github.diff');
  if (!diffRes.ok) throw failure(diffRes, true);
  const diffText = await diffRes.text();

  const login = meta.user?.login ?? null;
  const isBot = meta.user ? meta.user.type === 'Bot' : null;
  const title = (meta.title ?? '').replace(/\s+/g, ' ').trim();
  return {
    kind: 'pr',
    label: `${pr.owner}/${pr.repo}#${pr.number}  "${title}"${login ? `  by ${login}${isBot ? ' (bot)' : ''}` : ''}`,
    base: meta.base?.ref ?? null,
    url: meta.html_url ?? `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
    title,
    author: login,
    authorIsBot: isBot,
    diffText,
    untracked: [],
    notes: [],
    baseFile: () => null,
  };
}
