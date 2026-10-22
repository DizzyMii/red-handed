// Where a diff comes from. Each source returns the shape scan() reads: kind, label, base, url,
// title, author, authorIsBot, diffText, untracked, notes and baseFile(path).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseDiff } from './diff.mjs';
import { planReads } from './scan.mjs';

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

function gitBytes(cwd, args) {
  const r = spawnSync('git', args, { cwd, maxBuffer: 1 << 28, windowsHide: true });
  return r.status === 0 && !r.error ? r.stdout : null;
}

// A file's text as a tree view hands it out: undefined when it is too big or binary.
const asText = (buf) => (buf.length > MAX_UNTRACKED_BYTES || buf.includes(0) ? undefined : buf.toString('utf8').replace(/\r\n/g, '\n'));

// The base and head trees of a local scan. base is the commit the diff is taken from (empty when
// there is none); head is the working tree as the diff sees it: tracked files on disk, staged and
// unstaged edits included, plus untracked ones, minus files deleted from the disk. Each side reads
// at most `cap` distinct files; past it a read is unknown and the view says it was capped.
export function localTrees(root, baseSha, untracked = [], { cap = 400 } = {}) {
  const split = (buf) => (buf ? buf.toString('utf8').split('\0').filter(Boolean).map(p => p.replace(/\\/g, '/')) : []);
  const view = (listAll, readOne) => {
    let listed = null;
    let set = null;
    const seen = new Set();
    const v = {
      cap,
      capped: false,
      list() {
        if (!listed) { listed = [...new Set(listAll())].sort(); set = new Set(listed); }
        return listed;
      },
      read(p) {
        v.list();
        if (!set.has(p)) return null;
        if (!seen.has(p)) {
          if (seen.size >= cap) { v.capped = true; return undefined; }
          seen.add(p);
        }
        try { return readOne(p); } catch { return undefined; }
      },
    };
    return v;
  };
  const base = view(
    () => (baseSha ? split(gitBytes(root, ['-c', 'core.quotepath=false', 'ls-tree', '-r', '-z', '--name-only', baseSha])) : []),
    (p) => { const buf = gitBytes(root, ['cat-file', 'blob', `${baseSha}:${p}`]); return buf ? asText(buf) : undefined; });
  const head = view(
    () => {
      const gone = new Set(split(gitBytes(root, ['ls-files', '-z', '--deleted'])));
      const files = split(gitBytes(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).filter(p => !gone.has(p));
      return [...files, ...untracked.map(u => u.path)];
    },
    (p) => asText(fs.readFileSync(path.join(root, p))));
  return { base, head };
}

export function localSource(cwd, base) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new Error('not inside a git repository');
  const root = top.out.trim();

  const head = resolves(root, 'HEAD');
  const branch = git(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const short = (rev) => git(root, ['rev-parse', '--short', rev]).out.trim();
  const here = branch.ok ? branch.out.trim() : (head ? short('HEAD') : 'HEAD');

  // Past diff.renameLimit (1000 by default) git stops pairing renames and a moved test reads as
  // deleted. 10000 stays in seconds where 0, unlimited, is a quadratic pass over a vendor drop.
  // A limit the repo sets itself is left alone.
  const ownLimit = git(root, ['config', '--get', 'diff.renameLimit']).ok;
  const diffArgs = ['-c', 'core.quotepath=false', ...(ownLimit ? [] : ['-c', 'diff.renameLimit=10000']),
    'diff', '--no-color', '--no-ext-diff', '--no-textconv',
    '--find-renames', '--src-prefix=a/', '--dst-prefix=b/', '-U3'];
  let renamesSkipped = false;
  const seeSkip = (r) => { if (/rename detection was skipped/.test(r.err)) renamesSkipped = true; return r; };

  let diffText = '';
  let label;
  let baseSha = null;
  let baseRef = null;

  if (!head) {
    // No commits yet: whatever is staged counts as added.
    diffText = seeSkip(git(root, [...diffArgs, '--cached', EMPTY_TREE, '--'])).out;
    label = `${here} (no commits yet)`;
  } else {
    if (base) {
      if (!resolves(root, base)) {
        const hint = /^[0-9a-f]{7,40}$/i.test(base) ? ' (is the checkout shallow? use actions/checkout with fetch-depth: 0)' : '';
        throw new Error(`unknown base ref "${base}"${hint}`);
      }
      baseRef = base;
    } else {
      baseRef = BASE_CANDIDATES.find(r => resolves(root, r)) ?? null;
    }
    if (baseRef) {
      const mb = git(root, ['merge-base', baseRef, 'HEAD']);
      baseSha = mb.ok ? mb.out.trim() : null;
      if (!baseSha) throw new Error(`no common ancestor between ${baseRef} and HEAD`);
      // Actions passes the base as a full sha; print it short and only once.
      const shown = /^[0-9a-f]{40}$/i.test(baseRef) ? short(baseRef) : baseRef;
      label = shown === short(baseSha) ? `${here} vs ${shown}` : `${here} vs ${shown} (${short(baseSha)})`;
    } else {
      baseSha = git(root, ['rev-parse', 'HEAD']).out.trim();
      label = `${here}, uncommitted changes`;
    }
    const d = seeSkip(git(root, [...diffArgs, baseSha, '--']));
    if (!d.ok) throw new Error(`git diff failed: ${d.err}`);
    diffText = d.out;
  }

  const { untracked, skipped } = readUntracked(root);
  const notes = skipped ? [`skipped ${skipped} large or binary untracked files`] : [];
  if (renamesSkipped) notes.push('git skipped rename detection for this many files; moved files may show as deleted. Scan a smaller range or raise diff.renameLimit.');
  // On main with the work already committed there is nothing to compare, which looks like a clean bill.
  if (!base && baseRef && baseSha && !diffText.trim() && !untracked.length && baseSha === git(root, ['rev-parse', 'HEAD']).out.trim()) {
    notes.push(`HEAD is ${baseRef}, so only uncommitted changes were scanned; pass --base HEAD~1 to scan your last commit`);
  }

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
    trees: localTrees(root, baseSha, untracked),
    baseFile(p) {
      if (!baseSha) return null;
      const r = git(root, ['show', `${baseSha}:${p}`]);
      return r.ok ? r.out : null;
    },
  };
}

const plain = { base: null, url: null, title: null, author: null, authorIsBot: null, untracked: [], notes: [], baseFile: () => null };

// Empty input is an empty diff. Text that is not a diff at all would otherwise scan as CLEAN.
function requireDiff(text) {
  if (text.trim() && parseDiff(text).files.length === 0) throw new Error('input is not a unified diff');
  return text;
}

export function fileSource(file) {
  let diffText;
  try {
    diffText = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`could not read ${file}: ${e.message}`);
  }
  return { kind: 'file', label: file, ...plain, diffText: requireDiff(diffText) };
}

export async function stdinSource(stream) {
  if (!stream || stream.isTTY) throw new Error('nothing on stdin');
  const chunks = [];
  for await (const c of stream) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return { kind: 'stdin', label: 'stdin', ...plain, diffText: requireDiff(Buffer.concat(chunks).toString('utf8')) };
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
  const source = {
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
    baseTipSha: meta.base?.sha ?? null,
    headSha: meta.head?.sha ?? null,
    repoPath: `${pr.owner}/${pr.repo}`,
  };
  // Kept off the source's data so the token never travels with it.
  source.loadTrees = (o = {}) => loadPrTrees(source, { fetch, token, version, ...o });
  return source;
}

const MAX_TREE_ROUNDS = 3;
const TREE_CONCURRENCY = 8;

// A tree view over Maps, filled as PR mode fetches: list() is null until a listing is in, a path
// not fetched is unknown, and one the listing does not have is absent.
function mapView() {
  const files = new Map();
  let listed = null;
  let set = null;
  return {
    capped: false,
    files,
    setList(paths) { listed = [...paths].sort(); set = new Set(listed); },
    list: () => listed,
    read: (p) => (files.has(p) ? files.get(p) : set && !set.has(p) ? null : undefined),
  };
}

// Fills source.trees for a pull request with what a scan asks for and cannot answer: planReads
// says what, this fetches it from the merge base and the head, and asks again, up to 3 rounds.
// It never throws. A failure becomes a note and leaves the rest unknown, which the engine reads
// as "judge on the diff alone".
export async function loadPrTrees(source, { fetch, token = '', version = '0.0.0', maxFiles } = {}) {
  const views = { base: mapView(), head: mapView() };
  source.trees = views;
  const notes = source.notes;
  const limit = maxFiles ?? (token ? 100 : 15);
  const api = `https://api.github.com/repos/${source.repoPath}`;
  const get = async (url, accept) => {
    const headers = { Accept: accept, 'User-Agent': `red-handed/${version}`, 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = `Bearer ${token}`;
    try { return await fetch(url, { headers }); } catch { return null; }
  };
  const limited = (res) => res != null && /rate limit/.test(failure(res, false).message) && (res.status === 429 || res.status === 403);

  let want = planReads(source);
  const asks = (w) => w.base.length || w.head.length || w.lists.base || w.lists.head;
  if (!asks(want) || !source.headSha || !source.baseTipSha) return;

  let baseSha = source.baseTipSha;
  const cmp = await get(`${api}/compare/${source.baseTipSha}...${source.headSha}?per_page=1`, 'application/vnd.github+json');
  const mb = cmp?.ok ? (await cmp.json().catch(() => null))?.merge_base_commit?.sha : null;
  if (mb) baseSha = mb;
  else notes.push('could not ask GitHub for the merge base, so the base files are read at the base branch tip');
  const sha = { base: baseSha, head: source.headSha };

  const listedSides = new Set();
  let read = 0;
  let fetched = 0;
  let stopped = null;
  for (let round = 0; round < MAX_TREE_ROUNDS && asks(want) && !stopped; round++) {
    // Listings first: with them in, the next plan asks for exact paths only.
    let listedNow = false;
    for (const side of ['base', 'head']) {
      if (!want.lists[side] || listedSides.has(side)) continue;
      listedSides.add(side);
      listedNow = true;
      const res = await get(`${api}/git/trees/${sha[side]}?recursive=1`, 'application/vnd.github+json');
      const body = res?.ok ? await res.json().catch(() => null) : null;
      if (body && !body.truncated && Array.isArray(body.tree)) views[side].setList(body.tree.filter(e => e.type === 'blob').map(e => e.path));
      else notes.push(`GitHub did not list every file of ${sha[side].slice(0, 7)}, so files were only found by import path`);
    }
    if (listedNow) want = planReads(source);
    const queue = [...want.base.map(p => ['base', p]), ...want.head.map(p => ['head', p])]
      .filter(([side, p]) => !views[side].files.has(p));
    if (!queue.length) break;
    // Requests run a few at a time; each answer lands in its own slot, so order does not matter.
    while (queue.length && !stopped) {
      const batch = [];
      while (queue.length && batch.length < TREE_CONCURRENCY) {
        if (read >= limit) { stopped = 'cap'; break; }
        batch.push(queue.shift());
        read++;
      }
      const answers = await Promise.all(batch.map(async ([side, p]) => {
        const res = await get(`${api}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${sha[side]}`, 'application/vnd.github.raw');
        if (res?.status === 404) return [side, p, null];
        if (limited(res)) return [side, p, 'limited'];
        if (!res?.ok) return [side, p, undefined];
        const text = await res.text().catch(() => undefined);
        return [side, p, typeof text === 'string' && text.length <= 2 * 1024 * 1024 && !text.includes('\0') ? text.replace(/\r\n/g, '\n') : undefined];
      }));
      for (const [side, p, v] of answers) {
        if (v === 'limited') { stopped = 'rate'; continue; }
        if (v !== undefined) views[side].files.set(p, v);
        fetched++;
      }
      if (stopped === 'rate') notes.push(`GitHub rate limit hit after reading ${fetched} files; the rest were judged on the diff alone. Set GITHUB_TOKEN`);
    }
    if (stopped === 'cap') notes.push(`read ${read} files from the base and head trees and stopped at the limit of ${limit}; checks that needed more were judged on the diff alone`);
    if (!stopped) want = planReads(source);
  }
}
