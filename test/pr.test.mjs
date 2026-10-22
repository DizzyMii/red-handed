import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prSource, parsePrSpec } from '../src/sources.mjs';
import { main } from '../src/cli.mjs';
import { mkDiff } from './helpers.mjs';

const META = {
  title: 'Fix the\n discount',
  user: { login: 'claude-bot', type: 'Bot' },
  base: { ref: 'main' },
  html_url: 'https://github.com/o/r/pull/12',
};

// A fake fetch: answers the metadata request, then the diff request, and records both.
function fakeFetch({ meta = META, diff = '', metaStatus = 200, diffStatus = 200, headers = {} } = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const isDiff = init.headers.Accept === 'application/vnd.github.diff';
    const status = isDiff ? diffStatus : metaStatus;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      json: async () => meta,
      text: async () => diff,
    };
  };
  f.calls = calls;
  return f;
}

const opts = (fetch, env = { GITHUB_TOKEN: 't0ken' }) => ({ fetch, env, version: '9.9.9', ghToken: () => '' });

test('parsePrSpec accepts URLs with suffixes, query and hash, and owner/repo#N', () => {
  const want = { owner: 'o', repo: 'r', number: 12 };
  assert.deepEqual(parsePrSpec('https://github.com/o/r/pull/12'), want);
  assert.deepEqual(parsePrSpec('https://github.com/o/r/pull/12/files'), want);
  assert.deepEqual(parsePrSpec('https://github.com/o/r/pull/12/commits?x=1'), want);
  assert.deepEqual(parsePrSpec('https://github.com/o/r/pull/12#discussion_r1'), want);
  assert.deepEqual(parsePrSpec('o/r#12'), want);
  assert.deepEqual(parsePrSpec('sanity-io/plugins#2035'), { owner: 'sanity-io', repo: 'plugins', number: 2035 });
});

test('parsePrSpec rejects things that are not pull requests', () => {
  for (const bad of ['o/r', 'o/r#', 'https://github.com/o/r', 'https://github.com/o/r/issues/3', 'x.diff', '-', 'o/r/pull/3']) {
    assert.equal(parsePrSpec(bad), null, bad);
  }
});

test('prSource fills the source from metadata and the diff body', async () => {
  const fetch = fakeFetch({ diff: mkDiff('a.js', [], ['x']) });
  const s = await prSource('o/r#12', opts(fetch));
  assert.equal(s.kind, 'pr');
  assert.equal(s.label, 'o/r#12  "Fix the discount"  by claude-bot (bot)');
  assert.equal(s.base, 'main');
  assert.equal(s.url, 'https://github.com/o/r/pull/12');
  assert.equal(s.author, 'claude-bot');
  assert.equal(s.authorIsBot, true);
  assert.match(s.diffText, /^diff --git a\/a\.js/);
  assert.equal(s.baseFile('.red-handed.json'), null);
  assert.deepEqual(s.untracked, []);
});

test('prSource sends the documented headers, the diff accept type and the token', async () => {
  const fetch = fakeFetch();
  await prSource('https://github.com/o/r/pull/12/files', opts(fetch));
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0].url, 'https://api.github.com/repos/o/r/pulls/12');
  assert.equal(fetch.calls[0].headers.Accept, 'application/vnd.github+json');
  assert.equal(fetch.calls[1].headers.Accept, 'application/vnd.github.diff');
  for (const c of fetch.calls) {
    assert.equal(c.headers['User-Agent'], 'red-handed/9.9.9');
    assert.equal(c.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(c.headers.Authorization, 'Bearer t0ken');
  }
});

test('prSource falls back to GH_TOKEN, then gh, then no token at all', async () => {
  let fetch = fakeFetch();
  await prSource('o/r#1', opts(fetch, { GH_TOKEN: 'ghtok' }));
  assert.equal(fetch.calls[0].headers.Authorization, 'Bearer ghtok');

  fetch = fakeFetch();
  await prSource('o/r#1', { fetch, env: {}, ghToken: () => 'from-gh' });
  assert.equal(fetch.calls[0].headers.Authorization, 'Bearer from-gh');

  fetch = fakeFetch();
  await prSource('o/r#1', { fetch, env: {}, ghToken: () => '' });
  assert.equal('Authorization' in fetch.calls[0].headers, false);
});

test('a human author is not marked as a bot', async () => {
  const meta = { ...META, user: { login: 'kade', type: 'User' } };
  const s = await prSource('o/r#1', opts(fakeFetch({ meta })));
  assert.equal(s.authorIsBot, false);
  assert.equal(s.label, 'o/r#1  "Fix the discount"  by kade');
});

test('404 maps to the not-found message', async () => {
  await assert.rejects(prSource('o/r#1', opts(fakeFetch({ metaStatus: 404 }))),
    /pull request not found \(private repos need GITHUB_TOKEN\)/);
});

test('403 with an empty rate limit maps to the rate limit message, 429 too', async () => {
  const limited = fakeFetch({ metaStatus: 403, headers: { 'x-ratelimit-remaining': '0' } });
  await assert.rejects(prSource('o/r#1', opts(limited)), /GitHub rate limit hit; set GITHUB_TOKEN/);
  await assert.rejects(prSource('o/r#1', opts(fakeFetch({ metaStatus: 429 }))), /rate limit/);
});

test('a plain 403 is not called a rate limit', async () => {
  await assert.rejects(prSource('o/r#1', opts(fakeFetch({ metaStatus: 403 }))), /GitHub answered 403/);
});

test('406 and 422 on the diff map to the too-large message', async () => {
  for (const diffStatus of [406, 422]) {
    await assert.rejects(prSource('o/r#1', opts(fakeFetch({ diffStatus }))),
      /GitHub refused to send a diff this large; clone the repo and run red-handed --base <base\.ref> there/);
  }
});

test('a network failure names the host and the cause', async () => {
  const fetch = async () => { throw Object.assign(new Error('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND') }); };
  await assert.rejects(prSource('o/r#1', opts(fetch)), /could not reach api\.github\.com: getaddrinfo ENOTFOUND/);
});

test('the cli scans a PR through an injected fetch and exits 1 when caught', async () => {
  const diff = mkDiff('test/a.test.js', [], ["it.skip('x', () => {})"]);
  const out = { stdout: '', stderr: '' };
  const code = await main(['https://github.com/o/r/pull/12', '--json'], {
    stdout: { write: (s) => { out.stdout += s; } },
    stderr: { write: (s) => { out.stderr += s; } },
    env: { GITHUB_TOKEN: 'x' },
    fetch: fakeFetch({ diff }),
    cwd: process.cwd(),
  });
  assert.equal(code, 1);
  const res = JSON.parse(out.stdout);
  assert.equal(res.source.kind, 'pr');
  assert.equal(res.source.authorIsBot, true);
  assert.ok(res.notes.includes('config not read in pr mode'));
});

test('the cli reports a PR failure on stderr with exit 2', async () => {
  const out = { stdout: '', stderr: '' };
  const code = await main(['o/r#99'], {
    stdout: { write: (s) => { out.stdout += s; } },
    stderr: { write: (s) => { out.stderr += s; } },
    env: { GITHUB_TOKEN: 'x' },
    fetch: fakeFetch({ metaStatus: 404 }),
    cwd: process.cwd(),
  });
  assert.equal(code, 2);
  assert.match(out.stderr, /^red-handed: pull request not found/);
  assert.equal(out.stdout, '');
});

// ---- the base and head trees in PR mode ------------------------------------------------------

const B = 'b'.repeat(40);
const H = 'c'.repeat(40);
const M = 'd'.repeat(40);
const RATES = 'src/main/java/demo/legacy/Rates.java';
const RATES_TEST = 'src/test/java/demo/legacy/RatesTest.java';
const CHECKS = ['    assertEquals(30, Rates.dailyRate(1));', '    assertEquals(60, Rates.dailyRate(2));'];
// Only the test's hunk: Rates.java is left out on purpose, so only the trees can say dailyRate went.
const RATES_DIFF = mkDiff(RATES_TEST, CHECKS, [], { before: ['  @Test', '  void rates() {'], after: ['    assertEquals(0, Rates.flat());', '  }'] });
const lines = (...l) => l.join('\n') + '\n';
const FILES = {
  [M]: {
    [RATES]: lines('package demo.legacy;', 'public final class Rates {', '  public static int dailyRate(int days) {', '    return days * 30;', '  }', '  public static int flat() {', '    return 0;', '  }', '}'),
    [RATES_TEST]: lines('package demo.legacy;', 'import org.junit.jupiter.api.Test;', 'class RatesTest {', '  @Test', '  void rates() {', ...CHECKS, '    assertEquals(0, Rates.flat());', '  }', '}'),
  },
  [H]: {
    [RATES]: lines('package demo.legacy;', 'public final class Rates {', '  public static int flat() {', '    return 0;', '  }', '}'),
    [RATES_TEST]: lines('package demo.legacy;', 'class RatesTest {', '}'),
  },
};

// A fake GitHub: the pull, its diff, compare, git trees and raw contents, each call recorded.
// `answer(kind, url, n)` may return a status to fail the n-th request of that kind.
function fakeGitHub({ diff = RATES_DIFF, files = FILES, answer = () => null } = {}) {
  const calls = [];
  const seen = {};
  const reply = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300, status, statusText: '',
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const f = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const kind = /\/compare\//.test(url) ? 'compare' : /\/git\/trees\//.test(url) ? 'tree' : /\/contents\//.test(url) ? 'contents' : /\/pulls\//.test(url) ? 'pull' : 'other';
    seen[kind] = (seen[kind] ?? 0) + 1;
    const forced = answer(kind, url, seen[kind]);
    if (forced) return reply(forced.status, forced.body ?? '', forced.headers);
    if (kind === 'pull') return init.headers.Accept === 'application/vnd.github.diff' ? reply(200, diff) : reply(200, { ...META, base: { ref: 'main', sha: B }, head: { sha: H } });
    if (kind === 'compare') return reply(200, { merge_base_commit: { sha: M } });
    if (kind === 'tree') {
      const sha = /\/git\/trees\/([0-9a-f]+)/.exec(url)[1];
      return reply(200, { truncated: false, tree: Object.keys(files[sha] ?? {}).map(path => ({ path, type: 'blob' })) });
    }
    if (kind === 'contents') {
      const m = /\/contents\/(.+)\?ref=([0-9a-f]+)$/.exec(url);
      const text = files[m[2]]?.[m[1].split('/').map(decodeURIComponent).join('/')];
      return text == null ? reply(404, '') : reply(200, text);
    }
    return reply(500, '');
  };
  f.calls = calls;
  return f;
}

async function runPr(fetch, env = { GITHUB_TOKEN: 'x' }) {
  const out = { stdout: '', stderr: '' };
  const code = await main(['o/r#12', '--json'], {
    stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } },
    env, fetch, cwd: process.cwd(),
  });
  assert.equal(out.stderr, '');
  return { code, res: JSON.parse(out.stdout) };
}

test('hook_pr_reads_at_merge_base_and_head: base files at the merge base, head files at head', async () => {
  const fetch = fakeGitHub();
  const { res } = await runPr(fetch);
  assert.equal(res.verdict, 'SUSPICIOUS', JSON.stringify(res.findings));
  const urls = fetch.calls.map(c => c.url);
  assert.ok(urls.includes(`https://api.github.com/repos/o/r/compare/${B}...${H}?per_page=1`), urls.join('\n'));
  assert.ok(urls.includes(`https://api.github.com/repos/o/r/contents/${RATES_TEST}?ref=${M}`));
  assert.ok(urls.includes(`https://api.github.com/repos/o/r/contents/${RATES}?ref=${M}`));
  assert.ok(urls.includes(`https://api.github.com/repos/o/r/contents/${RATES}?ref=${H}`));
  for (const c of fetch.calls.filter(x => /\/contents\//.test(x.url))) {
    assert.equal(c.headers.Accept, 'application/vnd.github.raw');
    assert.equal(c.headers.Authorization, 'Bearer x');
  }
});

test('hook_pr_404_is_absent: a listed head file that answers 404 is not there', async () => {
  const files = { [M]: FILES[M], [H]: { [RATES_TEST]: FILES[H][RATES_TEST] } };
  const listed = { truncated: false, tree: [RATES, RATES_TEST].map(path => ({ path, type: 'blob' })) };
  const fetch = fakeGitHub({ files, answer: (kind, url) => (kind === 'tree' && url.includes(H) ? { status: 200, body: listed } : null) });
  const { res } = await runPr(fetch);
  assert.ok(fetch.calls.some(c => c.url.endsWith(`/contents/${RATES}?ref=${H}`)));
  assert.equal(res.verdict, 'SUSPICIOUS', JSON.stringify(res.findings));
});

test('hook_pr_cap: past the limit the rest is judged on the diff alone', async () => {
  const { prSource: load } = await import('../src/sources.mjs');
  const { scan } = await import('../src/scan.mjs');
  const src = await load('o/r#12', opts(fakeGitHub()));
  await src.loadTrees({ maxFiles: 1 });
  const res = scan(src);
  assert.ok(res.notes.some(n => /stopped at the limit of 1/.test(n)), res.notes.join('\n'));
  assert.equal(res.verdict, 'CAUGHT');
});

test('hook_pr_rate_limit_midway: a 403 with no requests left stops reading, the scan still runs', async () => {
  const fetch = fakeGitHub({ answer: (kind, url, n) => (kind === 'contents' && n === 2 ? { status: 403, headers: { 'x-ratelimit-remaining': '0' } } : null) });
  const { code, res } = await runPr(fetch);
  assert.equal(code, 1);
  assert.ok(res.notes.some(n => /GitHub rate limit hit after reading \d+ files/.test(n)), res.notes.join('\n'));
  assert.equal(res.verdict, 'CAUGHT');
});

test('hook_pr_compare_fails: the base tip stands in, with a note', async () => {
  const fetch = fakeGitHub({ files: { [B]: FILES[M], [H]: FILES[H] }, answer: (kind) => (kind === 'compare' ? { status: 500 } : null) });
  const { res } = await runPr(fetch);
  assert.ok(res.notes.some(n => /could not ask GitHub for the merge base/.test(n)), res.notes.join('\n'));
  assert.equal(res.verdict, 'SUSPICIOUS');
});

test('hook_pr_no_asks_no_calls: a diff that needs no trees costs no extra requests', async () => {
  const fetch = fakeGitHub({ diff: mkDiff('test/a.test.js', [], ["it.skip('x', () => {})"]) });
  await runPr(fetch);
  assert.equal(fetch.calls.length, 2);
});
