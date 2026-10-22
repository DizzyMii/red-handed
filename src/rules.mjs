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
      // `softer` lets a HARD rule report a finding it is less sure about as SOFT.
      const add = (file, line, before, after, message, softer) => out.push({
        rule: id, tier: softer ? 'SOFT' : tier, file, line, before: clip(before), after: clip(after), message: message ?? why,
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
  // The second branch is an alias made of a skip ("const itX = it.skip"); a ternary there is only a conditional skip.
  js: /\b(it|test|describe|context|suite|specify)\.(skip|todo|fixme)\s*\(|=\s*[^;]*\b(it|test|describe)\.skip\b(?!\s*\()|\bx(it|test|describe|context|specify)\s*\(|\b(it|test|describe)\.skipIf\s*\(\s*(true|1)\b|\bthis\.skip\s*\(|(?<![.\w$])pending\s*\(/,
  py: /@pytest\.mark\.(skip|xfail)\b|@pytest\.mark\.skipif\s*\(\s*(True|1)\b|@unittest\.(skip|expectedFailure)\b|@unittest\.skipIf\s*\(\s*(True|1)\b|@unittest\.skipUnless\s*\(\s*(False|0)\b|\bpytest\.(skip|xfail)\s*\(|\bself\.skipTest\s*\(|\braise\s+(unittest\.)?SkipTest\b/,
  jvm: /@(Disabled|Ignore|DisabledIf\w*|Ignored)\b|\bAssumptions\.assume\w*\s*\(\s*false|\bassumeTrue\s*\(\s*false|@Test\s*\(\s*enabled\s*=\s*false/,
  go: /\bt\.(Skip|SkipNow|Skipf)\s*\(/,
  rust: /#\[\s*ignore\b/,
  cs: /\[\s*Ignore\b|\bSkip\s*=\s*"|\[\s*Fact\s*\(\s*Skip|\[\s*Theory\s*\(\s*Skip|Assert\.Inconclusive\s*\(/,
  // A bare skip or pending, or one given a message or a block. "pending = ..." is a local variable.
  rb: /^\s*(skip|pending)(?=\s*$|\s*\(?\s*['"]|\s+do\b)|\bxit\b|\bxdescribe\b|\bxcontext\b/,
};

// By language: "model.fit(" is not fit( and "{ focus: true }" is only metadata in RSpec.
const FOCUS = {
  js: /\b(it|test|describe|context|suite)\.only\s*\(|(?<![.\w$])f(it|describe|context)\s*\(/,
  py: /@pytest\.mark\.only\b/,
  rb: /^\s*(it|describe|context|specify)\b.*,\s*focus:\s*true|^\s*f(it|describe|context)\b/,
};

// Lines that open a test, for the rule that notices a test being unregistered. @Test and
// @ParameterizedTest (and [Fact] and [Theory]) are interchangeable, so swapping them is fine.
const TEST_HEADER = /^\s*(@(Test|ParameterizedTest|RepeatedTest|TestFactory)\b|#\[\s*(tokio::)?test\b|\[\s*(Fact|Theory|Test|TestMethod|TestCase|TestCaseSource)\b|(async\s+)?def\s+test_\w*\s*\(|func\s+Test[A-Z_]\w*\s*\(\s*\w+\s+\*testing\.T|(it|test|specify)(\.\w+)?\s*\(\s*['"`]|(it|test|describe)(\.(only|skip|concurrent))?\.each\s*[(`])/;

const RELATIVE_IMPORT = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]|from\s+['"](\.{1,2}\/[^'"]+)['"]/;
// "legacy.test.js", "test_legacy.py", "legacy_test.go" and "LegacyTests.cs" all test "legacy".
const stemOf = (name) => name.replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/i, '').replace(/^test_/i, '').replace(/_(test|spec)$/i, '').replace(/(Tests?)$/, '').toLowerCase();

const SUITE_REG = /\b(loadTestsFromTestCase|loadTestsFromName|loadTestsFromModule|makeSuite|addTests?)\s*\(\s*(loader\.\w+\s*\(\s*)?([\w.]+)/;
const CONDITIONAL_SKIP_ALIAS = /=[^;]*\?[^;]*\b(it|test|describe)\.skip\b(?!\s*\()/;

// "const itPosix = cond ? it.skip : it" makes itPosix a test header of its own.
const TEST_ALIAS = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*\b(?:it|test)\b(?:\.(?:skip|only|concurrent))?/;

// A table or parameterize construct. A file that adds one has folded several asserts into a loop.
const TABLE = /\bfor\s*\(|\bfor\s+[\w\[({]|\brange\b|\.(each|forEach)\b|@pytest\.mark\.parametrize|@ParameterizedTest|\[\s*(Theory|InlineData|TestCase|DataRow)\b|\bt\.Run\s*\(/;

// Comparing against a boolean literal is assertTrue under another name, so simplifying it is fine.
const BOOL_COMPARE = /\b(assertEquals?|Assert\.(AreEqual|Equal)|assert\.Equal|require\.Equal)\s*\(\s*(t\s*,\s*)?(true|false|True|False)\s*,|,\s*(true|false|True|False)\s*\)\s*;?\s*$|==\s*(True|False|true|false)\b|\bis\s+(True|False)\b/;

const RUST_TEST = /#\[\s*(cfg\s*\(\s*test\s*\)|test\b|tokio::test)/;

const STRONG = /\.(toBe|toEqual|toStrictEqual|toMatchObject|toMatch|toThrow\w*|toHaveBeenCalledWith|toContain|toHaveProperty|toMatchInlineSnapshot)\s*\(|\bassert(Equal|Equals|Same|StrictEqual|DeepEqual|DeepStrictEqual|ArrayEquals|Raises|Throws|That|Is|In|Regex|AlmostEqual|CountEqual|DictEqual|ListEqual)\b|\bassert\s+[^,\n]*?(==|!=|\bin\b|\bis\b|<|>)|\bassert_eq!|\bassert_ne!|\bAssert\.(AreEqual|Equal|Throws|Same)\b|\bassert\.(Equal|EqualValues|ErrorIs|Exactly)\b|\brequire\.(Equal|EqualValues|ErrorIs)\b|\bt\.Errorf?\s*\(|\bisEqualTo\s*\(|\bassert\.(equal|strictEqual|deepEqual|deepStrictEqual|notEqual|notStrictEqual|throws|rejects|match|doesNotMatch)\s*\(|\bassert_(equal|raises|match|includes|in_delta|same)\b|\.to\s+(eq|eql|equal|match|raise_error|include|contain_exactly)\b|\.Should\(\)\.(Be|Equal|BeEquivalentTo|Throw)\b|\bassert!\s*\(.*(==|!=)/;

const WEAK = /\.(toBeDefined|toBeTruthy|toBeFalsy|not\.toBeNull|not\.toBeUndefined|toBeInstanceOf|toHaveLength|toBeGreaterThanOrEqual)\s*\(|\.not\.toThrow\s*\(|\bassert(NotNull|IsNotNone|IsNotNull|True|IsInstance|Nonnull)\b|\bassert\s+\w[\w.\[\]'"]*\s*(?:$|#|,)|\bassert\s+.+\s+is\s+not\s+None\b|\bAssert\.(IsNotNull|NotNull|IsTrue|True)\b|\bassert\.(NotNil|True|NotEmpty)\b|\brequire\.(NotNil|True|NotEmpty)\b|\bisNotNull\s*\(|\bassert\.ok\s*\(|\bassert\s*\(\s*[\w.\[\]]+\s*\)|\bexpect\.(any|anything)\s*\(|\.toBeGreaterThan\s*\(\s*-?[01]\s*\)|\bassert!\s*\((?!.*(==|!=))|\.(to|not_to|to_not)\s+(be_truthy|be_nil|be_present|be_a|be_kind_of|be_an_instance_of)\b|\.Should\(\)\.(NotBeNull|BeTrue|NotBeEmpty)\b|\b(assert|refute)_(nil|empty|respond_to|kind_of|instance_of)\b|\bassert\s+true\b/;

// Kept as separate patterns so each back-reference points at its own group.
const TAUTOLOGY = [
  /\bexpect\s*\(\s*(true|false|null|undefined|1|0|'[^']*'|"[^"]*")\s*\)\s*\.\s*(toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/,
  /\bassert\s+True\b|\bassert\s+1\s*==\s*1\b|\bassert\s+not\s+False\b|\bself\.assertTrue\s*\(\s*True\s*\)|\bassertTrue\s*\(\s*true\s*\)|\bAssert\.(IsTrue|True)\s*\(\s*true\s*\)|\bassert!\s*\(\s*true\s*\)|\bassert\.True\s*\(\s*t\s*,\s*true\s*\)|\bexpect\s*\(\s*true\s*\)\.toBeTruthy\s*\(\s*\)|\bassert\.ok\s*\(\s*true\s*\)/,
  /\bassert\s*\(\s*true\s*\)/,
  /\bassert\.(equal|strictEqual)\s*\(\s*(true|1)\s*,\s*\2\s*\)/,
  /\bexpect\s*\(\s*([\w.$]+)\s*\)\s*\.\s*(toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/,
  /\b(?:assertEquals?|Assert\.(?:AreEqual|Equal)|assert_eq!|assert\.(?:equal|strictEqual|deepEqual))\s*\(\s*([\w.]+|"[^"]*"|'[^']*')\s*,\s*\1\s*[,)]/,
  /\bassert\s+true\b/,
  /\bassert_equal\s+([^\s,]+)\s*,\s*\1\s*$/,
];

const TEST_DETECTION = /process\.env\.(NODE_ENV|BABEL_ENV)\s*[!=]==?\s*['"`]test['"`]|['"`]test['"`]\s*[!=]==?\s*process\.env\.NODE_ENV|process\.env\.(JEST_WORKER_ID|VITEST|VITEST_WORKER_ID|MOCHA|CI_TEST|PLAYWRIGHT_TEST)|import\.meta\.vitest\b|['"]pytest['"]\s+in\s+sys\.modules|['"]unittest['"]\s+in\s+sys\.modules|PYTEST_CURRENT_TEST|sys\._called_from_test|\btesting\.Testing\s*\(\s*\)|\bflag\.Lookup\s*\(\s*"test\.v"\s*\)|strings\.HasSuffix\s*\(\s*os\.Args\[0\]\s*,\s*"\.test"\s*\)|Class\.forName\s*\(\s*"org\.junit|\bisRunningUnderTest\b|\bisRunningInTest\b|\bIS_TEST(ING)?\b|Rails\.env\.test\?|ENV\[['"]RAILS_ENV['"]\]\s*==\s*['"]test['"]|\bcfg!\s*\(\s*test\s*\)|typeof\s+(jest|vitest|describe|it|mocha|jasmine)\s*[!=]==?\s*['"](undefined|function)|\b(os\.environ(\.get)?|os\.getenv)\s*[\(\[]\s*['"](TESTING|TEST|IS_TEST|PYTEST\w*)['"]|GetAssemblies\(\).*([xX][uU]nit|[nN][uU]nit|MSTest)|Environment\.GetEnvironmentVariable\s*\(\s*"(\w*TEST\w*)"/;
// Config modules pick a test database on NODE_ENV all the time, so a hit there is softer.
const CONFIG_PATH = /(^|\/)(config|settings|env|environments?)(\/|\.[cm]?[jt]s$|\.py$|\.rb$)|knexfile|settings\.py$/;
const TEST_INFRA = ['/test-utils', '/testing/', 'jest.setup', 'vitest.setup', 'setupTests'];

// A bare "test" only counts as a word of its own: "test-db" and "./test/" are not the runner.
const RUNNER = /\b(jest|vitest|mocha|pytest|unittest|tox|nox|go\s+test|cargo\s+test|gradle\w*\s+\w*test|mvn\s+\w*\s*test|rspec|dotnet\s+test|npm\s+(run\s+)?test|yarn\s+test|pnpm\s+test|make\s+(test|check)|ctest|phpunit)\b|(?<![-\w./])tests?(?![-\w./])|"test(:[\w-]+)?"\s*:/i;
// "|| :" is written with a lookahead because \b never matches after a colon.
const NEUTER = /\|\|\s*(?:(?:true|exit\s+0)\b|:(?!\w))|;\s*(true|exit\s+0)\s*$|--passWithNoTests|--pass-with-no-tests|--no-tests\b|exit\s+0|--testPathIgnorePatterns|--deselect\b|-k\s+['"]?not\s|--ignore[= ]\S*test|-DskipTests|-Dmaven\.test\.skip=true|-x\s+test\b|--exclude-task\s+test\b|--skip\s+\S*test|\becho\s+['"]?(ok|pass|passed|tests? passed)|(^|\s)-skip[= ]\S+|--filter\s+['"]?[^'"]*!(~|=)|-Dtest=['"]?!|--tag\s+~|process\.exit\(\s*0\s*\)/i;
const TEST_SCRIPT = /^\s*"test"\s*:/;
// An empty script, or one that only echoes. An echo followed by && or ; still runs something after it.
const NEUTERED_SCRIPT = /^\s*"test"\s*:\s*"\s*(echo(?:\\.|(?!&&|;|\|)[^"\\])*|exit 0|true|:)?\s*"/i;
// Only ignore settings that name something test-shaped count (jest's testPathIgnorePatterns is judged by ignoresRealDirs): the Next.js .next/ ignore, flake8's
// --ignore=E203 and norecursedirs = .git .venv are ordinary config.
const BUILD_NEUTER = /ignoreFailures\s*=\s*true|testFailureIgnore\s*[>=]\s*['"]?true|<skipTests>\s*true|<maven\.test\.skip>\s*true|\bnorecursedirs\s*=.*\b(tests?|spec)\b|\b(pytest|py\.test)\b.*--ignore=\S*(test|spec)|collect_ignore\b|addopts\s*=.*(--deselect|-k\s+['"]?not\s|--ignore)/;

// -diff, binary and -text really hide content. linguist-generated only collapses it on GitHub, and
// is an honest thing to say about protobuf output, so it is HARD only for tests and snapshots.
// jest's own defaults and Next.js's .next/ are in testPathIgnorePatterns on purpose.
const OUTPUT_DIRS = new Set(['node_modules', '.next', '.nuxt', '.output', 'dist', 'build', 'coverage', '.cache', 'out', '.git']);
function ignoresRealDirs(text) {
  const m = /"?testPathIgnorePatterns"?\s*:(.*)/.exec(text);
  if (!m) return false;
  const pats = m[1].match(/'[^']*'|"[^"]*"|`[^`]*`/g);
  if (!pats) return true;
  return pats.some(p => !OUTPUT_DIRS.has(p.slice(1, -1).replace(/^<rootDir>\/?/, '').replace(/^\/+|\/+$/g, '')));
}

const HIDE_ATTR = /(\s|^)(-diff|binary|-text)\b/;
const MEDIA_EXT = /^(png|jpe?g|gif|svg|ico|webp|bmp|woff2?|ttf|otf|eot|mp3|mp4|wav|ogg|webm|mov|avi|pdf)$/i;
const HIDE_GENERATED =/(\s|^)linguist-(generated|vendored)(=true|(?![=\w-]))/;

const SUPPRESSION = /@ts-(ignore|expect-error|nocheck)\b|eslint-disable|#\s*type:\s*ignore|#\s*noqa\b|#\s*pylint:\s*disable|#\s*pyright:\s*ignore|@SuppressWarnings\s*\(|#\[\s*allow\s*\(|\/\/\s*nolint\b|#pragma\s+warning\s+disable|\/\/\s*@ts-|rubocop:disable|istanbul\s+ignore|c8\s+ignore|pragma:\s*no\s+cover/;

const CATCH_EMPTY = /\bcatch\s*(\([^)]*\))?\s*\{\s*\}/;
const CATCH_OPEN = /\bcatch\s*(\([^)]*\))?\s*\{\s*$/;
const EXCEPT_PASS = /^\s*except\b[^:]*:\s*(pass|\.\.\.)\s*$/;
const EXCEPT_OPEN = /^\s*except\b[^:]*:\s*$/;
const PROMISE_CATCH = /\.catch\s*\(\s*\(\s*\w*\s*\)\s*=>\s*(\{\s*\}|null|undefined)\s*\)/;
const GO_DISCARD = /^\s*_\s*=\s*err\s*$/;

const STUB = /throw\s+new\s+Error\s*\(\s*['"`](not\s+implemented|todo|unimplemented)|raise\s+NotImplementedError|\btodo!\s*\(|\bunimplemented!\s*\(|UnsupportedOperationException|NotImplementedException|panic\s*\(\s*"(not\s+implemented|todo|unimplemented)/i;

const FLAKE = /\bjest\.retryTimes\s*\(|\bthis\.retries\s*\(|\bretries\s*:\s*(?:[^,\n]*[?:]\s*)?[1-9]|\b(assert|require)\.(Eventually|EventuallyWithT|Never)\w*\s*\(.*\b\d+\s*\*\s*time\.(Minute|Hour)\b|@pytest\.mark\.flaky\b|--reruns\b|@RetryingTest\b|@Retry\b|\bjest\.setTimeout\s*\(|\bthis\.timeout\s*\(|@pytest\.mark\.timeout\s*\(|@Timeout\s*\(|\btestTimeout\s*:|\btimeout\s*:\s*\d[\d_]{4,}/;

// Go durations such as 2*time.Second, in nanoseconds.
const GO_DURATION = /(\d+)\s*\*\s*time\.(Millisecond|Second|Minute|Hour)\b/g;
const GO_UNIT = { Millisecond: 1e6, Second: 1e9, Minute: 6e10, Hour: 3.6e12 };
const goDurations = (t) => [...t.matchAll(GO_DURATION)].map(m => Number(m[1]) * GO_UNIT[m[2]]);
const withoutDurations = (t) => t.replace(GO_DURATION, 'D').replace(/\s+/g, ' ').trim();

const TODO = /\b(TODO|FIXME|XXX|HACK)\b/;

// ---- shared helpers -------------------------------------------------------------------------

const indentOf = (t) => /^\s*/.exec(t)[0].length;
const LIST_ITEM = /^\s*-\s+\S/;
const CI_NAME = /^\s*(-\s+)?name\s*:/;

// The workflow step that owns added line `a`, as new-file lines of its hunk. A step starts at the
// nearest "- key:" line at or above the owner's indent and runs to the next sibling.
function stepOf(f, a) {
  const lines = hunkLines(f, a).filter(l => l.newLine != null);
  const i = lines.findIndex(l => l.kind === '+' && l.newLine === a.line);
  if (i < 0) return [];
  const ind = indentOf(lines[i].text);
  let s = i;
  while (s > 0 && !(LIST_ITEM.test(lines[s].text) && (s === i || indentOf(lines[s].text) < ind))) s--;
  const startIndent = LIST_ITEM.test(lines[s].text) ? indentOf(lines[s].text) : -1;
  let e = i + 1;
  while (e < lines.length && !(LIST_ITEM.test(lines[e].text) && indentOf(lines[e].text) <= startIndent)) e++;
  return lines.slice(s, e);
}

// Does a runner appear in a "run:" value or in the body of a "run: |" block of these step lines?
function stepRuns(step) {
  let keyCol = -1;
  for (const l of step) {
    if (isCommentLine(l.text)) continue;
    const m = /^(\s*(?:-\s+)?)run\s*:\s*(.*)$/.exec(l.text);
    if (CI_NAME.test(l.text)) {
      // A step called "Run tests" is a test step even when its command is a script.
      if (RUNNER.test(l.text)) return true;
    } else if (m) {
      keyCol = m[1].length;
      if (RUNNER.test(m[2])) return true;
    } else if (keyCol >= 0 && indentOf(l.text) >= keyCol + 1) {
      if (RUNNER.test(l.text)) return true;
    } else {
      keyCol = -1;
    }
  }
  return false;
}

// Added "continue-on-error: true" lines in CI files, and whether the step they sit in runs the
// tests. test-command-neutered reports the ones in a test step, ci-failure-ignored the rest.
function ciContinueOnError(f) {
  const out = [];
  const p = f.newPath;
  if (p == null || !isCiPath(p)) return out;
  for (const a of f.added) {
    if (isCommentLine(a.text) || !/continue-on-error\s*:\s*true/.test(a.text)) continue;
    out.push({ a, near: stepRuns(stepOf(f, a)) });
  }
  return out;
}

// A deleted or moved test line can be matched against an added one with other names for things.
const IDENT = /(?<![.\w$])[A-Za-z_$][\w$]*\b(?!\s*\()/g;
const normalised = (t) => t.trim().replace(IDENT, 'I').replace(/\s+/g, ' ');

// The lines of `f` the assertion rules may judge: all of them in a test file, and in a Rust source
// file only the hunks that sit next to #[test] or #[cfg(test)]. Null when none.
function testScope(ctx, f) {
  if (fileIsTest(ctx, f)) return { hunks: f.hunks, removed: f.removed, added: f.added };
  if (language(pathOf(f)) !== 'rust') return null;
  const keep = new Set();
  f.hunks.forEach((h, i) => { if (h.lines.some(l => RUST_TEST.test(l.text))) keep.add(i); });
  if (!keep.size) return null;
  return {
    hunks: f.hunks.filter((h, i) => keep.has(i)),
    removed: f.removed.filter(r => keep.has(r.hunk)),
    added: f.added.filter(a => keep.has(a.hunk)),
  };
}

const CONDITIONAL_OPENER = /^\s*(\}\s*)?(if|unless|elif|else\s+if)\b/;
const ATTRIBUTE_LINE = /^\s*(@|#\[|\[)/;
const FN_HEADER = /^\s*(?:(?:pub\s+)?(?:async\s+)?fn\s+(\w+)|func\s+(Test\w*)|(?:async\s+)?def\s+(test\w*)|(?:public\s+|private\s+|protected\s+)?(?:static\s+)?void\s+(\w+))/;

// Is the skip marker `a` inside an "if", or does it belong to a test that this same change adds?
// Either way it does not switch off a test that was running before.
function skipIsHarmless(f, a) {
  if (f.status === 'added') return true;
  const lines = hunkLines(f, a).filter(l => l.newLine != null);
  const i = lines.findIndex(l => l.kind === '+' && l.newLine === a.line);
  if (i < 0) return false;
  for (let j = i - 1; j >= 0; j--) {
    if (!lines[j].text.trim() || isCommentLine(lines[j].text)) continue;
    if (CONDITIONAL_OPENER.test(lines[j].text)) return true;
    break;
  }
  // The header the marker belongs to: below an attribute, above a statement in a body. A marker
  // that is itself the header (it.skip('a', ...)) belongs to no other line.
  const attr = ATTRIBUTE_LINE.test(a.text);
  const near = attr ? lines.slice(i + 1, i + 5) : lines.slice(Math.max(0, i - 12), i).reverse();
  for (const l of near) {
    const m = FN_HEADER.exec(l.text);
    if (!m) continue;
    if (l.kind !== '+') return false;
    const name = m[1] ?? m[2] ?? m[3] ?? m[4];
    const word = new RegExp(`\\b${name}\\b`);
    return !hunkLines(f, a).some(x => x.kind === '-' && word.test(x.text));
  }
  return false;
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
    // Sources deleted in this same change (a moved implementation is "renamed", so it is not here).
    const goneSources = ctx.files.filter(g => g.status === 'deleted' && g.oldPath != null && !ctx.isTest(g.oldPath)).map(g => g.oldPath);
    const modKey = (p) => p.replace(/\.[^./]+$/, '').replace(/\/index$/, '');
    const goneKeys = new Set(goneSources.map(modKey));
    const goneStems = new Set(goneSources.map(p => stemOf(baseName(p))));
    const testsDeletedSource = (f) => {
      if (stemOf(baseName(f.oldPath)) && goneStems.has(stemOf(baseName(f.oldPath)))) return true;
      const dir = f.oldPath.split('/').slice(0, -1);
      return f.removed.some(r => {
        const m = RELATIVE_IMPORT.exec(r.text);
        if (!m) return false;
        const parts = [...dir];
        for (const seg of (m[1] ?? m[2]).split('/')) {
          if (seg === '..') parts.pop();
          else if (seg !== '.') parts.push(seg);
        }
        return goneKeys.has(modKey(parts.join('/')));
      });
    };
    for (const f of ctx.files) {
      if (f.oldPath == null || !ctx.isTest(f.oldPath) || isSnapshotPath(f.oldPath)) continue;
      const gone = f.status === 'deleted' || (f.status === 'renamed' && f.newPath != null && !ctx.isTest(f.newPath));
      if (!gone) continue;
      // A fixture, an empty __init__.py or a helper under tests/ is not a test that stopped running.
      const testy = (r) => isAssertLine(r.text) || TEST_HEADER.test(r.text);
      const softer = language(f.oldPath) === 'other'
        || (f.status === 'deleted' && !f.binary && !f.removed.some(testy))
        || (f.status === 'deleted' && testsDeletedSource(f));
      add(f.oldPath, 0, f.oldPath, null, undefined, softer);
    }
  }),

  defineRule({
    id: 'test-skipped', tier: 'HARD', title: 'Test switched off',
    why: 'A test was switched off instead of fixed.',
  }, (ctx, add) => {
    for (const { f, a, p } of addedLines(ctx, () => true)) {
      const lang = language(p);
      let hit;
      if (lang === 'rust') hit = SKIP.rust.test(a.text);
      else if (!ctx.isTest(p)) continue;
      else if (lang === 'other') hit = Object.values(SKIP).some(r => r.test(a.text));
      else hit = SKIP[lang].test(a.text);
      if (hit) add(p, a.line, null, a.text, undefined, skipIsHarmless(f, a) || (lang === 'js' && CONDITIONAL_SKIP_ALIAS.test(a.text)));
    }
  }),

  defineRule({
    id: 'test-focused', tier: 'HARD', title: 'Test marked as the only one',
    why: 'A test was marked as the only one to run, which silently skips every other test.',
  }, (ctx, add) => {
    for (const { a, p } of addedLines(ctx, ctx.isTest)) if (FOCUS[language(p)]?.test(a.text)) add(p, a.line, null, a.text);
  }),

  defineRule({
    id: 'assertion-removed', tier: 'HARD', title: 'Assertions removed',
    why: 'Assertions were removed from a test and not replaced, so the test checks less than it did.',
  }, (ctx, add) => {
    // Added asserts by file, so one that moved to a helper elsewhere (with other names for things) is not lost.
    const elsewhere = new Map();
    for (const g of ctx.files) {
      for (const a of g.added) {
        if (!isAssertLine(a.text)) continue;
        const key = normalised(a.text);
        if (!elsewhere.has(key)) elsewhere.set(key, []);
        elsewhere.get(key).push(g);
      }
    }
    const movedAway = (f, r) => {
      const owners = elsewhere.get(normalised(r.text)) ?? [];
      const i = owners.findIndex(g => g !== f);
      if (i < 0) return false;
      owners.splice(i, 1);
      return true;
    };
    for (const f of ctx.files) {
      if (f.status === 'deleted') continue;
      const scope = testScope(ctx, f);
      if (!scope) continue;
      const removed = scope.removed.filter(r => isAssertLine(r.text) && !ctx.allAddedTrimmed.has(r.text.trim()) && !movedAway(f, r));
      const added = scope.added.filter(a => isAssertLine(a.text));
      if (removed.length > added.length) {
        // Several literal asserts folded into a table or a parameterized test look like removals.
        const table = scope.added.some(a => !isCommentLine(a.text) && TABLE.test(a.text));
        for (const r of removed.slice(0, 10)) add(pathOf(f), r.line, r.text, null, undefined, table);
      }
    }
  }),

  defineRule({
    id: 'assertion-weakened', tier: 'HARD', title: 'Assertion loosened',
    why: 'A precise assertion was swapped for a looser one that passes for almost any value.',
  }, (ctx, add) => {
    for (const f of ctx.files) {
      const scope = testScope(ctx, f);
      if (!scope) continue;
      for (const h of scope.hunks) {
        const code = (kind) => h.lines.filter(l => l.kind === kind && !isCommentLine(l.text));
        const removedStrong = code('-').filter(l => STRONG.test(l.text) && !BOOL_COMPARE.test(l.text));
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
    for (const f of ctx.files) {
      if (f.newPath == null) continue;
      const scope = ctx.isTest(f.newPath) ? { added: f.added } : testScope(ctx, f);
      for (const a of scope?.added ?? []) {
        if (!isCommentLine(a.text) && TAUTOLOGY.some(r => r.test(a.text))) add(f.newPath, a.line, null, a.text);
      }
    }
  }),

  defineRule({
    id: 'test-detection', tier: 'HARD', title: 'Code checks if it runs under test',
    why: 'Production code now checks whether it is running under a test, which is how code fakes a pass.',
  }, (ctx, add) => {
    const pathOk = (p) => isSourceFile(ctx, p) && !isBuildPath(p) && !isCiPath(p)
      && !TEST_INFRA.some(s => ('/' + p).includes(s));
    for (const { a, p } of addedLines(ctx, pathOk)) {
      if (TEST_DETECTION.test(a.text)) add(p, a.line, null, a.text, undefined, CONFIG_PATH.test(p));
    }
  }),

  defineRule({
    id: 'test-command-neutered', tier: 'HARD', title: 'Test command defanged',
    why: 'The command that runs the tests was changed so failures no longer fail the build.',
  }, (ctx, add) => {
    // Runner lines taken out of CI files, and runner lines put into CI files. A step that moved to
    // another workflow adds as many as it removes.
    const runLine = (t) => !isCommentLine(t) && !CI_NAME.test(t) && RUNNER.test(t);
    const ciRemoved = [];
    let ciAdded = 0;
    for (const f of ctx.files) {
      const p = pathOf(f);
      const build = isBuildPath(p);
      const ci = isCiPath(p);
      if (!build && !ci) continue;
      const pkg = baseName(p) === 'package.json';
      for (const a of f.added) {
        if (isCommentLine(a.text)) continue;
        if (RUNNER.test(a.text) && NEUTER.test(a.text)) add(p, a.line, null, a.text);
        if (pkg && NEUTERED_SCRIPT.test(a.text)) add(p, a.line, null, a.text);
        if (build && (BUILD_NEUTER.test(a.text) || ignoresRealDirs(a.text))) add(p, a.line, null, a.text);
        if (ci && /^\s*(-\s+)?if\s*:\s*(false|\$\{\{\s*false\s*\}\})\s*$/.test(a.text) && stepRuns(stepOf(f, a))) {
          add(p, a.line, null, a.text);
        }
      }
      if (pkg && !f.added.some(a => TEST_SCRIPT.test(a.text))) {
        for (const r of f.removed) if (TEST_SCRIPT.test(r.text)) add(p, r.line, r.text, null);
      }
      if (ci) {
        ciAdded += f.added.filter(a => runLine(a.text)).length;
        for (const r of f.removed) if (runLine(r.text)) ciRemoved.push({ p, r });
      }
      for (const { a, near } of ciContinueOnError(f)) if (near) add(p, a.line, null, a.text);
    }
    if (ciRemoved.length > ciAdded) for (const { p, r } of ciRemoved.slice(0, 10)) add(p, r.line, r.text, null);
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
        // Any glob can cover tests or snapshots, except images, fonts and media that cannot hold either.
        const ext = /\.([A-Za-z0-9]+)$/.exec(token);
        return !ext || !MEDIA_EXT.test(ext[1]);
      }
      return language(token) !== 'other';
    };
    // Patterns start with '*' here, which the shared comment check would swallow; only '#' is a comment.
    for (const { a, p } of addedLines(ctx, (p) => baseName(p) === '.gitattributes', { comments: true })) {
      if (a.text.trim().startsWith('#')) continue;
      const hides = HIDE_ATTR.test(a.text);
      if (!hides && !HIDE_GENERATED.test(a.text)) continue;
      const token = a.text.trim().split(/\s+/)[0];
      if (!couldCover(token)) continue;
      const aimedAtTests = /test|spec/i.test(token) || isSnapshotPath(token.replace(/\*+/g, 'x'));
      add(p, a.line, null, a.text, undefined, !hides && !aimedAtTests);
    }
  }),

  defineRule({
    id: 'test-unregistered', tier: 'HARD', title: 'Test no longer registered',
    why: 'A test lost its annotation or its test name, so the runner no longer finds it and it silently stops running.',
  }, (ctx, add) => {
    // Explicit suite registration (unittest's loadTestsFromTestCase and friends) is a header too.
    const anyAdded = (re) => ctx.files.some(g => g.added.some(a => !isCommentLine(a.text) && re.test(a.text)));
    const discovers = anyAdded(/\bdiscover\s*\(|\bunittest\.main\s*\(/);
    const addsOtherReg = anyAdded(SUITE_REG);
    for (const f of ctx.files) {
      if (f.status === 'deleted' || !fileIsTest(ctx, f)) continue;
      for (const r of f.removed) {
        const m = !isCommentLine(r.text) && SUITE_REG.exec(r.text);
        if (!m) continue;
        const name = m[3];
        const word = new RegExp(`(?<![\\w.])${name.replace(/[.$]/g, '\\$&')}\\b`);
        if (anyAdded(word) || discovers) continue;
        const classGone = ctx.files.some(g => g.status === 'deleted' && g.removed.some(x => new RegExp(`\\bclass\\s+${name.split('.').pop()}\\b`).test(x.text)));
        if (classGone) continue;
        add(pathOf(f), r.line, r.text, null, undefined, addsOtherReg);
      }
    }
    const aliases = [];
    for (const f of ctx.files) {
      for (const a of f.added) {
        const m = !isCommentLine(a.text) && TEST_ALIAS.exec(a.text);
        if (m) aliases.push(m[1].replace(/\$/g, '\\$'));
      }
    }
    const aliasCall = aliases.length
      ? new RegExp(`^\\s*(${aliases.join('|')})(\\.\\w+)?\\s*\\(\\s*['"\`]`)
      : null;
    const header = (t) => !isCommentLine(t) && (TEST_HEADER.test(t) || (aliasCall?.test(t) ?? false));
    const per = [];
    let removedTotal = 0;
    let addedTotal = 0;
    for (const f of ctx.files) {
      const addedH = f.added.filter(a => header(a.text)).length;
      addedTotal += addedH;
      if (f.status === 'deleted' || !(fileIsTest(ctx, f) || language(pathOf(f)) === 'rust')) continue;
      const removedH = f.removed.filter(r => header(r.text));
      removedTotal += removedH.length;
      per.push({ f, removedH, addedH });
    }
    // A header that moved to another file is not lost; only report when the diff as a whole loses some.
    if (removedTotal <= addedTotal) return;
    for (const { f, removedH, addedH } of per) {
      if (removedH.length <= addedH) continue;
      // Two tests merged into one also lose a header, so a file that adds one is only a SOFT finding.
      for (const r of removedH.slice(0, 10)) add(pathOf(f), r.line, r.text, null, undefined, addedH > 0);
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
    const flagged = new Set();
    for (const { a, p } of addedLines(ctx, (p) => ctx.isTest(p) || isBuildPath(p))) {
      if (FLAKE.test(a.text)) { flagged.add(a); add(p, a.line, null, a.text); }
    }
    // A Go duration in a test that got longer: the same line with only the duration changed.
    for (const f of ctx.files) {
      if (f.newPath == null || !ctx.isTest(f.newPath) || language(f.newPath) !== 'go') continue;
      for (const h of f.hunks) {
        const rem = h.lines.filter(l => l.kind === '-' && !isCommentLine(l.text) && goDurations(l.text).length);
        for (const a of h.lines.filter(l => l.kind === '+' && !isCommentLine(l.text) && goDurations(l.text).length)) {
          const old = rem.find(x => withoutDurations(x.text) === withoutDurations(a.text));
          if (!old) continue;
          const [was, now] = [goDurations(old.text), goDurations(a.text)];
          if (now.some((d, i) => d > (was[i] ?? Infinity)) && !f.added.some(x => flagged.has(x) && x.line === a.newLine)) {
            add(f.newPath, a.newLine, old.text, a.text);
          }
        }
      }
    }
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
