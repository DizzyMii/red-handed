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
