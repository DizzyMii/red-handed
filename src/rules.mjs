// The cheating rules. Each rule is { id, tier, title, why, check(ctx) -> Finding[] }.
// ctx is built by scan.mjs: { files, config, source, isTest(p), allAddedTrimmed, truncated }.

import {
  isSourcePath, isSnapshotPath, isCiPath, isBuildPath, language, ASSERT, isCommentLine,
} from './classify.mjs';

export function clip(s) {
  if (s == null) return null;
  const t = String(s).trim();
  return t.length > 120 ? t.slice(0, 119) + '…' : t;
}

function defineRule({ id, tier, title, why }, fn) {
  return {
    id, tier, title, why,
    check(ctx) {
      const out = [];
      const add = (file, line, before, after, message) => out.push({
        rule: id, tier, file, line, before: clip(before), after: clip(after), message: message ?? why,
      });
      fn(ctx, add);
      return out;
    },
  };
}

const pathOf = (f) => f.newPath ?? f.oldPath;
const baseName = (p) => String(p).split('/').pop();
const isAssertLine = (t) => !isCommentLine(t) && ASSERT.test(t);
const fileIsTest = (ctx, f) => (f.newPath != null && ctx.isTest(f.newPath)) || (f.oldPath != null && ctx.isTest(f.oldPath));
const isSourceFile = (ctx, p) => isSourcePath(p, ctx.config.tests);

// Added lines of files whose new path passes `pathOk`, comment lines skipped unless asked for.
function* addedLines(ctx, pathOk, { comments = false } = {}) {
  for (const f of ctx.files) {
    const p = f.newPath;
    if (p == null || !pathOk(p)) continue;
    for (const a of f.added) {
      if (!comments && isCommentLine(a.text)) continue;
      yield { f, a, p };
    }
  }
}

const hunkLines = (f, a) => f.hunks[a.hunk]?.lines ?? [];

// Next line of the new file after `a` in its hunk that is neither blank nor a comment.
function nextCodeLine(f, a) {
  const lines = hunkLines(f, a);
  const idx = lines.findIndex(l => l.kind === '+' && l.newLine === a.line);
  if (idx < 0) return null;
  for (let j = idx + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.newLine == null) continue;
    if (!l.text.trim() || isCommentLine(l.text)) continue;
    return l.text;
  }
  return null;
}

// ---- patterns -------------------------------------------------------------------------------

const SKIP = {
  js: /\b(it|test|describe|context|suite|specify)\.(skip|todo)\s*\(|\bx(it|test|describe|context|specify)\s*\(|\b(it|test|describe)\.skipIf\s*\(\s*(true|1)\b|\bthis\.skip\s*\(|\bpending\s*\(/,
  py: /@pytest\.mark\.(skip|xfail)\b|@pytest\.mark\.skipif\s*\(\s*(True|1)\b|@unittest\.(skip|expectedFailure)\b|\bpytest\.(skip|xfail)\s*\(|\bself\.skipTest\s*\(|\braise\s+(unittest\.)?SkipTest\b/,
  jvm: /@(Disabled|Ignore|DisabledIf\w*|Ignored)\b|\bAssumptions\.assume\w*\s*\(\s*false|\bassumeTrue\s*\(\s*false|@Test\s*\(\s*enabled\s*=\s*false/,
  go: /\bt\.(Skip|SkipNow|Skipf)\s*\(/,
  rust: /#\[\s*ignore\b/,
  cs: /\[\s*Ignore\b|\bSkip\s*=\s*"|\[\s*Fact\s*\(\s*Skip|\[\s*Theory\s*\(\s*Skip|Assert\.Inconclusive\s*\(/,
  rb: /^\s*(skip|pending)\b|\bxit\b|\bxdescribe\b|\bxcontext\b/,
};

const FOCUS = /\b(it|test|describe|context|suite)\.only\s*\(|\bf(it|describe|context)\s*\(|@pytest\.mark\.only\b|\bfocus:\s*true/;

const STRONG = /\.(toBe|toEqual|toStrictEqual|toMatchObject|toMatch|toThrow\w*|toHaveBeenCalledWith|toContain|toHaveProperty|toMatchInlineSnapshot)\s*\(|\bassert(Equal|Equals|Same|StrictEqual|DeepEqual|DeepStrictEqual|ArrayEquals|Raises|Throws|That|Is|In|Regex|AlmostEqual|CountEqual|DictEqual|ListEqual)\b|\bassert\s+[^,\n]*?(==|!=|\bin\b|\bis\b|<|>)|\bassert_eq!|\bassert_ne!|\bAssert\.(AreEqual|Equal|Throws|Same)\b|\bassert\.(Equal|EqualValues|ErrorIs|Exactly)\b|\brequire\.(Equal|EqualValues|ErrorIs)\b|\bt\.Errorf?\s*\(|\bisEqualTo\s*\(|\bassert\.(equal|strictEqual|deepEqual|deepStrictEqual|notEqual|notStrictEqual|throws|rejects|match|doesNotMatch)\s*\(/;

const WEAK = /\.(toBeDefined|toBeTruthy|toBeFalsy|not\.toBeNull|not\.toBeUndefined|toBeInstanceOf|toHaveLength|toBeGreaterThanOrEqual)\s*\(|\.not\.toThrow\s*\(|\bassert(NotNull|IsNotNone|IsNotNull|True|IsInstance|Nonnull)\b|\bassert\s+\w[\w.\[\]'"]*\s*(?:$|#|,)|\bassert\s+\w[\w.]*\s+is\s+not\s+None\b|\bAssert\.(IsNotNull|NotNull|IsTrue|True)\b|\bassert\.(NotNil|True|NotEmpty)\b|\brequire\.(NotNil|True|NotEmpty)\b|\bisNotNull\s*\(|\bassert\.ok\s*\(|\bassert\s*\(\s*[\w.\[\]]+\s*\)/;

// Kept as separate patterns so each back-reference points at its own group.
const TAUTOLOGY = [
  /\bexpect\s*\(\s*(true|false|null|undefined|1|0|'[^']*'|"[^"]*")\s*\)\s*\.\s*(toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/,
  /\bassert\s+True\b|\bassert\s+1\s*==\s*1\b|\bassert\s+not\s+False\b|\bself\.assertTrue\s*\(\s*True\s*\)|\bassertTrue\s*\(\s*true\s*\)|\bAssert\.(IsTrue|True)\s*\(\s*true\s*\)|\bassert!\s*\(\s*true\s*\)|\bassert\.True\s*\(\s*t\s*,\s*true\s*\)|\bexpect\s*\(\s*true\s*\)\.toBeTruthy\s*\(\s*\)|\bassert\.ok\s*\(\s*true\s*\)/,
  /\bassert\s*\(\s*true\s*\)/,
  /\bassert\.(equal|strictEqual)\s*\(\s*(true|1)\s*,\s*\2\s*\)/,
];

const TEST_DETECTION = /process\.env\.(NODE_ENV|BABEL_ENV)\s*[!=]==?\s*['"`]test['"`]|['"`]test['"`]\s*[!=]==?\s*process\.env\.NODE_ENV|process\.env\.(JEST_WORKER_ID|VITEST|VITEST_WORKER_ID|MOCHA|CI_TEST|PLAYWRIGHT_TEST)|import\.meta\.vitest\b|['"]pytest['"]\s+in\s+sys\.modules|['"]unittest['"]\s+in\s+sys\.modules|PYTEST_CURRENT_TEST|sys\._called_from_test|\btesting\.Testing\s*\(\s*\)|\bflag\.Lookup\s*\(\s*"test\.v"\s*\)|strings\.HasSuffix\s*\(\s*os\.Args\[0\]\s*,\s*"\.test"\s*\)|Class\.forName\s*\(\s*"org\.junit|\bisRunningUnderTest\b|\bisRunningInTest\b|\bIS_TEST(ING)?\b|Rails\.env\.test\?|ENV\[['"]RAILS_ENV['"]\]\s*==\s*['"]test['"]|\bcfg!\s*\(\s*test\s*\)/;
const TEST_INFRA = ['/test-utils', '/testing/', 'jest.setup', 'vitest.setup', 'setupTests'];

const RUNNER = /\b(test|tests|jest|vitest|mocha|pytest|tox|nox|go\s+test|cargo\s+test|gradle\w*\s+\w*test|mvn\s+\w*\s*test|rspec|dotnet\s+test|npm\s+(run\s+)?test|yarn\s+test|pnpm\s+test|ctest|phpunit)\b/i;
// "|| :" is written with a lookahead because \b never matches after a colon.
const NEUTER = /\|\|\s*(?:(?:true|exit\s+0)\b|:(?!\w))|;\s*(true|exit\s+0)\s*$|--passWithNoTests|--pass-with-no-tests|--no-tests\b|exit\s+0|--testPathIgnorePatterns|--deselect\b|-k\s+['"]?not\s|--ignore[= ]\S*test|-DskipTests|-Dmaven\.test\.skip=true|-x\s+test\b|--exclude-task\s+test\b|--skip\s+\S*test|\becho\s+['"]?(ok|pass|passed|tests? passed)/i;
const TEST_SCRIPT = /^\s*"test"\s*:/;
// An empty script, or one that only echoes. An echo followed by && or ; still runs something after it.
const NEUTERED_SCRIPT = /^\s*"test"\s*:\s*"\s*(echo(?:\\.|(?!&&|;|\|)[^"\\])*|exit 0|true|:)?\s*"/i;
// "--ignore=" needs a separator in front because \b does not match between a space and a dash.
const BUILD_NEUTER = /ignoreFailures\s*=\s*true|testFailureIgnore\s*[>=]\s*['"]?true|<skipTests>\s*true|<maven\.test\.skip>\s*true|"?(testPathIgnorePatterns|modulePathIgnorePatterns)"?\s*:|\bnorecursedirs\s*=|(?:^|[\s"'])--ignore=|collect_ignore\b|addopts\s*=.*(--deselect|-k\s+['"]?not\s|--ignore)/;

const HIDE_ATTR = /(\s|^)(-diff|binary|linguist-generated(=true)?|linguist-vendored(=true)?|-text)\b/;

const SUPPRESSION = /@ts-(ignore|expect-error|nocheck)\b|eslint-disable|#\s*type:\s*ignore|#\s*noqa\b|#\s*pylint:\s*disable|#\s*pyright:\s*ignore|@SuppressWarnings\s*\(|#\[\s*allow\s*\(|\/\/\s*nolint\b|#pragma\s+warning\s+disable|\/\/\s*@ts-|rubocop:disable|istanbul\s+ignore|c8\s+ignore|pragma:\s*no\s+cover/;

const CATCH_EMPTY = /\bcatch\s*(\([^)]*\))?\s*\{\s*\}/;
const CATCH_OPEN = /\bcatch\s*(\([^)]*\))?\s*\{\s*$/;
const EXCEPT_PASS = /^\s*except\b[^:]*:\s*(pass|\.\.\.)\s*$/;
const EXCEPT_OPEN = /^\s*except\b[^:]*:\s*$/;
const PROMISE_CATCH = /\.catch\s*\(\s*\(\s*\w*\s*\)\s*=>\s*(\{\s*\}|null|undefined)\s*\)/;
const GO_DISCARD = /^\s*_\s*=\s*err\s*$/;

const STUB = /throw\s+new\s+Error\s*\(\s*['"`](not\s+implemented|todo|unimplemented)|raise\s+NotImplementedError|\btodo!\s*\(|\bunimplemented!\s*\(|UnsupportedOperationException|NotImplementedException|panic\s*\(\s*"(not\s+implemented|todo|unimplemented)/i;

const FLAKE = /\bjest\.retryTimes\s*\(|\bthis\.retries\s*\(|\bretries\s*:\s*[1-9]|@pytest\.mark\.flaky\b|--reruns\b|@RetryingTest\b|@Retry\b|\bjest\.setTimeout\s*\(|\bthis\.timeout\s*\(|@pytest\.mark\.timeout\s*\(|@Timeout\s*\(|\btestTimeout\s*:|\btimeout\s*:\s*\d{5,}/;

const TODO = /\b(TODO|FIXME|XXX|HACK)\b/;

// ---- shared helpers -------------------------------------------------------------------------

// Added "continue-on-error: true" lines in CI files, and whether a test runner word sits within
// 8 new-file lines of each. test-command-neutered reports the ones near a runner,
// ci-failure-ignored the rest.
function ciContinueOnError(f) {
  const out = [];
  const p = f.newPath;
  if (p == null || !isCiPath(p)) return out;
  for (const a of f.added) {
    if (isCommentLine(a.text) || !/continue-on-error\s*:\s*true/.test(a.text)) continue;
    const near = hunkLines(f, a).some(l =>
      l.newLine != null && Math.abs(l.newLine - a.line) <= 8 && !isCommentLine(l.text) && RUNNER.test(l.text));
    out.push({ a, near });
  }
  return out;
}

const STRING_LITERAL = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g;
const NUMBER_LITERAL = /-?\b\d+(\.\d+)?([eE][+-]?\d+)?\b/g;
const skeleton = (t) => t.trim().replace(STRING_LITERAL, 'S').replace(NUMBER_LITERAL, 'N').replace(/\s+/g, ' ');
const collapse = (t) => t.trim().replace(/\s+/g, ' ');

// ---- the rules, in spec order ---------------------------------------------------------------

export const RULES = [
  defineRule({
    id: 'test-deleted', tier: 'HARD', title: 'Test file deleted',
    why: 'A test file was deleted, so whatever it checked is no longer checked.',
  }, (ctx, add) => {
    for (const f of ctx.files) {
      if (f.oldPath == null || !ctx.isTest(f.oldPath) || isSnapshotPath(f.oldPath)) continue;
      const gone = f.status === 'deleted' || (f.status === 'renamed' && f.newPath != null && !ctx.isTest(f.newPath));
      if (gone) add(f.oldPath, 0, f.oldPath, null);
    }
  }),

  defineRule({
    id: 'test-skipped', tier: 'HARD', title: 'Test switched off',
    why: 'A test was switched off instead of fixed.',
  }, (ctx, add) => {
    for (const { a, p } of addedLines(ctx, () => true)) {
      const lang = language(p);
      let hit;
      if (lang === 'rust') hit = SKIP.rust.test(a.text);
      else if (!ctx.isTest(p)) continue;
      else if (lang === 'other') hit = Object.values(SKIP).some(r => r.test(a.text));
      else hit = SKIP[lang].test(a.text);
      if (hit) add(p, a.line, null, a.text);
    }
  }),

  defineRule({
    id: 'test-focused', tier: 'HARD', title: 'Test marked as the only one',
    why: 'A test was marked as the only one to run, which silently skips every other test.',
  }, (ctx, add) => {
    for (const { a, p } of addedLines(ctx, ctx.isTest)) if (FOCUS.test(a.text)) add(p, a.line, null, a.text);
  }),

  defineRule({
    id: 'assertion-removed', tier: 'HARD', title: 'Assertions removed',
    why: 'Assertions were removed from a test and not replaced, so the test checks less than it did.',
  }, (ctx, add) => {
    for (const f of ctx.files) {
      if (f.status === 'deleted' || !fileIsTest(ctx, f)) continue;
      const removed = f.removed.filter(r => isAssertLine(r.text) && !ctx.allAddedTrimmed.has(r.text.trim()));
      const added = f.added.filter(a => isAssertLine(a.text));
      if (removed.length > added.length) {
        for (const r of removed.slice(0, 10)) add(pathOf(f), r.line, r.text, null);
      }
    }
  }),

  defineRule({
    id: 'assertion-weakened', tier: 'HARD', title: 'Assertion loosened',
    why: 'A precise assertion was swapped for a looser one that passes for almost any value.',
  }, (ctx, add) => {
    for (const f of ctx.files) {
      if (!fileIsTest(ctx, f)) continue;
      for (const h of f.hunks) {
        const code = (kind) => h.lines.filter(l => l.kind === kind && !isCommentLine(l.text));
        const removedStrong = code('-').filter(l => STRONG.test(l.text));
        // An added line like "assert x is not None" reads as strong to STRONG but is the weak form.
        const addedStrong = code('+').filter(l => STRONG.test(l.text) && !WEAK.test(l.text));
        const addedWeak = code('+').filter(l => WEAK.test(l.text));
        if (removedStrong.length > addedStrong.length) {
          for (const w of addedWeak) add(pathOf(f), w.newLine, removedStrong[0].text, w.text);
        }
      }
    }
  }),

  defineRule({
    id: 'tautology-added', tier: 'HARD', title: 'Assertion that cannot fail',
    why: 'An assertion that can never fail was added, so the test passes without checking anything.',
  }, (ctx, add) => {
    for (const { a, p } of addedLines(ctx, ctx.isTest)) if (TAUTOLOGY.some(r => r.test(a.text))) add(p, a.line, null, a.text);
  }),

  defineRule({
    id: 'test-detection', tier: 'HARD', title: 'Code checks if it runs under test',
    why: 'Production code now checks whether it is running under a test, which is how code fakes a pass.',
  }, (ctx, add) => {
    const pathOk = (p) => isSourceFile(ctx, p) && !isBuildPath(p) && !isCiPath(p)
      && !TEST_INFRA.some(s => ('/' + p).includes(s));
    for (const { a, p } of addedLines(ctx, pathOk)) if (TEST_DETECTION.test(a.text)) add(p, a.line, null, a.text);
  }),

  defineRule({
    id: 'test-command-neutered', tier: 'HARD', title: 'Test command defanged',
    why: 'The command that runs the tests was changed so failures no longer fail the build.',
  }, (ctx, add) => {
    for (const f of ctx.files) {
      const p = f.newPath;
      if (p == null) continue;
      const build = isBuildPath(p);
      if (!build && !isCiPath(p)) continue;
      const pkg = baseName(p) === 'package.json';
      for (const a of f.added) {
        if (isCommentLine(a.text)) continue;
        if (RUNNER.test(a.text) && NEUTER.test(a.text)) add(p, a.line, null, a.text);
        if (pkg && NEUTERED_SCRIPT.test(a.text)) add(p, a.line, null, a.text);
        if (build && BUILD_NEUTER.test(a.text)) add(p, a.line, null, a.text);
      }
      if (pkg && f.status !== 'deleted' && !f.added.some(a => TEST_SCRIPT.test(a.text))) {
        for (const r of f.removed) if (TEST_SCRIPT.test(r.text)) add(p, r.line, r.text, null);
      }
      for (const { a, near } of ciContinueOnError(f)) if (near) add(p, a.line, null, a.text);
    }
  }),

  defineRule({
    id: 'allowlist-edited', tier: 'HARD', title: 'Allow list edited',
    why: "The change edits red-handed's own allow list. Allowances only count from the base branch.",
  }, (ctx, add) => {
    for (const f of ctx.files) {
      if (f.oldPath === '.red-handed.json' || f.newPath === '.red-handed.json') add('.red-handed.json', 0, null, null);
    }
  }),

  defineRule({
    id: 'diff-hidden', tier: 'HARD', title: 'Files hidden from diffs',
    why: '.gitattributes now hides some files from diffs or review, which is where cheating hides.',
  }, (ctx, add) => {
    const couldCover = (token) => {
      if (/test|spec/i.test(token)) return true;
      if (token.includes('*')) {
        // "*.png" cannot match code; "*", "src/**" and "*.js" can.
        const ext = /\.([A-Za-z0-9]+)$/.exec(token);
        return !ext || language('x.' + ext[1]) !== 'other';
      }
      return language(token) !== 'other';
    };
    // Patterns start with '*' here, which the shared comment check would swallow; only '#' is a comment.
    for (const { a, p } of addedLines(ctx, (p) => baseName(p) === '.gitattributes', { comments: true })) {
      if (a.text.trim().startsWith('#') || !HIDE_ATTR.test(a.text)) continue;
      const token = a.text.trim().split(/\s+/)[0];
      if (couldCover(token)) add(p, a.line, null, a.text);
    }
  }),

  defineRule({
    id: 'expectation-edited', tier: 'SOFT', title: 'Expected value changed',
    why: 'The expected value in an assertion changed. Fine if the behavior was meant to change, a cheat if the test was bent to match a bug.',
  }, (ctx, add) => {
    for (const f of ctx.files) {
      if (!fileIsTest(ctx, f)) continue;
      for (const h of f.hunks) {
        const rem = h.lines.filter(l => l.kind === '-' && isAssertLine(l.text));
        const ad = h.lines.filter(l => l.kind === '+' && isAssertLine(l.text));
        for (let i = 0; i < Math.min(rem.length, ad.length); i++) {
          if (skeleton(rem[i].text) === skeleton(ad[i].text) && collapse(rem[i].text) !== collapse(ad[i].text)) {
            add(pathOf(f), ad[i].newLine, rem[i].text, ad[i].text);
          }
        }
      }
    }
  }),

  defineRule({
    id: 'snapshot-rewritten', tier: 'SOFT', title: 'Snapshots regenerated',
    why: 'Saved snapshots were regenerated alongside a code change. Check the new snapshot is what you actually want.',
  }, (ctx, add) => {
    if (!ctx.files.some(f => isSourceFile(ctx, pathOf(f)))) return;
    for (const f of ctx.files) if (isSnapshotPath(pathOf(f))) add(pathOf(f), 0, null, null);
  }),

  defineRule({
    id: 'suppression-added', tier: 'SOFT', title: 'Warning silenced',
    why: 'A type-checker, linter or coverage warning was silenced instead of fixed.',
  }, (ctx, add) => {
    const pathOk = (p) => isSourceFile(ctx, p) || ctx.isTest(p);
    for (const { a, p } of addedLines(ctx, pathOk, { comments: true })) if (SUPPRESSION.test(a.text)) add(p, a.line, null, a.text);
  }),

  defineRule({
    id: 'swallowed-exception', tier: 'SOFT', title: 'Error caught and ignored',
    why: 'An error is now caught and ignored, which can turn a real failure into a silent pass.',
  }, (ctx, add) => {
    const pathOk = (p) => isSourceFile(ctx, p) || ctx.isTest(p);
    for (const { f, a, p } of addedLines(ctx, pathOk)) {
      const t = a.text;
      let hit = CATCH_EMPTY.test(t) || EXCEPT_PASS.test(t) || PROMISE_CATCH.test(t) || GO_DISCARD.test(t);
      if (!hit && CATCH_OPEN.test(t)) hit = /^\s*\}\s*$/.test(nextCodeLine(f, a) ?? '');
      if (!hit && EXCEPT_OPEN.test(t)) hit = /^\s*(pass|\.\.\.)\s*$/.test(nextCodeLine(f, a) ?? '');
      if (hit) add(p, a.line, null, t);
    }
  }),

  defineRule({
    id: 'stub-added', tier: 'SOFT', title: 'Stub added',
    why: 'A stub was added in place of real behavior.',
  }, (ctx, add) => {
    for (const { a, p } of addedLines(ctx, (p) => isSourceFile(ctx, p))) if (STUB.test(a.text)) add(p, a.line, null, a.text);
  }),

  defineRule({
    id: 'ci-failure-ignored', tier: 'SOFT', title: 'CI step may fail silently',
    why: 'A CI step is now allowed to fail without failing the build.',
  }, (ctx, add) => {
    for (const f of ctx.files) {
      const p = f.newPath;
      if (p == null) continue;
      for (const { a, near } of ciContinueOnError(f)) if (!near) add(p, a.line, null, a.text);
      if (baseName(p) === '.gitlab-ci.yml') {
        for (const a of f.added) if (!isCommentLine(a.text) && /allow_failure\s*:\s*true/.test(a.text)) add(p, a.line, null, a.text);
      }
    }
  }),

  defineRule({
    id: 'flake-masking', tier: 'SOFT', title: 'Retries or longer timeouts',
    why: 'Retries or longer timeouts were added, which can hide a real failure as flakiness.',
  }, (ctx, add) => {
    for (const { a, p } of addedLines(ctx, (p) => ctx.isTest(p) || isBuildPath(p))) if (FLAKE.test(a.text)) add(p, a.line, null, a.text);
  }),

  defineRule({
    id: 'todo-added', tier: 'SOFT', title: 'TODO left in',
    why: 'Unfinished work was marked and left in.',
  }, (ctx, add) => {
    for (const { a, p } of addedLines(ctx, (p) => isSourceFile(ctx, p), { comments: true })) if (TODO.test(a.text)) add(p, a.line, null, a.text);
  }),

  defineRule({
    id: 'diff-truncated', tier: 'SOFT', title: 'Diff too large to scan',
    why: 'The diff was too large to scan in full; findings may be missing.',
  }, (ctx, add) => {
    if (ctx.truncated) add('', 0, null, null);
  }),
];
