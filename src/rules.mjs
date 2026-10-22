// The cheating rules. Each rule is { id, tier, title, why, check(ctx) -> Finding[] }.
// ctx is built by scan.mjs: { files, config, source, isTest(p), allAddedTrimmed, truncated }.

import {
  isSourcePath, isSnapshotPath, isCiPath, isBuildPath, language, ASSERT, isCommentLine,
} from './classify.mjs';
import {
  splitTop, closeOf, moveKey, looseMoveKey, dropMessage, declarationsOn, sourceIndex, testContext, modKey, subjectRefs, removedWithFeature,
} from './symbols.mjs';
import { MAX_DIFF_LINES } from './diff.mjs';

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
// An import of an assertion library names Assertions.assertThat without asserting anything.
const IMPORT_LINE = /^\s*(?:(?:import|using)\b|from\s+\S+\s+import\b|require\s*\()/;
const isAssertLine = (t) => !isCommentLine(t) && !IMPORT_LINE.test(t) && ASSERT.test(t);
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
function nextCodeLine(f, a, skip = 0) {
  const lines = hunkLines(f, a);
  const idx = lines.findIndex(l => l.kind === '+' && l.newLine === a.line);
  if (idx < 0) return null;
  for (let j = idx + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.newLine == null) continue;
    if (!l.text.trim() || isCommentLine(l.text)) continue;
    if (skip-- > 0) continue;
    return l.text;
  }
  return null;
}

// ---- patterns -------------------------------------------------------------------------------

const SKIP = {
  // The second branch is an alias made of a skip ("const itX = it.skip"); a ternary there is only a conditional skip.
  js: /\b(it|test|describe|context|suite|specify)\.(skip|todo|fixme|fails|failing)\s*\(|=\s*[^;]*\b(it|test|describe)\.skip\b(?!\s*\()|\bx(it|test|describe|context|specify)\s*\(|\b(it|test|describe)\.skipIf\s*\(\s*(true|1)\b|\b(it|test|describe)\.skipIf\s*\(\s*process\.env\.(CI|GITHUB_ACTIONS|GITLAB_CI|CIRCLECI|TRAVIS|BUILDKITE|JENKINS_URL|TF_BUILD)\b|\bthis\.skip\s*\(|(?<![.\w$])pending\s*\(|\b(it|test|describe|suite)\s*\(\s*(?<q>['"`])(?:(?!\k<q>).)*\k<q>\s*,\s*\{[^}]*\b(skip|todo)\s*:\s*(true\b|['"`])/,
  py: /@pytest\.mark\.(skip|xfail)\b|^\s*pytestmark\s*=\s*\[?\s*pytest\.mark\.(skip|xfail)\b|@pytest\.mark\.skipif\s*\(\s*(True|1)\b|@unittest\.(skip|expectedFailure)\b|@unittest\.skipIf\s*\(\s*(True|1)\b|@unittest\.skipUnless\s*\(\s*(False|0)\b|\bpytest\.(skip|xfail)\s*\(|\bself\.skipTest\s*\(|\braise\s+(unittest\.)?SkipTest\b/,
  jvm: /@(Disabled|Ignore|DisabledIf\w*|Ignored)\b|\bAssumptions\.assume\w*\s*\(\s*false|\bassumeTrue\s*\(\s*false|@Test\s*\(\s*enabled\s*=\s*false|\bassumeTrue\s*\(\s*System\.getenv\s*\(\s*"(CI|GITHUB_ACTIONS|TF_BUILD|JENKINS_URL)"\s*\)\s*==\s*null|\bassumeFalse\s*\(\s*System\.getenv\s*\(\s*"(CI|GITHUB_ACTIONS|TF_BUILD|JENKINS_URL)"\s*\)\s*!=\s*null|^\s*if\s*\(\s*System\.getenv\s*\(\s*"(CI|GITHUB_ACTIONS)"\s*\)\s*!=\s*null\s*\)\s*\{?\s*return\s*;/,
  // PIt and XIt are ginkgo's pending markers.
  go: /\bt\.(Skip|SkipNow|Skipf)\s*\(|(?<![.\w])[PX](It|Describe|Context|When|Specify|Entry|DescribeTable|DescribeTableSubtree)\s*\(/,
  rust: /#\[\s*ignore\b/,
  cs: /\[\s*Ignore\b|\bSkip\s*=\s*"|\[\s*Fact\s*\(\s*Skip|\[\s*Theory\s*\(\s*Skip|Assert\.Inconclusive\s*\(|^\s*if\s*\(\s*(System\.)?Environment\.GetEnvironmentVariable\s*\(\s*"(CI|GITHUB_ACTIONS|TF_BUILD|JENKINS_URL)"\s*\)\s*(!=\s*null|is\s+not\s+null)\s*\)\s*\{?\s*return\s*;/,
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
const TEST_HEADER = /^\s*(@(Test|ParameterizedTest|RepeatedTest|TestFactory)\b|#\[\s*(tokio::)?test\b|\[\s*(Fact|Theory|Test|TestMethod|DataTestMethod|TestCase|TestCaseSource)\b|(async\s+)?def\s+test_\w*\s*\(|func\s+Test[A-Z_]\w*\s*\(\s*\w+\s+\*testing\.T|(it|test|specify)(\.\w+)?\s*\(\s*['"`]|(it|test|describe)(\.(only|skip|concurrent))?\.each\s*[(`])/;

const RELATIVE_IMPORT = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]|from\s+['"](\.{1,2}\/[^'"]+)['"]/;
// "legacy.test.js", "test_legacy.py", "legacy_test.go" and "LegacyTests.cs" all test "legacy".
const stemOf = (name) => name.replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/i, '').replace(/^test_/i, '').replace(/_(test|spec)$/i, '').replace(/(Tests?)$/, '').toLowerCase();

const SUITE_REG = /\b(loadTestsFromTestCase|loadTestsFromName|loadTestsFromModule|makeSuite|addTests?)\s*\(\s*(loader\.\w+\s*\(\s*)?([\w.]+)/;
const CONDITIONAL_SKIP_ALIAS = /=[^;]*\?[^;]*\b(it|test|describe)\.skip\b(?!\s*\()/;

// "const itPosix = cond ? it.skip : it" makes itPosix a test header of its own.
const TEST_ALIAS = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*\b(?:it|test)\b(?:\.(?:skip|only|concurrent))?/;

// A table or parameterize construct. A file that adds one has folded several asserts into a loop.
const TABLE = /\bfor\s*\(|\bfor\s+[\w\[({]|\brange\b|\.(each|forEach)\b|@pytest\.mark\.parametrize|@ParameterizedTest|\[\s*(Theory|InlineData|TestCase|DataRow)\b|\bt\.Run\s*\(|@(hypothesis\.)?given\s*\(|@(hypothesis\.)?example\s*\(|\bfc\.(assert|property|asyncProperty)\s*\(|\bproptest!\s*[({]|#\[\s*quickcheck\b|@Property\b|@ForAll\b|\b(quick|rapid)\.Check\s*\(/;

// Comparing against a boolean literal is assertTrue under another name, so simplifying it is fine.
const BOOL_COMPARE = /\b(assertEquals?|Assert\.(AreEqual|Equal)|assert\.Equal|require\.Equal)\s*\(\s*(t\s*,\s*)?(true|false|True|False)\s*,|,\s*(true|false|True|False)\s*\)\s*;?\s*$|==\s*(True|False|true|false)\b|\bis\s+(True|False)\b/;

const RUST_TEST = /#\[\s*(cfg\s*\(\s*test\s*\)|test\b|tokio::test)/;

const STRONG = /\.(toBe|toEqual|toStrictEqual|toMatchObject|toMatch|toThrow\w*|toHaveBeenCalledWith|toContain|toHaveProperty|toMatchInlineSnapshot)\s*\(|\bassert(Equal|Equals|Same|StrictEqual|DeepEqual|DeepStrictEqual|ArrayEquals|Raises|Throws|That|Is|In|Regex|AlmostEqual|CountEqual|DictEqual|ListEqual)\b|\bassert\s+[^,\n]*?(==|!=|\bin\b|\bis\b|<|>)|\bassert_eq!|\bassert_ne!|\bAssert\.(AreEqual|Equal|Throws|Same)\b|\bassert\.(Equal|EqualValues|ErrorIs|Exactly)\b|\brequire\.(Equal|EqualValues|ErrorIs)\b|\bt\.Errorf?\s*\(|\bisEqualTo\s*\(|\bassert\.(equal|strictEqual|deepEqual|deepStrictEqual|notEqual|notStrictEqual|throws|rejects|match|doesNotMatch)\s*\(|\bassert_(equal|raises|match|includes|in_delta|same)\b|\.to\s+(eq|eql|equal|match|raise_error|include|contain_exactly)\b|\.Should\(\)\.(Be|Equal|BeEquivalentTo|Throw)\b|\bassert!\s*\(.*(==|!=)/;

const WEAK = /\.(toBeDefined|toBeTruthy|toBeFalsy|not\.toBeNull|not\.toBeUndefined|toBeInstanceOf|toHaveLength|toBeGreaterThanOrEqual)\s*\(|\.not\.toThrow\s*\(|\bassert(NotNull|IsNotNone|IsNotNull|True|IsInstance|Nonnull)\b|\bassert\s+\w[\w.\[\]'"]*\s*(?:$|#|,)|\bassert\s+.+\s+is\s+not\s+None\b|\bAssert\.(IsNotNull|NotNull|IsTrue|True)\b|\bassert\.(NotNil|True|NotEmpty)\b|\brequire\.(NotNil|True|NotEmpty)\b|\bisNotNull\s*\(|\bassert\.ok\s*\(|\bassert\s*\(\s*[\w.\[\]]+\s*\)|\bexpect\.(any|anything)\s*\(|\.toBeGreaterThan\s*\(\s*-?[01]\s*\)|\bassert!\s*\((?!.*(==|!=))|\.(not_to|to_not)\s+be_nil\b|\.(to|not_to|to_not)\s+(be_truthy|be_present|be_a|be_kind_of|be_an_instance_of)\b|\.Should\(\)\.(NotBeNull|BeTrue|NotBeEmpty)\b|\brefute_(nil|empty)\b|\bassert_(respond_to|kind_of|instance_of)\b|\bassert\s+true\b/;

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
  /\b([\w.]+)\s+shouldBe\s+\1\s*$/,
  // A verify that accepts any number of calls, zero included.
  /\bTimes\.AtLeast\s*\(\s*0\s*\)|\bTimes\.Between\s*\(\s*0\s*,\s*int\.MaxValue|\bTimes\.AtMost\s*\(\s*int\.MaxValue\s*\)|\b(?:Mockito\.)?atLeast\s*\(\s*0\s*\)/,
];

const TEST_DETECTION = /process\.env\.(NODE_ENV|BABEL_ENV)\s*[!=]==?\s*['"`]test['"`]|['"`]test['"`]\s*[!=]==?\s*process\.env\.NODE_ENV|process\.env\.(JEST_WORKER_ID|VITEST|VITEST_WORKER_ID|MOCHA|CI_TEST|PLAYWRIGHT_TEST)|import\.meta\.vitest\b|['"]pytest['"]\s+in\s+sys\.modules|['"]unittest['"]\s+in\s+sys\.modules|PYTEST_CURRENT_TEST|sys\._called_from_test|\btesting\.Testing\s*\(\s*\)|\bflag\.Lookup\s*\(\s*"test\.v"\s*\)|strings\.HasSuffix\s*\(\s*os\.Args\[0\]\s*,\s*"\.test"\s*\)|Class\.forName\s*\(\s*"org\.junit|System\.getProperty\s*\(\s*"(surefire\.[\w.]+|basedir\.surefire|org\.gradle\.test\.worker|junit\.[\w.]+|idea\.test\.[\w.]+)"|\bisRunningUnderTest\b|\bisRunningInTest\b|\bIS_TEST(ING)?\b|Rails\.env\.test\?|ENV\[['"]RAILS_ENV['"]\]\s*==\s*['"]test['"]|\bcfg!\s*\(\s*test\s*\)|typeof\s+(jest|vitest|describe|it|mocha|jasmine)\s*[!=]==?\s*['"](undefined|function)|\b(os\.environ(\.get)?|os\.getenv)\s*[\(\[]\s*['"](TESTING|TEST|IS_TEST|PYTEST\w*)['"]|GetAssemblies\(\).*([xX][uU]nit|[nN][uU]nit|MSTest)|Environment\.GetEnvironmentVariable\s*\(\s*"(\w*TEST\w*)"/;
const CFG_NOT_TEST = /#\[\s*cfg\s*\(\s*not\s*\(\s*test\s*\)\s*\)\s*\]/;
const RUST_ITEM = /^\s*(pub\b|fn\b|use\b|mod\b|impl\b|struct\b|enum\b|const\b|static\b|type\b|trait\b|extern\b|#\[)/;
const CS_DEBUG_IF = /^\s*#\s*if\s+!?\s*DEBUG\b/;
const CS_DIRECTIVE_END = /^\s*#\s*(endif|else|elif)\b/;
const CS_EARLY_RETURN = /^\s*(if\s*\(.*\)\s*)?return\b/;
// Config modules pick a test database on NODE_ENV all the time, so a hit there is softer.
const CONFIG_PATH = /(^|\/)(config|settings|env|environments?)(\/|\.[cm]?[jt]s$|\.py$|\.rb$)|knexfile|settings\.py$/;
const TEST_INFRA = ['/test-utils', '/testing/', 'jest.setup', 'vitest.setup', 'setupTests'];

// A bare "test" only counts as a word of its own: "test-db" and "./test/" are not the runner.
const RUNNER = /\b(jest|vitest|mocha|pytest|unittest|tox|nox|go\s+test|cargo\s+test|gradle\w*\s+\w*test|mvn\s+\w*\s*test|rspec|dotnet\s+test|npm\s+(run\s+)?test|yarn\s+test|pnpm\s+test|make\s+(test|check)|ctest|phpunit)\b|(?<![-\w./])tests?(?![-\w./])|"test(:[\w-]+)?"\s*:/i;
// "|| :" is written with a lookahead because \b never matches after a colon.
const NEUTER = /\|\|\s*(?:(?:true|exit\s+0)\b|:(?!\w))|;\s*(true|exit\s+0)\s*$|--passWithNoTests|--pass-with-no-tests|--no-tests\b|exit\s+0|--deselect\b|-k\s+['"]?not\s|--ignore[= ]\S*test|-DskipTests|-Dmaven\.test\.skip=true|-x\s+test\b|--exclude-task\s+test\b|--skip\s+\S*test|\becho\s+['"]?(ok|pass|passed|tests? passed)|(^|\s)-skip[= ]\S+|--filter\s+['"]?[^'"]*!(~|=)|-Dtest=['"]?!|--tag\s+~|(^|\s)-run[= ]['"]?[^'"\s]*\[\^|process\.exit\(\s*0\s*\)/i;
const TEST_SCRIPT = /^\s*"test"\s*:/;
// An empty script, or one that only echoes. An echo followed by && or ; still runs something after it.
const NEUTERED_SCRIPT = /^\s*"test"\s*:\s*"\s*(echo(?:\\.|(?!&&|;|\|)[^"\\])*|exit 0|true|:)?\s*"/i;
// Only ignore settings that name something test-shaped count (jest's testPathIgnorePatterns is judged by ignoresRealDirs): the Next.js .next/ ignore, flake8's
// --ignore=E203 and norecursedirs = .git .venv are ordinary config.
const BUILD_NEUTER = /ignoreFailures\s*=\s*true|testFailureIgnore\s*[>=]\s*['"]?true|<skipTests>\s*true|<maven\.test\.skip>\s*true|\bnorecursedirs\s*=.*\b(tests?|spec)\b|\b(pytest|py\.test)\b.*--ignore=\S*(test|spec)|collect_ignore\b|addopts\s*=.*(--deselect|-k\s+['"]?not\s|--ignore)|--deselect\b|<VSTestTestCaseFilter>[^<]*!(~|=)|<TestCaseFilter>[^<]*!(~|=)/;

// mocha's --grep with --invert, or .mocharc "invert": true, runs everything except what matches. Splitting
// off a tier such as integration or slow is ordinary; naming features removes real specs.
const TEST_TIER = /^@?(integration|e2e|slow|smoke|manual|flaky)$/i;
const invertsTestTiers = (value) => value.replace(/^\/|\/[a-z]*$/g, '').split('|').every(w => TEST_TIER.test(w.trim()));

// In tox a leading '-' on a command ignores its exit code.
const TOX_DASH = /^\s+-\s*(python\d?(\.\d+)?\s+-m\s+)?(pytest|py\.test|unittest|coverage\s+run|nose2?|stestr|trial)\b/;

// A runner that is told to list tests and run none.
const COLLECT_ONLY = [
  [/(?<!\S)(--collect-only|--co)(?!\S)/, /\b(pytest|py\.test)\b/],
  [/(?<!\S)--listTests(?!\S)/, /\b(jest|vitest)\b/],
  [/(?<!\S)-list(?=[\s=]|$)/, /\bgo\s+test\b/],
];

// -m 'not M' in addopts or a CI runner line. It only takes tests out of the run when something carries
// the marker: 'hard' when this change tags an existing test with it and nothing runs it, 'soft' when
// the marker is a usual split (slow, integration) or another line runs it, null when no test is tagged.
const SPLIT_MARKERS = new Set(['slow', 'integration', 'e2e', 'network', 'gpu', 'benchmark', 'perf', 'external', 'docker', 'db']);
function deselectedTag(ctx, mk) {
  const tag = new RegExp(`^\\s*@pytest\\.mark\\.${mk}\\b`);
  let tagged = false;
  for (const g of ctx.files) {
    if (!fileIsTest(ctx, g)) continue;
    for (const x of g.added) {
      if (!tag.test(x.text)) continue;
      const { lines, i } = newSide(g, x);
      const next = i >= 0 ? lines[i + 1] : null;
      if (next && next.kind === ' ' && /^\s*(async\s+)?def\s+test_/.test(next.text)) tagged = true;
    }
  }
  if (!tagged) return null;
  if (SPLIT_MARKERS.has(mk)) return 'soft';
  const runs = new RegExp(`-m\\s+['"]?${mk}\\b`);
  return ctx.files.some(g => (isCiPath(pathOf(g)) || isBuildPath(pathOf(g))) && g.added.some(x => runs.test(x.text))) ? 'soft' : 'hard';
}

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

// vitest and jest take "exclude" (vitest, inside test:) to drop whole paths from the run. Output dirs,
// vitest's own defaults and an e2e or fixtures split are ordinary.
const EXCLUDE_OK = new Set([...OUTPUT_DIRS, 'cypress', '.idea', '.temp', 'e2e', 'playwright', 'fixtures', 'fixture', '__fixtures__']);
const EXCLUDE_CONFIG = /^(vitest|jest|vite)\.config\./;
function excludesRealDirs(f, a) {
  if (!EXCLUDE_CONFIG.test(baseName(f.newPath))) return false;
  const m = /\bexclude\s*:(.*)/.exec(a.text);
  if (!m) return false;
  const pats = m[1].match(/'[^']*'|"[^"]*"|`[^`]*`/g);
  if (!pats) return false;
  const real = pats.some(q => {
    const name = q.slice(1, -1).replace(/^(\*\*\/)+/, '').replace(/(\/\*\*?|\*\*)$/, '').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
    return !EXCLUDE_OK.has(name) && !EXCLUDE_OK.has(name.split('/').pop());
  });
  if (!real) return false;
  // Only the test: block counts; coverage.exclude is honest config.
  const lines = hunkLines(f, a).filter(l => l.newLine != null);
  const i = lines.findIndex(l => l.kind === '+' && l.newLine === a.line);
  const ind = indentOf(a.text);
  for (let j = i - 1; j >= 0; j--) {
    if (!lines[j].text.trim() || indentOf(lines[j].text) >= ind) continue;
    return /^\s*test\s*:\s*\{?/.test(lines[j].text);
  }
  return false;
}

// The nearest [section] header above an added Cargo.toml line, null when the hunk shows none.
function cargoSection(f, a) {
  const lines = hunkLines(f, a).filter(l => l.newLine != null);
  const i = lines.findIndex(l => l.kind === '+' && l.newLine === a.line);
  for (let j = i - 1; j >= 0; j--) {
    const m = /^\s*\[\[?\s*([\w.-]+)\s*\]\]?/.exec(lines[j].text);
    if (m) return m[1];
  }
  return null;
}

const HIDE_ATTR = /(\s|^)(-diff|binary|-text)\b/;
const MEDIA_EXT = /^(png|jpe?g|gif|svg|ico|webp|bmp|woff2?|ttf|otf|eot|mp3|mp4|wav|ogg|webm|mov|avi|pdf)$/i;
// Archives, compiled output and binary art: marking these binary is housekeeping.
const BINARY_EXT = /^(jar|war|ear|aar|class|dex|so|dll|dylib|exe|bin|o|a|lib|pyc|wasm|zip|gz|tgz|bz2|xz|7z|rar|tar|jks|keystore|nbt|mca|schem|schematic|psd|xcf|kra|aseprite|ase|blend|fbx|glb)$/i;
const HIDE_GENERATED =/(\s|^)linguist-(generated|vendored)(=true|(?![=\w-]))/;

const SUPPRESSION = /@ts-(ignore|expect-error|nocheck)\b|eslint-disable|#\s*type:\s*ignore|#\s*noqa\b|#\s*pylint:\s*disable|#\s*pyright:\s*ignore|@SuppressWarnings\s*\(|#\[\s*allow\s*\(|\/\/\s*nolint\b|#pragma\s+warning\s+disable|\/\/\s*@ts-|rubocop:disable|istanbul\s+ignore|c8\s+ignore|pragma:\s*no\s+cover/;

const CATCH_EMPTY = /\bcatch\s*(\([^)]*\))?\s*\{\s*\}/;
const CATCH_OPEN = /\bcatch\s*(\([^)]*\))?\s*\{\s*$/;
const EXCEPT_PASS = /^\s*except\b[^:]*:\s*(pass|\.\.\.)\s*$/;
const EXCEPT_OPEN = /^\s*except\b[^:]*:\s*$/;
const PROMISE_CATCH = /\.catch\s*\(\s*\(\s*\w*\s*\)\s*=>\s*(\{\s*\}|null|undefined)\s*\)/;
// Only a broad catch counts: "except KeyError: return 0" is an ordinary dictionary default.
const EXCEPT_BROAD = /^\s*except\s*(\(?\s*(Base)?Exception\b[^:]*)?:\s*$/;
const DEFAULT_RETURN_PY = /^\s*return(\s+(0|None|False|\[\]|\{\}|''|""|-1))?\s*$/;
const DEFAULT_RETURN_JS = /^\s*return(\s+(null|undefined|false|0|-1|\[\]|\{\}|''|""))?\s*;?\s*$/;
const RESCUE_INLINE = /\brescue\s+nil\b|\brescue\b[^#\n]*;\s*(next|nil)\s*(;\s*end)?\s*$/;
const RESCUE_OPEN = /^\s*rescue\b(\s+[\w:]+(\s*,\s*[\w:]+)*)?(\s*=>\s*\w+)?\s*$/;
const GO_DISCARD = /^\s*_\s*=\s*err\s*$/;

const STUB = /throw\s+new\s+Error\s*\(\s*['"`](not\s+implemented|todo|unimplemented)|raise\s+NotImplementedError|\btodo!\s*\(|\bunimplemented!\s*\(|UnsupportedOperationException|NotImplementedException|panic\s*\(\s*"(not\s+implemented|todo|unimplemented)/i;

const FLAKE = /\bjest\.retryTimes\s*\(|\bthis\.retries\s*\(|\bretries\s*:\s*(?:[^,\n]*[?:]\s*)?[1-9]|\b(assert|require)\.(Eventually|EventuallyWithT|Never)\w*\s*\(.*\b\d+\s*\*\s*time\.(Minute|Hour)\b|@pytest\.mark\.flaky\b|--reruns\b|@RetryingTest\b|@Retry\b|\bjest\.setTimeout\s*\(|\bthis\.timeout\s*\(|@pytest\.mark\.timeout\s*\(|@Timeout\s*\(|\btestTimeout\s*:|\btimeout\s*:\s*\d[\d_]{4,}|\[\s*(?:[\w.]+\s*,\s*)*(Retry|Timeout|Repeat)\s*\(\s*\d|,\s*(Retry|Timeout)\s*\(\s*\d/;
// A property test cut to a handful of cases. Slow properties are often run at 16 to 64, so only single digits count.
const RUST_CASES_CUT = /\bwith_cases\s*\(\s*[0-9]\s*\)|\bcases\s*:\s*[0-9]\b/;
const PY_EXAMPLES_CUT = /\bmax_examples\s*=\s*[0-9]\b/;

// Go durations such as 2*time.Second, in nanoseconds.
const GO_DURATION = /(\d+)\s*\*\s*time\.(Millisecond|Second|Minute|Hour)\b/g;
const GO_UNIT = { Millisecond: 1e6, Second: 1e9, Minute: 6e10, Hour: 3.6e12 };
const goDurations = (t) => [...t.matchAll(GO_DURATION)].map(m => Number(m[1]) * GO_UNIT[m[2]]);
const withoutDurations = (t) => t.replace(GO_DURATION, 'D').replace(/\s+/g, ' ').trim();

// An if on two or more literal comparisons that answers with a constant: a guard written for one input.
const FLOAT_EQ = /[!=]==?\s*-?\d+\.\d+\b|\b-?\d+\.\d+\s*[!=]==?/g;
const LITERAL_EQ = /(==|===)\s*(['"`][^'"`]*['"`]|-?\d[\d.]*)/g;
const IF_LINE = /^\s*(\}\s*else\s+)?(if|elif)\b/;
const RETURN_CONST = /\breturn\s+(-?\d+(\.\d+)?|'[^']*'|"[^"]*")\s*;?\s*\}?\s*$/;
const RETURN_ODD = /\breturn\s+(-?\d+\.\d+|-?\d{2,}|['"][^'"]+['"])\s*;?\s*\}?\s*$/;
function inputSpecialCased(f, a) {
  const t = a.text;
  if (!IF_LINE.test(t)) return false;
  const count = (re) => (t.match(re) ?? []).length;
  const next = nextCodeLine(f, a) ?? '';
  const body = RETURN_CONST.test(t) || RETURN_CONST.test(next);
  if (count(FLOAT_EQ) >= 2 && body) return true;
  const joined = /\b(and|&&)\b|&&/.test(t);
  return count(LITERAL_EQ) >= 2 && joined && (RETURN_ODD.test(t) || RETURN_ODD.test(next));
}

// One guard on a float literal that answers with a constant. Two of them on the same name a few
// lines apart are a lookup of inputs; each alone is a boundary check.
const FLOAT_GUARD = /([\w.$]+)\s*[!=]==?\s*-?\d+\.\d+/;
function floatGuard(f, a) {
  if (!IF_LINE.test(a.text)) return null;
  const m = FLOAT_GUARD.exec(a.text);
  if (!m || !(RETURN_CONST.test(a.text) || RETURN_CONST.test(nextCodeLine(f, a) ?? ''))) return null;
  return m[1];
}
function floatGuardChain(f, a) {
  const id = floatGuard(f, a);
  if (!id) return false;
  return f.added.some(x => x !== a && x.hunk === a.hunk && Math.abs(x.line - a.line) <= 4 && !isCommentLine(x.text) && floatGuard(f, x) === id);
}

// if (start, rule, n) in _KNOWN: return _KNOWN[(start, rule, n)], with _KNOWN a dict this change fills
// with constant tuples, and the key made of every parameter of the function.
const LOOKUP_IF_TUPLE = /^\s*if\s+\(([^)]*)\)\s+in\s+(\w+)\s*:\s*$/;
const LOOKUP_IF_NAME = /^\s*if\s+(\w+)\s+in\s+(\w+)\s*:\s*$/;
const PY_DEF = /^\s*(?:async\s+)?def\s+\w+\s*\((.*)\)\s*(?:->.*)?:\s*$/;
const constantKeyItem = (x) => {
  const t = x.trim();
  if (LITERAL_ONLY.test(t) || /^(True|False|None)$/.test(t)) return true;
  const call = /^[\w.]+\((.*)\)$/.exec(t);
  return call != null && splitTop(call[1]).every(y => LITERAL_ONLY.test(y.trim()) || /^(True|False|None)$/.test(y.trim()));
};
function filledWithConstantTuples(f, name) {
  const open = new RegExp(`^\\s*${name}\\s*(?::[^=]+)?=\\s*\\{\\s*$`);
  const at = f.added.findIndex(x => open.test(x.text));
  if (at < 0) return false;
  let entries = 0;
  for (let k = at + 1, n = f.added[at].line + 1; k < f.added.length && f.added[k].line === n; k++, n++) {
    const t = f.added[k].text.trim();
    if (!t) continue;
    if (t.startsWith('}')) return entries > 0;
    if (!t.startsWith('(')) return false;
    let depth = 0;
    let end = -1;
    for (let c = 0; c < t.length && end < 0; c++) {
      if (t[c] === '(') depth++;
      else if (t[c] === ')' && --depth === 0) end = c;
    }
    if (end < 0 || !splitTop(t.slice(1, end)).every(constantKeyItem)) return false;
    entries++;
  }
  return false;
}
function lookupTableGuard(f, a) {
  const m = LOOKUP_IF_TUPLE.exec(a.text) ?? LOOKUP_IF_NAME.exec(a.text);
  if (!m) return false;
  const [, key, name] = m;
  const norm = (s) => s.replace(/\s+/g, '').replace(/^\(|\)$/g, '');
  if (!new RegExp(`^\\s*return\\s+${name}\\[(.*)\\]\\s*$`).test(nextCodeLine(f, a) ?? '')) return false;
  const ret = new RegExp(`^\\s*return\\s+${name}\\[(.*)\\]\\s*$`).exec(nextCodeLine(f, a))[1];
  if (norm(ret) !== norm(key)) return false;
  const { lines, i } = newSide(f, a);
  let params = null;
  for (let j = i - 1; j >= 0 && !params; j--) {
    const d = PY_DEF.exec(lines[j].text);
    if (d) params = splitTop(d[1]).map(s => s.split(/[:=]/)[0].replace(/^\*+/, '').trim()).filter(s => s && s !== 'self' && s !== 'cls');
  }
  if (!params) return false;
  const keys = norm(key).split(',').filter(Boolean);
  if (keys.length !== params.length || keys.some((k, idx) => k !== params[idx])) return false;
  return filledWithConstantTuples(f, name);
}

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

// The removed lines of the test that removed header r opens, up to the next header in its hunk.
function removedBlock(f, r, isHeader) {
  const lines = f.hunks[r.hunk]?.lines ?? [];
  const start = lines.findIndex(l => l.kind === '-' && l.oldLine === r.line);
  const out = [];
  for (let i = start; i >= 0 && i < lines.length; i++) {
    if (i > start && lines[i].kind !== '+' && isHeader(lines[i].text)) break;
    if (lines[i].kind === '-') out.push(lines[i].text);
  }
  return out;
}

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

// Skips that only happen where results are enforced. skipUnless and a negated test run on CI only, so they are left out.
const CI_VARS = 'CI|GITHUB_ACTIONS|GITLAB_CI|CIRCLECI|TRAVIS|BUILDKITE|JENKINS_URL|TF_BUILD|TEAMCITY_VERSION|CONTINUOUS_INTEGRATION';
const PY_CI_ENV = new RegExp(`(?<!not\\s)\\b(os\\.environ(\\.get)?|os\\.getenv)\\s*[\\(\\[]\\s*['"](${CI_VARS})['"]|(?<!not\\s)['"](CI|GITHUB_ACTIONS)['"]\\s+in\\s+os\\.environ`);
const PY_SKIPIF = /^\s*@(pytest\.mark\.skipif|unittest\.skipIf)\s*\(/;
const JS_TODO_TITLE = /\b(it|test)\.todo\s*\(\s*(['"`])((?:(?!\2).)*)\2\s*\)\s*;?\s*$/;
const JS_MARKED_HEADER = /\b(it|test|describe)\.(skip|todo|fixme|fails|failing)\s*\(\s*(['"`])(.*?)\3/;
const GO_IGNORE_TAG = /^\s*\/\/\s*(go:build|\+build)\s+.*(?<!!)\bignore\b/;

const CONDITIONAL_OPENER = /^\s*(\}\s*)?(if|unless|elif|else\s+if)\b/;
const ATTRIBUTE_LINE = /^\s*(@|#\[|\[)/;
const FN_HEADER = /^\s*(?:(?:pub\s+)?(?:async\s+)?fn\s+(\w+)|func\s+(Test\w*)|(?:async\s+)?def\s+(test\w*)|(?:public\s+|private\s+|protected\s+)?(?:static\s+)?void\s+(\w+))/;

// Is the skip marker `a` inside an "if", or does it belong to a test that this same change adds?
// Either way it does not switch off a test that was running before.
function skipIsHarmless(f, a, { ci = false } = {}) {
  if (f.status === 'added') return true;
  const lines = hunkLines(f, a).filter(l => l.newLine != null);
  const i = lines.findIndex(l => l.kind === '+' && l.newLine === a.line);
  if (i < 0) return false;
  for (let j = i - 1; j >= 0; j--) {
    if (!lines[j].text.trim() || isCommentLine(lines[j].text)) continue;
    if (CONDITIONAL_OPENER.test(lines[j].text) && !ci) return true;
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

// A python skip marker whose condition reads a CI variable: the decorator and its next lines, or
// a pytest.skip( under an "if" on one.
function pySkipsOnCi(f, a) {
  const lines = hunkLines(f, a).filter(l => l.newLine != null);
  const i = lines.findIndex(l => l.kind === '+' && l.newLine === a.line);
  if (i < 0) return false;
  if (PY_SKIPIF.test(a.text)) return PY_CI_ENV.test(lines.slice(i, i + 4).map(l => l.text).join('\n'));
  if (!/\b(pytest\.skip|self\.skipTest)\s*\(/.test(a.text)) return false;
  for (let j = i - 1; j >= 0; j--) {
    if (!lines[j].text.trim() || isCommentLine(lines[j].text)) continue;
    return CONDITIONAL_OPENER.test(lines[j].text) && PY_CI_ENV.test(lines[j].text);
  }
  return false;
}

// pytest.importorskip("pkg.new") written where an import of another module of pkg used to be. The
// same module moved behind importorskip is an optional dependency, so that one is only soft.
const IMPORTORSKIP = /\bpytest\.importorskip\s*\(\s*['"]([\w.]+)['"]/;
function importorskipChange(f, a) {
  const m = IMPORTORSKIP.exec(a.text);
  if (!m) return null;
  const target = m[1];
  let sameTop = false;
  for (const l of hunkLines(f, a)) {
    if (l.kind !== '-' || isCommentLine(l.text)) continue;
    const from = /^\s*from\s+([\w.]+)\s+import\s+(.+?)\s*$/.exec(l.text);
    const plain = /^\s*import\s+([\w.]+)/.exec(l.text);
    let mods = [];
    if (from) mods = [from[1], ...from[2].replace(/[()]/g, '').split(',').map(n => /^\s*(\w+)/.exec(n)?.[1]).filter(Boolean).map(n => from[1] + '.' + n)];
    else if (plain) mods = [plain[1]];
    if (mods.includes(target)) return 'soft';
    if (mods.some(x => x.split('.')[0] === target.split('.')[0])) sameTop = true;
  }
  return sameTop ? 'hard' : null;
}

// item.add_marker(pytest.mark.skip(...)) in a conftest. It is a skip of named tests when the "if" above
// compares item.name with test names; the --runslow pattern on item.keywords is a documented soft case.
const ADD_MARKER = /\.add_marker\s*\(\s*(?:pytest\.mark\.(?:skip|xfail)\b|(\w+)\s*\))/;
function markerSkip(f, a) {
  const m = ADD_MARKER.exec(a.text);
  if (!m) return null;
  if (m[1] && !f.added.some(x => new RegExp(`\\b${m[1]}\\s*=\\s*pytest\\.mark\\.(skip|xfail)\\b`).test(x.text))) return null;
  const { lines, i } = newSide(f, a);
  let cond = '';
  for (let j = i - 1; j >= 0; j--) {
    if (!lines[j].text.trim() || isCommentLine(lines[j].text)) continue;
    cond = lines[j].text;
    break;
  }
  if (!/^\s*if\b/.test(cond) || !/\b\w+\.(name|nodeid|originalname)\b/.test(cond)) return 'other';
  if (/['"][^'"]*\btest_\w/.test(cond)) return 'name';
  const holder = /\bin\s+([\w.]+)/.exec(cond)?.[1];
  if (!holder) return 'other';
  const def = new RegExp(`^\\s*${holder.replace(/[.$]/g, '\\$&')}\\s*(:[^=]+)?=`);
  const at = f.added.findIndex(x => def.test(x.text));
  if (at < 0) return 'other';
  let body = '';
  for (let k = at, n = f.added[at].line; k < f.added.length && f.added[k].line === n && k < at + 20; k++, n++) body += f.added[k].text + '\n';
  return /['"][^'"]*\btest_\w/.test(body) ? 'name' : 'other';
}

// An rspec example that has just been given a tag, and that this change excludes from the run.
function newlyTagged(ctx, tag) {
  const tagged = new RegExp(`,\\s*(?::${tag}\\b|${tag}:\\s*true)`);
  return ctx.files.some(g => fileIsTest(ctx, g) && g.added.some(x => {
    if (!/^\s*(it|specify|scenario|example)\b/.test(x.text) || !tagged.test(x.text)) return false;
    const plain = collapse(x.text.replace(tagged, ''));
    return g.removed.some(r => collapse(r.text) === plain);
  }));
}

const STRING_LITERAL =/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g;
const NUMBER_LITERAL = /-?\b\d+(\.\d+)?([eE][+-]?\d+)?\b/g;
const skeleton = (t) => t.trim().replace(STRING_LITERAL, 'S').replace(NUMBER_LITERAL, 'N').replace(/\s+/g, ' ');
const collapse = (t) => t.trim().replace(/\s+/g, ' ');

// The new-file side of a's hunk, and where a sits in it.
function newSide(f, a) {
  const lines = hunkLines(f, a).filter(l => l.newLine != null);
  return { lines, i: lines.findIndex(l => l.kind === '+' && l.newLine === a.line) };
}

// The lines indented deeper than lines[i], up to the first line back at its indent. seen is false
// when the hunk ends first, so the rest of the block cannot be read.
function blockBelow(lines, i) {
  const base = indentOf(lines[i].text);
  const body = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (!lines[j].text.trim()) continue;
    if (indentOf(lines[j].text) <= base) return { body, seen: true };
    body.push(lines[j]);
  }
  return { body, seen: false };
}

// The opener of the block that lines[i] closes and continues ("try {" above "} catch"), when it is
// directly above in the hunk. Null when the hunk does not show it.
function openerAbove(lines, i, opener) {
  const base = indentOf(lines[i].text);
  for (let j = i - 1; j >= 0; j--) {
    if (!lines[j].text.trim()) continue;
    const ind = indentOf(lines[j].text);
    if (ind < base) return null;
    if (ind === base) return opener.test(lines[j].text) ? j : null;
  }
  return null;
}

const ASSERTION_TYPES = /\b(AssertionError|AssertionFailedError|ComparisonFailure|AssertionException|Xunit\.Sdk\.\w*Exception|Throwable|Minitest::Assertion|MiniTest::Assertion|RSpec::Expectations::ExpectationNotMetError|Test::Unit::AssertionFailedError)\b/;
const LOG_ONLY = /^\s*(console\.\w+|logger\.\w+|log\.\w+|print\w*|System\.(out|err)\.\w+)\s*\(.*\)\s*;?\s*$/;
const HANDLER_ESCAPE = /\bthrow\b|\braise\b|\bflunk\b|\bretry\b|\b(pytest|self)\.fail\s*\(|\bdone\s*\(\s*(err|e|error)\b|\breject\b|\bfail\s*\(/;
const TRY_FAILS = /\bfail\s*\(/;
// A recover() in a go test that never fails the test: the "except: pass" of Go.
const GO_RECOVER = /\brecover\s*\(\s*\)/;
const GO_FAILS = /\bt\.(Error|Errorf|Fatal|Fatalf|Fail|FailNow)\b|\b(assert|require)\.\w+\s*\(|\bpanic\s*\(/;
function goRecoverSwallows(f, a) {
  if (!GO_RECOVER.test(a.text)) return false;
  if (/\bdefer\s+func\s*\(\s*\)\s*\{\s*recover\s*\(\s*\)\s*\}\s*\(\s*\)/.test(a.text)) return true;
  if (GO_FAILS.test(a.text)) return false;
  const { lines, i } = newSide(f, a);
  if (i < 0) return false;
  const base = indentOf(a.text);
  const opensBlock = /\{\s*$/.test(a.text);
  const window = [];
  for (let j = i + 1; j < lines.length && window.length < 6; j++) {
    const l = lines[j].text;
    if (!l.trim()) continue;
    if (indentOf(l) < base || (opensBlock && indentOf(l) === base && /^\s*\}/.test(l))) break;
    window.push(l);
  }
  return !window.some(l => GO_FAILS.test(l));
}

const UNIT_MOCK = /\b(jest|vi)\.(mock|doMock)\s*\(\s*['"`](\.{1,2}\/[^'"`]+)['"`]/;
const MOCK_ACTUAL = /\b(requireActual|importActual)\b/;
const PATCH_RETURN = /\bpatch(?:\.object)?\s*\(\s*(?:[\w.]+\s*,\s*['"](\w+)['"]|['"][\w.]*\.(\w+)['"])[^\n]*?\breturn_value\s*=\s*/;
const STUB_DO = /\bdo(?:Return|Answer|Nothing|Throw)\s*\(.*?\)\s*\.when\s*\(\s*(\w+)\s*\)\s*\.(\w+)\s*\(/;
const STUB_WHEN = /\bwhen\s*\(\s*(\w+)\.(\w+)\s*\(/;
const LITERAL_ONLY = /^(?:-?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[LfFdD]?|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)$/;
const EXPECT_CALL = /\.to\s+(?:eq|eql|equal|be)\s*\(|\.(?:toBe|toEqual|toStrictEqual)\s*\(|\bassert_equal\s+|\bassertEquals?\s*\(|\bassert_eq!\s*\(/;

// The text of a call argument that starts at the front of s, up to the bracket that closes the call.
function argUpToClose(s) {
  let depth = 0;
  let out = '';
  for (const ch of s) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) { if (depth === 0) break; depth--; }
    else if (ch === ',' && depth === 0) break;
    out += ch;
  }
  return out.trim();
}

// The two sides an equality assertion compares, or null when the line is not one.
function assertSides(t) {
  let m = /^\s*(.+?)\s+shouldBe\s+(.+?)\s*$/.exec(t);
  if (m) return [m[1], m[2]];
  m = /\bassertThat\s*\((.+)\)\s*\.isEqualTo\s*\((.+)\)\s*;?\s*$/.exec(t) ?? /\bexpect\s*\((.+)\)\s*\.(?:toBe|toEqual|toStrictEqual)\s*\((.+)\)\s*;?\s*$/.exec(t);
  if (m) return [m[1], m[2]];
  m = /\bassertEquals?\s*\((.*)\)\s*;?\s*$/.exec(t);
  if (m) {
    const parts = splitTop(m[1]);
    if (parts.length === 2) return parts;
  }
  return null;
}
// Named-argument labels dropped and spaces gone: "f(a = 1)" and "f(1)" read the same.
const bareSide = (x) => x.replace(/\b[a-z]\w*\s*=(?!=)\s*/g, '').replace(/\s+/g, '');
const calleeOf = (x) => bareSide(x).split('(')[0];

// An added assertion that compares a call with itself. 'hard' when a removed assertion in the hunk
// had the same callee on the left and a literal on the right, 'soft' otherwise (a determinism test
// can compare a call with itself).
function selfComparison(f, a) {
  const sides = assertSides(a.text);
  if (!sides || !sides[0].includes('(') || bareSide(sides[0]) !== bareSide(sides[1])) return null;
  const callee = calleeOf(sides[0]);
  const literalBefore = hunkLines(f, a).some(l => {
    if (l.kind !== '-' || isCommentLine(l.text)) return false;
    const old = assertSides(l.text);
    return old != null && calleeOf(old[0]) === callee && LITERAL_ONLY.test(old[1].trim().replace(/;$/, ''));
  });
  return literalBefore ? 'hard' : 'soft';
}

// patch.object(Invoice, "total", return_value=X) followed by an assert on inv.total() == X.
function patchedReturnAsserted(f, a) {
  const m = PATCH_RETURN.exec(a.text);
  if (!m) return false;
  const attr = m[1] ?? m[2];
  const value = argUpToClose(a.text.slice(m.index + m[0].length)).replace(/\s+/g, '');
  if (!value) return false;
  return f.added.some(x => x.hunk === a.hunk && x.line > a.line && x.line <= a.line + 8 && isAssertLine(x.text)
    && x.text.includes('.' + attr + '(') && x.text.replace(/\s+/g, '').includes(value));
}

// jest.spyOn(tax, 'withTax').mockReturnValue(X) followed, within a few lines, by an assert on
// tax.withTax(...) with X. The assert can be a line the change left alone: the spy is what is new.
const SPY_RETURN = /\b(?:jest|vi)\.spyOn\s*\(\s*([\w.$]+)\s*,\s*['"](\w+)['"]\s*\)\s*\.mock(?:Return|Resolved)Value(?:Once)?\s*\(/;
function spyReturnAsserted(f, a) {
  const m = SPY_RETURN.exec(a.text);
  if (!m) return false;
  const value = argUpToClose(a.text.slice(m.index + m[0].length)).replace(/\s+/g, '');
  if (!value) return false;
  const call = m[1] + '.' + m[2] + '(';
  const { lines, i } = newSide(f, a);
  return lines.slice(i + 1, i + 9).some(l => isAssertLine(l.text) && l.text.includes(call) && l.text.replace(/\s+/g, '').includes(value));
}

// Matchers that accept a set of values: Hamcrest anyOf and either, oneOf and isIn from AssertJ and
// Hamcrest, FluentAssertions BeOneOf.
const WIDENING = /\b(anyOf|either|oneOf|isOneOf|isIn|isAnyOf|BeOneOf)\s*\(/;
// What an assertion is about: assertThat(S, ...), assertThat(S).x, expect(S), or S.Should().
function assertSubject(t) {
  const m = /\b(?:assertThat|expect)\s*\(/.exec(t);
  if (m) return bareSide(argUpToClose(t.slice(m.index + m[0].length)));
  const s = /^\s*(?:(?:var|await)\s+)?(.+?)\.Should\(\)/.exec(t);
  return s ? bareSide(s[1]) : null;
}

// An added assert that compares one object whole (recursive comparison, BeEquivalentTo, isEqualTo(new X),
// toEqual({...})): the name of that object. The comparison may run on over the next lines that start with a dot.
const WHOLE_COMPARE = /usingRecursiveComparison\s*\(|\.Should\(\)\.BeEquivalentTo\s*\(|\bisEqualTo\s*\(\s*new\s+\w|\bassertEquals\s*\(\s*new\s+\w|\.toEqual\s*\(\s*\{|\.toStrictEqual\s*\(\s*\{/;
function wholeObjectSubjects(f, added) {
  const names = new Set();
  for (const a of added) {
    if (!isAssertLine(a.text)) continue;
    const { lines, i } = newSide(f, a);
    if (i < 0) continue;
    let text = a.text;
    for (let j = i + 1; j < lines.length && /^\s*\./.test(lines[j].text); j++) text += ' ' + lines[j].text.trim();
    if (!WHOLE_COMPARE.test(text)) continue;
    const s = /\bassertThat\s*\(\s*([\w.$]+)\s*\)|\b([\w.$]+)\s*\.Should\(\)|\bexpect\s*\(\s*([\w.$]+)\s*\)/.exec(text);
    let name = s ? (s[1] ?? s[2] ?? s[3]) : null;
    if (!name) {
      const ae = /\bassertEquals\s*\((.*)\)\s*;?\s*$/.exec(text);
      const parts = ae ? splitTop(ae[1]) : [];
      if (parts.length === 2 && /^\s*new\s/.test(parts[0])) name = parts[1].trim();
    }
    if (name && /^[\w.$]+$/.test(name)) names.add(name);
  }
  return [...names];
}

// A removed "require.NoError(t, err)" (or "if err != nil { t.Fatal }") whose err came from a setup call
// that this change replaced with one that cannot fail: "dir, err := os.MkdirTemp(...)" to "dir := t.TempDir()".
function errGuardDropped(f, r) {
  const h = f.hunks[r.hunk]?.lines ?? [];
  let v = /\b(?:require|assert)\.NoError\s*\(\s*t\s*,\s*(\w+)\s*\)/.exec(r.text)?.[1];
  if (!v && /\bt\.(Fatal|Fatalf|Error|Errorf)\s*\(/.test(r.text)) {
    const at = h.findIndex(l => l.kind === '-' && l.oldLine === r.line);
    const above = at > 0 && h[at - 1].kind === '-' ? h[at - 1].text : '';
    v = /^\s*if\s+(\w+)\s*!=\s*nil\s*\{?\s*$/.exec(above)?.[1];
  }
  if (!v) return false;
  const assigned = (name) => new RegExp(`^\\s*[\\w, ]*\\b${name}\\b[\\w, ]*(?::=|=(?!=))`);
  const old = h.filter(l => l.kind === '-').map(l => new RegExp(`^\\s*([\\w, ]+),\\s*${v}\\s*:?=`).exec(l.text)).find(Boolean);
  if (!old) return false;
  const others = old[1].split(',').map(s => s.trim()).filter(s => s && s !== '_');
  const addedText = h.filter(l => l.kind === '+').map(l => l.text);
  if (addedText.some(t => assigned(v).test(t))) return false;
  return others.length > 0 && others.every(n => addedText.some(t => assigned(n).test(t)));
}

// "expect(x).to eq(120.0)" turned into "expect(x).to eq(a + b)": the same call, a literal swapped for an expression.
function literalToExpression(oldText, newText) {
  const parts = [oldText, newText].map(t => {
    const m = EXPECT_CALL.exec(t);
    if (!m) return null;
    const rest = t.slice(m.index + m[0].length);
    const arg = /assert_equal|assertEquals?|assert_eq!/.test(m[0]) ? splitTop(rest)[0] : rest.replace(/\)\s*;?\s*$/, '');
    return { prefix: collapse(t.slice(0, m.index + m[0].length)), arg: arg.trim().replace(/\)$/, '') };
  });
  if (!parts[0] || !parts[1] || parts[0].prefix !== parts[1].prefix) return false;
  return LITERAL_ONLY.test(parts[0].arg) && !LITERAL_ONLY.test(parts[1].arg);
}

// A data row of a parametrize table: a tuple, a quoted CsvSource line, or an attribute that is a row by itself.
const ROW_TUPLE = /^\s*[(\[{].*[)\]}]\s*,?\s*$/;
const ROW_STRING = /^\s*"(?:\\.|[^"\\])*"\s*,?\s*$/;
const ROW_ATTR = /^\s*(?:\[\s*(?:InlineData|DataRow|TestCase)\s*\(|@(?:CsvSource|ValueSource)\b|Arguments\.(?:of|arguments)\s*\(|arguments\s*\()/;
const TABLE_OPENER = /@pytest\.mark\.parametrize|\.each\s*[(`]|@ParameterizedTest|@CsvSource|@MethodSource|@ValueSource|\[\s*Theory\b|\bcases\s*=\s*\[/;
const TABLE_CLOSE = /^\s*(?:\]|\)|\}\))[\s,;)\]]*$/;
function rowKind(text) {
  if (isCommentLine(text)) return null;
  if (ROW_ATTR.test(text)) return 'attr';
  if (ROW_STRING.test(text)) return 'string';
  // A tuple has at least two values: [Retry(3)] and [Test] are attributes.
  if (ROW_TUPLE.test(text) && splitTop(text.trim().replace(/,$/, '').slice(1, -1)).length >= 2) return 'tuple';
  return null;
}
const rowKey = (text) => collapse(text).replace(/,$/, '').trim();

// Rows removed from a table in this hunk that nothing re-adds, when the hunk shows it is a table.
function removedRows(h) {
  const added = new Map();
  for (const l of h.lines) {
    if (l.kind !== '+' || !rowKind(l.text)) continue;
    const k = rowKind(l.text) + '|' + rowKey(l.text);
    added.set(k, (added.get(k) ?? 0) + 1);
  }
  const lost = [];
  for (const l of h.lines) {
    if (l.kind !== '-' || !rowKind(l.text)) continue;
    const k = rowKind(l.text) + '|' + rowKey(l.text);
    if ((added.get(k) ?? 0) > 0) { added.set(k, added.get(k) - 1); continue; }
    lost.push(l);
  }
  const addedLeft = [...added.values()].reduce((n, v) => n + v, 0);
  if (lost.length <= addedLeft) return [];
  const kind = rowKind(lost[0].text);
  const opener = h.lines.some(l => TABLE_OPENER.test(l.text));
  const hasContextRow = h.lines.some(l => l.kind === ' ' && rowKind(l.text) === kind);
  const closes = h.lines.some((l, idx) => l.kind !== '-' && TABLE_CLOSE.test(l.text) && idx > h.lines.indexOf(lost[0]));
  if (kind === 'attr') return lost;
  if (!hasContextRow) return [];
  if (kind === 'string') return opener ? lost : [];
  return opener || closes ? lost : [];
}

// A renamed test file that no longer matches the name its runner looks for.
const RUNNER_NAME = {
  py: /^test_.*\.py$|_test\.py$/,
  js: /\.(test|spec)\.[cm]?[jt]sx?$/,
  go: /_test\.go$/,
  rb: /_(spec|test)\.rb$/,
};
const JVM_CONVENTION = /^(Test\w*|\w*(Test|Tests|TestCase))\.(java|kt|groovy|scala)$/;
const JVM_OTHER_RUNNER = /(Spec|IT|Suite)\.\w+$/;
const RUNNER_CONFIG = /\b(python_files|testMatch|testRegex)\b/;
function leavesRunnerName(ctx, f) {
  const lang = language(f.oldPath);
  const oldBase = baseName(f.oldPath);
  const newBase = baseName(f.newPath);
  if (lang === 'jvm') {
    if (!JVM_CONVENTION.test(oldBase) || JVM_CONVENTION.test(newBase)) return null;
    return { softer: f.hunks.length > 0 || JVM_OTHER_RUNNER.test(newBase) };
  }
  const re = RUNNER_NAME[lang];
  if (!re || !re.test(oldBase) || re.test(newBase)) return null;
  if (lang === 'js' && /(^|\/)__tests__\//.test(f.newPath)) return null;
  if (ctx.files.some(g => g.added.some(a => RUNNER_CONFIG.test(a.text)))) return null;
  // Hard only when the old file is known to hold tests: from its removed lines, or from the base in local mode.
  const testy = (t) => isAssertLine(t) || TEST_HEADER.test(t);
  let known = f.removed.some(r => testy(r.text));
  if (!known && typeof ctx.source?.baseFile === 'function') {
    const old = ctx.source.baseFile(f.oldPath);
    known = typeof old === 'string' && old.split('\n').some(testy);
  }
  return { softer: !known };
}

// pnpm and turbo take --filter=!pkg to leave a package out of the run. Leaving out only docs or examples is ordinary.
const NEGATED_FILTER = /(?:--filter|-F)[= ]['"]?!(\S+)/g;
const DOCS_LIKE = /docs?|examples?|website|storybook/i;
function negatedFilter(text) {
  const names = [...text.matchAll(NEGATED_FILTER)].map(m => m[1].replace(/["',]+$/, ''));
  return names.length ? names : null;
}

// --testPathIgnorePatterns drops paths from the run. An e2e style split is ordinary when the same file runs it elsewhere.
function ignoresTestPaths(f, a) {
  const at = a.text.indexOf('--testPathIgnorePatterns');
  if (at < 0) return false;
  let rest = a.text.slice(at + '--testPathIgnorePatterns'.length).replace(/^(=|\s+)/, '');
  const tokens = [];
  let m;
  while ((m = /^\s*(['"`]?)([^\s"'`;|&]+)\1/.exec(rest)) && !m[2].startsWith('-')) {
    tokens.push(m[2].replace(/^<rootDir>\/?/, '').replace(/^\/+|\/+$/g, ''));
    rest = rest.slice(m[0].length);
  }
  if (!tokens.length) return true;
  return tokens.some(tok => {
    if (OUTPUT_DIRS.has(tok)) return false;
    if (!EXCLUDE_OK.has(tok)) return true;
    return !f.added.some(x => x !== a && RUNNER.test(x.text) && x.text.includes(tok));
  });
}

// ---- coverage gates ----
const COVERAGE_FILE = /^(\.coveragerc|\.nycrc.*|\.?codecov\.ya?ml)$/;
const COVERAGE_KEY = /\b(branches|functions|lines|statements|fail_under|fail-under|minimum_coverage_by_file|minimum_coverage|minimumCoverage|minimum|threshold|coveredRatio)\b["']?\s*[:=>]?\s*['"]?(\d*\.?\d+)/;
const COVERAGE_KEY_STRONG = /^(fail_under|fail-under|minimum_coverage_by_file|minimum_coverage|minimumcoverage)$/;
const GENERATED_PATH = /(^|\/)(tests?|spec|specs|__tests__|migrations?|generated|gen|proto|protos|pb|fixtures?|mocks?|stubs?|vendor|node_modules|dist|build|docs?|examples?|scripts?)(\/|$)|(^|\/)test_|_test\b|\.(test|spec)\.|_pb2?\b|\.pb\.|\.d\.ts|\.min\./i;

function coverageNumber(text, strongOnly) {
  const m = COVERAGE_KEY.exec(text);
  if (!m) return null;
  const key = m[1].toLowerCase();
  if (strongOnly && !COVERAGE_KEY_STRONG.test(key)) return null;
  return { key, value: Number(m[2]), fraction: m[2].includes('.') };
}

// Added lines that leave source out of coverage: omit = [...], exclude(...) in a jacoco block,
// coveragePathIgnorePatterns. Generated code, tests and vendored dirs do not count.
function coverageExclusion(text, hunk) {
  const listed = /^\s*omit\s*[=:]|coveragePathIgnorePatterns/.test(text);
  const jacoco = /\bexclude\s*\(/.test(text) && hunk.lines.some(l => /jacoco|coverage|classDirectories/i.test(l.text));
  if (!listed && !jacoco) return false;
  let tokens = (text.match(/'[^']*'|"[^"]*"/g) ?? []).map(q => q.slice(1, -1));
  if (!tokens.length && listed) tokens = text.replace(/^[^=:]*[=:]/, '').split(/[,\s]+/);
  return tokens.some(tok => {
    const dir = tok.replace(/^<rootDir>/, '').replace(/\*+/g, '').replace(/^\.?\/+|\/+$/g, '');
    return dir !== '' && !GENERATED_PATH.test(dir);
  });
}

// exclude_lines and exclude_also take regexes. An entry that is only a keyword and wildcards ("def .*",
// "if .*:", "else:") matches nearly every line of code, so the threshold has nothing left to measure.
const EXCLUDE_KEY = /\bexclude_(lines|also)\s*[=:]/;
const EXCLUDE_KEYWORD = /^\s*(def|class|if|elif|else|try|except|finally|for|while|with|return|async\s+def)\b\s*(\.\*|\.\+|\\{1,2}s\*|\s)*:?\s*$/;
// The regexes an added line puts under an exclude key: quoted entries, or the bare line in an ini file.
// Empty when the hunk shows no such key above (or on) the line.
function coverageExcludeEntries(h, l) {
  const lines = h.lines.filter(x => x.newLine != null);
  const i = lines.indexOf(l);
  if (i < 0) return [];
  const own = EXCLUDE_KEY.test(l.text);
  if (!own) {
    let found = false;
    for (let j = i - 1; j >= 0 && !found; j--) {
      const t = lines[j].text;
      if (EXCLUDE_KEY.test(t)) found = true;
      else if (/^\s*\[[^\]]*\]\s*$/.test(t) || /^\s*[\w.-]+\s*=/.test(t)) break;
    }
    if (!found) return [];
  }
  const text = own ? l.text.replace(/^[^=:]*[=:]/, '') : l.text;
  const quoted = text.match(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g);
  if (quoted) return quoted.map(q => q.slice(1, -1));
  return own ? [] : [text.trim()];
}

// Every lowered coverage number in the diff, and every added exclusion of source from coverage.
// A key that falls 20 points in a change that adds source or excludes some is hard; the rest is soft.
const coverageCache = new WeakMap();
function coverageChanges(ctx) {
  if (coverageCache.has(ctx)) return coverageCache.get(ctx);
  const lowered = [];
  const exclusions = [];
  const patternHard = [];
  const patternBare = [];
  for (const f of ctx.files) {
    const p = f.newPath;
    if (p == null) continue;
    const gate =isBuildPath(p) || COVERAGE_FILE.test(baseName(p));
    if (!gate && !ctx.isTest(p)) continue;
    for (const h of f.hunks) {
      const rem = h.lines.filter(l => l.kind === '-' && !isCommentLine(l.text)).map(l => ({ l, n: coverageNumber(l.text, !gate) })).filter(x => x.n);
      for (const l of h.lines) {
        if (l.kind !== '+' || isCommentLine(l.text)) continue;
        if (gate && coverageExclusion(l.text, h)) exclusions.push({ p, l });
        if (gate) {
          for (const entry of coverageExcludeEntries(h, l)) {
            if (!EXCLUDE_KEYWORD.test(entry)) continue;
            (/\.[*+]/.test(entry) ? patternHard : patternBare).push({ p, l });
          }
        }
        const n = coverageNumber(l.text, !gate);
        if (!n) continue;
        const j = rem.findIndex(x => x.n.key === n.key);
        if (j < 0) continue;
        const [old] = rem.splice(j, 1);
        const fraction = (old.n.fraction || n.fraction) && Math.max(old.n.value, n.value) <= 1;
        const drop = (old.n.value - n.value) * (fraction ? 100 : 1);
        if (drop > 0) lowered.push({ p, l, old: old.l, drop });
      }
    }
  }
  const addsSource = ctx.files.some(g => g.newPath != null && isSourceFile(ctx, g.newPath) && g.added.some(x => x.text.trim() && !isCommentLine(x.text)));
  const big = (c) => c.drop >= 20 && (addsSource || exclusions.length > 0);
  // Entries that are a keyword and wildcards match nearly every line. A lone bare "else:" is soft, two are not.
  const patterns = patternBare.length >= 2 ? [...patternHard, ...patternBare] : patternHard;
  const out = {
    hard: lowered.filter(big), soft: lowered.filter(c => !big(c)), exclusions,
    patternHard: patterns, patternSoft: patternBare.length >= 2 ? [] : patternBare,
  };
  coverageCache.set(ctx, out);
  return out;
}

const SNAPSHOT_GARBAGE = /\bNaN\b|\[object Object\]|Invalid Date/;
const INLINE_EXPECTED = /toMatchInlineSnapshot|\.(?:toBe|toEqual|toStrictEqual)\s*\(/;
const QUOTED_GARBAGE = /(['"`])[^'"`]*(?:\bNaN\b|\[object Object\]|Invalid Date)[^'"`]*\1/;
const CYPRESS_FAIL_SWALLOW = /\b(?:cy|Cypress)\.on\s*\(\s*['"]fail['"]\s*,\s*(?:\([^)]*\)|\w+)\s*=>\s*(?:false|\{\s*(?:return\s+false\s*;?\s*)?\})\s*\)/;
const CYPRESS_FAIL_OPEN = /\b(?:cy|Cypress)\.on\s*\(\s*['"]fail['"]\s*,\s*(?:\([^)]*\)|\w+)\s*=>\s*\{\s*$/;
const SUPPRESS_ASSERTION =/\b(contextlib\.)?suppress\s*\([^)]*\bAssertionError\b/;

// Does the runner collect this file by its name? Only those count as a new home for moved checks.
function runnerCollects(p) {
  const lang = language(p);
  const base = baseName(p);
  if (lang === 'jvm') return !JVM_RESOURCES.test(p) && (JVM_CONVENTION.test(base) || JVM_OTHER_RUNNER.test(base));
  const re = RUNNER_NAME[lang];
  return !re || re.test(base) || (lang === 'js' && /(^|\/)__tests__\//.test(p));
}

// Gradle and Maven copy resources, they never compile them.
const JVM_RESOURCES = /(^|\/)src\/[^/]+\/resources\//;
// A function or class declared inside a test body only runs if something calls it.
const NESTED_DECL = {
  js: /^\s*(?:export\s+)?(?:async\s+)?function\b|^\s*(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?(?:function\b|(?:\([^)]*\)|[\w$]+)\s*=>)|^\s*class\s/,
  py: /^\s*(?:async\s+)?def\s|^\s*class\s/,
  jvm: /^\s*(?:(?:final|abstract|static|private|public|protected)\s+)*(?:class|interface|record|enum)\s|->\s*\{\s*$|\bnew\s+[\w$.<>]+\s*\([^)]*\)\s*\{\s*$|\bfun\s/,
};
// A line that can end the test before the checks below it run.
const GUARD = /(?:^|[\s;{)])return\b|\b(?:pytest\.skip|self\.skipTest|this\.skip|t\.Skip\w*|assum\w*)\s*\(|\braise\s+(?:unittest\.)?SkipTest\b/;
const PYTESTMARK = /^pytestmark\s*=\s*\[?\s*pytest\.mark\.(?:skip|xfail)\b/;
// The new-file lines of f above added line a, every hunk, in order.
function linesAbove(f, a) {
  const out = [];
  for (let h = 0; h <= a.hunk; h++) {
    for (const l of f.hunks[h]?.lines ?? []) {
      if (l.newLine == null) continue;
      if (h === a.hunk && l.kind === '+' && l.newLine === a.line) return out;
      out.push(l);
    }
  }
  return out;
}

// Is added line a inside a test that runs: the nearest header above it opens a test, nothing
// between the two declares a function or returns early, and no skip marker sits on the header,
// the two lines above it, or anything that encloses it (a class, a describe, the module).
function inLiveTest(f, a) {
  const lang = language(pathOf(f));
  const skip = SKIP[lang];
  const lines = linesAbove(f, a);
  if (lang === 'py' && f.hunks.some(h => h.lines.some(l => l.newLine != null && PYTESTMARK.test(l.text)))) return false;
  const own = indentOf(a.text);
  let j = lines.length - 1;
  for (; j >= 0; j--) {
    const t = lines[j].text;
    if (!t.trim() || isCommentLine(t)) continue;
    if (skip?.test(t)) return false;
    if (TEST_HEADER.test(t)) break;
    if (GUARD.test(t)) return false;
    if (indentOf(t) < own && NESTED_DECL[lang]?.test(t)) return false;
  }
  if (j < 0) return false;
  if (lines.slice(Math.max(0, j - 2), j).some(l => skip?.test(l.text))) return false;
  // What encloses the header: each line further out than the last, with the annotations on it.
  let depth = indentOf(lines[j].text);
  let outer = null;
  for (let k = j - 1; k >= 0 && depth > 0; k--) {
    const t = lines[k].text;
    if (!t.trim() || isCommentLine(t) || indentOf(t) >= depth) continue;
    depth = indentOf(t);
    outer ??= t;
    if (skip?.test(t)) return false;
    for (let m = k - 1; m >= 0 && /^\s*@/.test(lines[m].text) && indentOf(lines[m].text) === depth; m--) {
      if (skip?.test(lines[m].text)) return false;
    }
  }
  // pytest only collects test functions in a class named Test*, or in a unittest TestCase.
  if (lang === 'py' && indentOf(lines[j].text) > 0) {
    if (!outer || !/^\s*class\s+(?:Test\w*\s*[(:]|\w+\s*\([^)]*TestCase)/.test(outer)) return false;
  }
  return true;
}

// Added asserts keyed so a renamed receiver class or an edited failure message still matches, and
// for each deleted test file whether every one of its checks reappears inside a live test
// elsewhere. Each added line backs one removed line at most. Cached, so both rules see one answer.
const moveCache = new WeakMap();
function moveCoverage(ctx) {
  if (moveCache.has(ctx)) return moveCache.get(ctx);
  const pool = new Map();
  for (const g of ctx.files) {
    const collected = g.newPath != null && ctx.isTest(g.newPath) && runnerCollects(g.newPath);
    const junit = testContext(g);
    for (const a of g.added) {
      if (!isAssertLine(a.text)) continue;
      const key = moveKey(a.text, junit);
      if (!pool.has(key)) pool.set(key, []);
      pool.get(key).push({ g, a, live: collected && inLiveTest(g, a) });
    }
  }
  const used = new Set();
  const result = new Map();
  for (const f of ctx.files) {
    if (f.status !== 'deleted' || f.oldPath == null || !ctx.isTest(f.oldPath)) continue;
    const checks = f.removed.filter(r => isAssertLine(r.text));
    if (!checks.length) continue;
    const junit = testContext(f);
    const picks = [];
    for (const r of checks) {
      const e = (pool.get(moveKey(r.text, junit)) ?? []).find(x => x.live && x.g !== f && !used.has(x) && !picks.includes(x));
      if (e) picks.push(e);
    }
    // No partial credit: copying half the checks is what a cheat would do.
    const covered = picks.length === checks.length;
    if (covered) for (const e of picks) used.add(e);
    const counts = new Map();
    for (const e of picks) counts.set(e.g, (counts.get(e.g) ?? 0) + 1);
    const top = [...counts].sort((x, y) => y[1] - x[1])[0];
    result.set(f, { covered, n: picks.length, m: checks.length, file: top ? pathOf(top[0]) : null });
  }
  const out = { pool, used, result };
  moveCache.set(ctx, out);
  return out;
}

// ---- rewrites: a check changed in the change that changed the code it calls -----------------

const escapeName = (s) => s.replace(/\$/g, '\\$');

// Expected values and the direction of a check flattened, so a line that only flipped or re-pinned
// what it expects matches its old self.
function flattenCheck(t) {
  return skeleton(t)
    .replace(/===|!==|==|!=|<=|>=|(?<![-=])>|</g, ' CMP ')
    .replace(/!(?=[\w$(])/g, '')
    .replace(/\b(null|undefined|None|nil|true|false|True|False|S|N)\b/g, 'L')
    .replace(/\bassert(True|False)\b/g, 'assertBool')
    .replace(/\bassert(Null|NotNull)\b/g, 'assertNullity')
    .replace(/\.not\.(toBe|toEqual)\b/g, '.$1')
    .replace(/\s+/g, ' ').trim();
}

// Every call to name with its arguments dropped: f(a, b) reads f().
function dropArgs(t, name) {
  const re = new RegExp(`(?<![\\w$])${escapeName(name)}\\s*\\(`, 'g');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(t))) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(t, open);
    if (close < 0) break;
    out += t.slice(last, open + 1) + ')';
    last = close + 1;
    re.lastIndex = close + 1;
  }
  return out + t.slice(last);
}

// The ref that makes removed line x and added line y one check rewritten: equal once the calls
// whose arity changed lose their arguments and renamed names take the new name, or equal up to
// the expected value when the change edits code the line calls (not when `exact`). Null when there is none.
function rewriteRef(idx, refs, x, y, exact) {
  let why = null;
  for (const q of refs) {
    if (q.status === 'arity') { x = dropArgs(x, q.name); y = dropArgs(y, q.name); why ??= q; }
    if (q.status === 'renamed') { x = x.replace(new RegExp(`(?<![\\w$])${escapeName(q.name)}(?![\\w$])`, 'g'), q.to); why ??= q; }
  }
  if (why && x === y) return why;
  if (exact) return null;
  const changed = refs.find(q => q.status === 'renamed' || q.status === 'arity'
    || (q.status === 'kept' && q.kind !== 'type' && q.where != null && idx.touched(q.name, q.where)));
  return changed && flattenCheck(x) === flattenCheck(y) ? changed : null;
}

// Pairs removed with added assertions of one file, one to one, nearest line first. `same` are
// pairs that differ only in the failure message: the check itself is unchanged, so neither side
// is a finding. `pairs` are rewrites, reported SOFT.
function pairRewrites(ctx, f, removed, added) {
  const junit = testContext(f);
  const msgless = (t) => collapse(dropMessage(t, junit));
  const free = new Set(added);
  const nearest = (r) => [...free].sort((x, y) => Math.abs(x.line - r.line) - Math.abs(y.line - r.line));
  const same = new Map();
  for (const r of removed) {
    const a = nearest(r).find(x => msgless(x.text) === msgless(r.text));
    if (a) { free.delete(a); same.set(r, a); }
  }
  const idx = sourceIndex(ctx);
  const pairs = new Map();
  // Exact rewrites first, so a check that only matches up to its expected value cannot take the
  // partner of one that matches outright.
  for (const exact of [true, false]) {
    for (const r of removed) {
      if (same.has(r) || pairs.has(r)) continue;
      const refs = subjectRefs(ctx, f, r.text);
      if (!refs.length) continue;
      for (const a of nearest(r)) {
        const ref = rewriteRef(idx, refs, msgless(r.text), msgless(a.text), exact);
        if (ref) { free.delete(a); pairs.set(r, { a, ref }); break; }
      }
    }
  }
  return { same, pairs, addedLeft: [...free] };
}

const TRIVIAL_OPERAND = /^(-?[01](\.0+)?[fFdDlL]?|null|None|undefined|nil|""|''|true|false|True|False)$/;
// A comparison whose two sides are both something real: "x <= windowW" is, "x > 0" and "x != null" are not.
function comparesReal(t) {
  for (const m of t.matchAll(/===|!==|==|!=|<=|>=|(?<![-=<])>(?![>=])|<(?![<=])/g)) {
    let depth = 0;
    let i = m.index - 1;
    for (; i >= 0; i--) {
      const c = t[i];
      if (')]}'.includes(c)) depth++;
      else if ('([{'.includes(c)) { if (depth === 0) break; depth--; }
      else if (c === ',' && depth === 0) break;
    }
    const left = t.slice(i + 1, m.index).split(/&&|\|\|/).pop().trim();
    const right = argUpToClose(t.slice(m.index + m[0].length)).split(/&&|\|\|/)[0].trim();
    if (left && right && !TRIVIAL_OPERAND.test(left) && !TRIVIAL_OPERAND.test(right)) return true;
  }
  for (const m of t.matchAll(/[\w$)\]]\s*\.(?:equals|contains)\s*\(/g)) {
    const arg = argUpToClose(t.slice(m.index + m[0].length));
    if (arg && !TRIVIAL_OPERAND.test(arg)) return true;
  }
  return false;
}

// assertTrue(X.f(a)), expect(f(a)).toBe(true) or assert f(a): a yes or no check on one call to f.
function predicateCallee(t) {
  let arg = null;
  const at = /\bassert(?:True|False)\s*\(/.exec(t) ?? /\bexpect\s*\((?=.*\)\s*\.(?:not\.)?toBe\s*\(\s*(?:true|false)\s*\))/.exec(t);
  if (at) {
    const open = at.index + at[0].length - 1;
    const close = closeOf(t, open);
    if (close > 0) arg = splitTop(t.slice(open + 1, close))[0].trim();
  } else {
    arg = /^\s*assert\s+(.+?)\s*(?:,.*)?$/.exec(t)?.[1] ?? null;
  }
  const call = arg && /^(?:[\w$]+\.)*([\w$]+)\s*\(/.exec(arg);
  if (!call || closeOf(arg, call[0].length - 1) !== arg.length - 1) return null;
  return call[1];
}

// A helper parameter's name: "Pool p" and "p: Pool" and "p=None" all give p.
const paramName = (p) => {
  const s = p.split('=')[0].trim();
  return s.includes(':') ? s.split(':')[0].trim() : s.split(/\s+/).pop();
};
// A helper check that is worth something: not a tautology, not a null check, not a bare truthy one.
const solidCheck = (t) => isAssertLine(t) && !TAUTOLOGY.some(re => re.test(t))
  && !/!=\s*null\b|\bassertNotNull\b|\bisNotNull\b|\btoBeDefined\b/.test(t) && (!WEAK.test(t) || comparesReal(t));

// The checks in the bodies of helpers this change adds to test files, by helper name. Built once a scan.
const helperCache = new WeakMap();
function addedHelpers(ctx) {
  if (helperCache.has(ctx)) return helperCache.get(ctx);
  const out = new Map();
  for (const g of ctx.files) {
    if (g.newPath == null || !ctx.isTest(g.newPath)) continue;
    const lang = language(g.newPath);
    for (const a of g.added) {
      for (const d of declarationsOn(a.text, lang)) {
        if (d.kind !== 'fn') continue;
        const pm = new RegExp(`${escapeName(d.name)}\\s*\\(([^)]*)\\)`).exec(a.text);
        const params = pm && pm[1].trim() ? splitTop(pm[1]).map(paramName) : [];
        const { lines, i } = newSide(g, a);
        if (i < 0) continue;
        if (!out.has(d.name)) out.set(d.name, []);
        for (const l of blockBelow(lines, i).body) if (l.kind === '+' && solidCheck(l.text)) out.get(d.name).push({ g, l, params });
      }
    }
  }
  helperCache.set(ctx, out);
  return out;
}

// The checks in the body of helper `name` that this change adds to another test file.
const helperChecks = (ctx, f, name) => (addedHelpers(ctx).get(name) ?? []).filter(e => e.g !== f);

// Removed checks that now sit in a helper the same hunk calls: each one equals a helper check once
// the helper's parameters are read as the call's arguments. One helper check backs one removed line.
// The helper's check must say what the removed line said. Only when the change also edits the code
// that line calls may it differ in its expected values or direction, and then it stays SOFT.
function helperPairs(ctx, f, removed) {
  const out = new Map();
  const used = new Set();
  const idx = sourceIndex(ctx);
  const own = testContext(f);
  for (const r of removed) {
    const changed = subjectRefs(ctx, f, r.text).some(q => q.status === 'renamed' || q.status === 'arity' || q.status === 'gone'
      || (q.status === 'kept' && q.kind !== 'type' && q.where != null && idx.touched(q.name, q.where)));
    const want = collapse(dropMessage(r.text, own));
    const same = (text, g) => collapse(dropMessage(text, testContext(g))) === want
      || (changed && flattenCheck(dropMessage(text, testContext(g))) === flattenCheck(dropMessage(r.text, own)));
    const added = (f.hunks[r.hunk]?.lines ?? []).filter(l => l.kind === '+' && !isCommentLine(l.text));
    for (const l of added) {
      for (const m of l.text.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
        const close = closeOf(l.text, m.index + m[0].length - 1);
        if (close < 0) continue;
        const inner = l.text.slice(m.index + m[0].length, close);
        const args = inner.trim() ? splitTop(inner).map(s => s.trim()) : [];
        const hit = helperChecks(ctx, f, m[1]).find(({ g, l: b, params }) => {
          if (used.has(b) || params.length !== args.length) return false;
          let text = b.text;
          params.forEach((p, k) => { text = text.replace(new RegExp(`(?<![\\w$.])${escapeName(p)}(?![\\w$])`, 'g'), args[k]); });
          return same(text.trim(), g);
        });
        if (hit) { used.add(hit.l); out.set(r, m[1]); break; }
      }
      if (out.has(r)) break;
    }
  }
  return out;
}

// A removed test whose code was renamed or re-shaped, when some test this change adds calls the new
// shape. The first changed ref, or null.
function reshapedTo(ctx, f, block, isHeader) {
  const refs = block.flatMap(t => subjectRefs(ctx, f, t));
  if (!refs.length || !refs.every(q => q.status === 'renamed' || q.status === 'arity')) return null;
  const names = refs.map(q => (q.status === 'renamed' ? q.to : q.name));
  const calls = new RegExp(`(?<![\\w$])(${names.map(escapeName).join('|')})\\s*\\(`);
  for (const g of ctx.files) {
    for (const h of g.hunks) {
      let inNew = false;
      for (const l of h.lines) {
        if (l.kind === '-') continue;
        if (isHeader(l.text)) inNew = l.kind === '+';
        else if (inNew && l.kind === '+' && calls.test(l.text)) return refs[0];
      }
    }
  }
  return null;
}

const TEST_DELETED_WHY = 'A test file was deleted, so whatever it checked is no longer checked.';

// ---- the rules, in spec order ---------------------------------------------------------------

export const RULES = [
  defineRule({
    id: 'test-deleted', tier: 'HARD', title: 'Test file deleted',
    why: TEST_DELETED_WHY,
  }, (ctx, add) => {
    // Sources this change really deletes. One deleted here and declared again elsewhere is a move
    // of the implementation, and a moved implementation still needs its test.
    const idx = sourceIndex(ctx);
    const goneSources = idx.deletedSources.filter(s => s.reallyGone);
    const goneKeys = new Map(goneSources.map(s => [modKey(s.path), s.path]));
    const dirOf = (p) => p.split('/').slice(0, -1).join('/');
    // Where a test's code usually sits: beside it, under src/main for src/test, and under src/ or
    // the parent for a test/, tests/ or __tests__/ directory.
    const mirrors = (p) => {
      const d = dirOf(p);
      const seg = /(^|\/)(?:test|tests|__tests__)(\/|$)/;
      return new Set([d, d.replace(/(^|\/)src\/test\//, '$1src/main/'), d.replace(seg, '$1src$2'), d.replace(seg, (m, a, b) => (a && b ? '/' : ''))]);
    };
    // The deleted source a deleted test points at, by import, package or mirrored name. A name
    // match alone is not enough: any small file of that name could be deleted alongside.
    const goneSourceFor = (f) => {
      const t = testContext(f);
      const code = f.removed.filter(r => !isCommentLine(r.text)).map(r => r.text);
      for (const s of goneSources) {
        if (s.rec.pkg != null && t.pkg != null) {
          for (const name of s.primary) {
            if (t.types.get(name)?.has(s.rec.pkg)) return s.path;
            const named = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\b`);
            if ((s.rec.pkg === t.pkg || t.wild.has(s.rec.pkg)) && code.some(x => named.test(x))) return s.path;
          }
        }
        if (s.rec.lang === 'py' && [...t.mods].some(m => s.rec.mod === m || s.rec.mod.endsWith('/' + m))) return s.path;
        const stem = stemOf(baseName(f.oldPath));
        if (stem && stem === stemOf(baseName(s.path)) && mirrors(f.oldPath).has(dirOf(s.path))) return s.path;
      }
      const dir = f.oldPath.split('/').slice(0, -1);
      for (const r of f.removed) {
        const m = RELATIVE_IMPORT.exec(r.text);
        if (!m) continue;
        const parts = [...dir];
        for (const seg of (m[1] ?? m[2]).split('/')) {
          if (seg === '..') parts.pop();
          else if (seg !== '.') parts.push(seg);
        }
        const hit = goneKeys.get(modKey(parts.join('/')));
        if (hit) return hit;
      }
      return null;
    };
    const featureMessage = (f) => {
      const source = goneSourceFor(f);
      if (source) return `A test file was deleted together with the code it tests (${source} is deleted in this change too). That is normal when a feature is removed. Check the feature was meant to go.`;
      // Or every check it made calls code this change removes.
      const gone = removedWithFeature(ctx, f, f.removed.filter(r => isAssertLine(r.text)).map(r => r.text));
      if (gone) return `A test file was deleted together with the code it tests (${gone.symbol} is removed from ${gone.file} in this change too). That is normal when a feature is removed. Check the feature was meant to go.`;
      return null;
    };
    for (const f of ctx.files) {
      if (f.oldPath == null || !ctx.isTest(f.oldPath) || isSnapshotPath(f.oldPath)) continue;
      const gone = f.status === 'deleted' || (f.status === 'renamed' && f.newPath != null && !ctx.isTest(f.newPath));
      if (!gone) {
        // A jvm test moved under resources is still on a test path, but the build only copies it.
        if (f.status === 'renamed' && language(f.oldPath) === 'jvm' && !JVM_RESOURCES.test(f.oldPath) && JVM_RESOURCES.test(f.newPath ?? '')) {
          add(f.oldPath, 0, f.oldPath, f.newPath, 'A test file was moved into a resources folder, which the build copies and never compiles, so it no longer runs.');
          continue;
        }
        const out = f.status === 'renamed' && f.newPath != null ? leavesRunnerName(ctx, f) : null;
        if (out) add(f.oldPath, 0, f.oldPath, f.newPath, 'A test file was renamed out of the name its runner looks for, so the runner may no longer find it.', out.softer);
        continue;
      }
      // A fixture, an empty __init__.py or a helper under tests/ is not a test that stopped running.
      const testy = (r) => isAssertLine(r.text) || TEST_HEADER.test(r.text);
      // Every check it made now runs in another test of this change.
      const moved = moveCoverage(ctx).result.get(f);
      if (moved?.covered) continue;
      const plain = language(f.oldPath) === 'other' || (f.status === 'deleted' && !f.binary && !f.removed.some(testy));
      const feature = !plain && f.status === 'deleted' ? featureMessage(f) : null;
      // A move whose new copy sits past the cut looks like a delete. Padding a diff is easy, so it stays hard.
      const cut = ctx.truncated && f.status === 'deleted'
        && !ctx.files.some(g => g.newPath != null && g !== f && baseName(g.newPath) === baseName(f.oldPath));
      let message = feature ?? (cut
        ? `${TEST_DELETED_WHY} The diff was cut off at ${MAX_DIFF_LINES} lines, so if this file was moved, its new copy may be past the cut. Scan a smaller range to check.`
        : undefined);
      if (!feature && moved?.n) message = `${message ?? TEST_DELETED_WHY} ${moved.n} of its ${moved.m} checks reappear in ${moved.file}; the other ${moved.m - moved.n} do not.`;
      add(f.oldPath, 0, f.oldPath, null, message, plain || feature != null);
    }
  }),

  defineRule({
    id: 'test-skipped', tier: 'HARD', title: 'Test switched off',
    why: 'A test was switched off instead of fixed.',
  }, (ctx, add) => {
    for (const { f, a, p } of addedLines(ctx, () => true)) {
      const lang = language(p);
      let hit;
      if (lang === 'rust') {
        // A bare should_panic on a test whose body did not change turns a failing assert into a pass.
        if (/#\[\s*should_panic\b/.test(a.text)) {
          if (/expected\s*=/.test(a.text)) continue;
          const bodyChanged = f.added.some(x => x.hunk === a.hunk && x !== a && x.text.trim() && !isCommentLine(x.text) && !/^\s*#\[/.test(x.text));
          add(p, a.line, null, a.text, undefined, skipIsHarmless(f, a) || bodyChanged);
          continue;
        }
        hit = SKIP.rust.test(a.text);
      } else if (!ctx.isTest(p)) continue;
      else if (lang === 'other') hit = Object.values(SKIP).some(r => r.test(a.text));
      else hit = SKIP[lang].test(a.text);
      if (lang === 'py') {
        const io = f.status === 'added' ? null : importorskipChange(f, a);
        if (io) { add(p, a.line, null, a.text, undefined, io === 'soft'); continue; }
        const named = markerSkip(f, a);
        if (named) { add(p, a.line, null, a.text, undefined, named !== 'name'); continue; }
      }
      if (lang === 'js') {
        // it.todo('title') next to a real test the same change adds is a placeholder for the next one.
        // It is a switched-off test when it replaces a real one, and a lone todo is still reported.
        const todo = JS_TODO_TITLE.exec(a.text);
        if (todo) {
          if (f.removed.some(r => TEST_HEADER.test(r.text) && r.text.includes(todo[3]))) {
            add(p, a.line, null, a.text);
            continue;
          }
          const addsRealTest = f.added.some(x => !isCommentLine(x.text) && TEST_HEADER.test(x.text) && !/\.(todo|skip|fixme|fails|failing)\b/.test(x.text) && /=>|function/.test(x.text));
          if (addsRealTest) continue;
        }
      }
      if (!hit && lang === 'py' && pySkipsOnCi(f, a)) {
        add(p, a.line, null, a.text, undefined, skipIsHarmless(f, a, { ci: true }));
        continue;
      }
      if (hit && lang === 'js') {
        // A test header that carries the marker and replaces no header of that title, in a hunk that
        // removes nothing, is a new test. it.failing and it.fails still run it and fail on a pass.
        // A new it.skip stays as it was: existing tests count those as switched off.
        const born = JS_MARKED_HEADER.exec(a.text);
        if (born && born[2] !== 'todo' && !f.removed.some(r => TEST_HEADER.test(r.text) && r.text.includes(born[4]))
          && !hunkLines(f, a).some(l => l.kind === '-' && l.text.trim() && !isCommentLine(l.text))) {
          if (/^(fails|failing)$/.test(born[2])) continue;
        }
      }
      if (hit) add(p, a.line, null, a.text, undefined, skipIsHarmless(f, a) || (lang === 'js' && CONDITIONAL_SKIP_ALIAS.test(a.text)));
    }
    // filter_run_excluding :tag, with an existing example given that tag in the same change.
    for (const { a, p } of addedLines(ctx, (p) => ctx.isTest(p) && language(p) === 'rb')) {
      const m = /\bfilter_run_excluding\s*\(?\s*(?::(\w+)|(\w+):\s*true)/.exec(a.text);
      if (!m) continue;
      const tag = m[1] ?? m[2];
      if (!newlyTagged(ctx, tag)) continue;
      const guarded = /\b(if|unless)\b/.test(a.text.slice(m.index + m[0].length));
      const runTagged = new RegExp(`--tag\\s+:?${tag}\\b`);
      const runElsewhere = ctx.files.some(g => (isCiPath(pathOf(g)) || isBuildPath(pathOf(g))) && g.added.some(x => runTagged.test(x.text)));
      add(p, a.line, null, a.text, undefined, guarded || runElsewhere);
    }
    // "//go:build ignore" in a test file means go test never compiles it. It is a comment, so addedLines is told to look.
    for (const { f, a, p } of addedLines(ctx, (p) => ctx.isTest(p) && language(p) === 'go', { comments: true })) {
      if (GO_IGNORE_TAG.test(a.text)) add(p, a.line, null, a.text, undefined, f.status === 'added');
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
    // The ones a deleted test file already counted as its new home are spent.
    const { pool, used } = moveCoverage(ctx);
    // Keyed loosely: a check that moved into a helper usually calls its subject by another name.
    const elsewhere = new Map();
    for (const list of pool.values()) {
      for (const e of list) {
        if (used.has(e)) continue;
        const k = looseMoveKey(e.a.text, testContext(e.g));
        if (!elsewhere.has(k)) elsewhere.set(k, []);
        elsewhere.get(k).push(e);
      }
    }
    const movedAway = (f, r) => {
      const owners = elsewhere.get(looseMoveKey(r.text, testContext(f))) ?? [];
      const i = owners.findIndex(e => e.g !== f);
      if (i < 0) return false;
      owners.splice(i, 1);
      return true;
    };
    for (const f of ctx.files) {
      if (f.status === 'deleted') continue;
      const scope = testScope(ctx, f);
      if (!scope) continue;
      const lost = scope.removed.filter(r => isAssertLine(r.text) && !ctx.allAddedTrimmed.has(r.text.trim()) && !movedAway(f, r) && !errGuardDropped(f, r));
      // An assertion on code this change deletes went with its feature. That is also what a cheat
      // dressed as a removal looks like, so it stays on the page as SOFT and out of the count.
      const removed = [];
      for (const r of lost) {
        const gone = removedWithFeature(ctx, f, [r.text]);
        if (!gone) { removed.push(r); continue; }
        add(pathOf(f), r.line, r.text, null, `This assertion was removed along with ${gone.symbol}, which this change deletes from ${gone.file}. Fine if that feature was dropped on purpose.`, true);
      }
      // A check rewritten to the code's new shape pairs with its new form and drops out of the count.
      // An honest API change and a test bent to fit a bug look the same, so the pair stays as SOFT.
      const added = scope.added.filter(a => isAssertLine(a.text));
      const { same, pairs, addedLeft } = pairRewrites(ctx, f, removed, added);
      for (const [r, { a, ref }] of pairs) {
        add(pathOf(f), r.line, r.text, a.text, `This assertion was rewritten in the same change that changed ${ref.name} in ${ref.file}. That is how an honest API change looks, and also how a test gets bent to fit a bug, so red-handed flags it for review instead of failing it.`, true);
      }
      const helped = helperPairs(ctx, f, removed.filter(r => !same.has(r) && !pairs.has(r)));
      for (const [r, name] of helped) {
        add(pathOf(f), r.line, r.text, null, `This assertion was replaced by a call to ${name}, which this change adds with matching checks. Check the helper asserts what the old line did.`, true);
      }
      const unpaired = removed.filter(r => !same.has(r) && !pairs.has(r) && !helped.has(r));
      if (unpaired.length > addedLeft.length) {
        // Several literal asserts folded into a table or a parameterized test look like removals.
        const table = scope.added.some(a => !isCommentLine(a.text) && TABLE.test(a.text));
        // Field asserts on one object folded into a comparison of that whole object are not lost either.
        const whole = wholeObjectSubjects(f, scope.added);
        const folded = whole.length > 0 && unpaired.every(r => whole.some(s => new RegExp(`\\b${s.replace(/[.$]/g, '\\$&')}\\s*\\.\\s*\\w`).test(r.text)));
        for (const r of unpaired.slice(0, 10)) add(pathOf(f), r.line, r.text, null, undefined, table || folded);
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
          // The precise check called code this change removed, renamed or re-shaped. A looser check that
          // still compares two real things, or asks a yes or no of a function the change adds, is how such
          // a rewrite often looks; anything looser than that stays a fail.
          const changed = removedStrong.map(l => subjectRefs(ctx, f, l.text).find(q => q.status === 'gone' || q.status === 'renamed' || q.status === 'arity')).find(Boolean);
          // A weak line that is the rewrite of a line just as weak loosened nothing.
          const asserts = (kind, side) => code(kind).filter(l => isAssertLine(l.text)).map(l => ({ line: l[side], text: l.text, l }));
          const { same, pairs } = pairRewrites(ctx, f, asserts('-', 'oldLine'), asserts('+', 'newLine'));
          const wasWeak = new Set([...same, ...[...pairs].map(([r, p]) => [r, p.a])]
            .filter(([r]) => !STRONG.test(r.text) || BOOL_COMPARE.test(r.text)).map(([, a]) => a.l));
          for (const w of addedWeak) {
            if (wasWeak.has(w)) continue;
            const callee = changed && predicateCallee(w.text);
            const checked = changed != null && (comparesReal(w.text) || (callee != null && sourceIndex(ctx).newlyDeclared(callee)));
            add(pathOf(f), w.newLine, removedStrong[0].text, w.text, checked
              ? `A precise assertion was replaced by a looser one in the same change that removed or renamed ${changed.name} in ${changed.file}. Flagged for review instead of failing, because the new check still compares against something real.`
              : undefined, checked);
          }
        }
        // is(503) turned into anyOf(is(503), is(500), is(200)) on the same subject: the set of accepted
        // values grew. Honest widening exists too, so soft.
        const rem = h.lines.filter(l => l.kind === '-' && isAssertLine(l.text));
        const ad = h.lines.filter(l => l.kind === '+' && isAssertLine(l.text));
        for (let i = 0; i < Math.min(rem.length, ad.length); i++) {
          if (!WIDENING.test(ad[i].text) || WIDENING.test(rem[i].text)) continue;
          const subject = assertSubject(ad[i].text);
          if (subject && subject === assertSubject(rem[i].text)) add(pathOf(f), ad[i].newLine, rem[i].text, ad[i].text, undefined, true);
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
        if (isCommentLine(a.text)) continue;
        if (TAUTOLOGY.some(r => r.test(a.text)) || patchedReturnAsserted(f, a) || spyReturnAsserted(f, a)) { add(f.newPath, a.line, null, a.text); continue; }
        const self = selfComparison(f, a);
        if (self) add(f.newPath, a.line, null, a.text, undefined, self === 'soft');
      }
    }
  }),

  defineRule({
    id: 'test-detection', tier: 'HARD', title: 'Code checks if it runs under test',
    why: 'Production code now checks whether it is running under a test, which is how code fakes a pass.',
  }, (ctx, add) => {
    const pathOk = (p) => isSourceFile(ctx, p) && !isBuildPath(p) && !isCiPath(p)
      && !TEST_INFRA.some(s => ('/' + p).includes(s));
    for (const { f, a, p } of addedLines(ctx, pathOk)) {
      if (TEST_DETECTION.test(a.text)) add(p, a.line, null, a.text, undefined, CONFIG_PATH.test(p));
      // #[cfg(not(test))] is cfg!(test) in attribute form: hard on a statement in a body, soft on an item.
      if (language(p) === 'rust' && CFG_NOT_TEST.test(a.text)) {
        const { lines, i } = newSide(f, a);
        const next = i >= 0 ? lines[i + 1]?.text : undefined;
        add(p, a.line, null, a.text, undefined, !(next != null && /^\s+/.test(next) && !RUST_ITEM.test(next)));
      }
    }
    // #if DEBUG in a C# source file: dotnet test builds Debug, so an early success return in it is a bypass.
    // Preprocessor lines start with '#', so addedLines is told to read them.
    for (const { f, a, p } of addedLines(ctx, (p) => pathOk(p) && language(p) === 'cs', { comments: true })) {
      if (!CS_DEBUG_IF.test(a.text)) continue;
      const { lines, i } = newSide(f, a);
      if (i < 0) continue;
      for (let j = i + 1; j < lines.length && !CS_DIRECTIVE_END.test(lines[j].text); j++) {
        if (lines[j].kind === '+' && CS_EARLY_RETURN.test(lines[j].text)) { add(p, a.line, null, a.text, undefined, true); break; }
      }
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
        if (isCommentLine(a.text) && baseName(p) !== '.rspec') continue; // every .rspec line starts with --
        if (RUNNER.test(a.text)) {
          if (NEUTER.test(a.text)) add(p, a.line, null, a.text);
          else if (ignoresTestPaths(f, a)) add(p, a.line, null, a.text);
          else {
            const left = negatedFilter(a.text);
            if (left) add(p, a.line, null, a.text, undefined, left.every(n => DOCS_LIKE.test(n)));
          }
        }
        if (RUNNER.test(a.text) && /--invert\b/.test(a.text)) {
          const g = /(?:--grep|--fgrep|-g|-f)[= ]\s*(['"]?)([^'"\s]+)\1/.exec(a.text);
          if (g) add(p, a.line, null, a.text, undefined, invertsTestTiers(g[2]));
        }
        if (baseName(p) === 'tox.ini' && TOX_DASH.test(a.text)) {
          // A leading dash tells tox to ignore the exit code. Hard when the same command lost its dash-less twin.
          const plain = collapse(a.text.replace(/^(\s*)-\s*/, '$1'));
          add(p, a.line, null, a.text, undefined, !f.removed.some(r => collapse(r.text) === plain));
        }
        for (const [flag, tool, extra] of COLLECT_ONLY) {
          if (!RUNNER.test(a.text) || !tool.test(a.text) || !flag.test(a.text)) continue;
          // Hard when a real run of the same tool was taken out of the file; a new collection step is soft.
          add(p, a.line, null, a.text, extra, !f.removed.some(r => tool.test(r.text) && RUNNER.test(r.text) && !flag.test(r.text)));
        }
        if (/\bINSTA_FORCE_PASS\b\s*[:=]\s*['"]?(1|true|yes)\b/i.test(a.text)) {
          // cargo insta test still reports pending snapshots, plain cargo test does not.
          add(p, a.line, null, a.text, undefined, f.hunks.some(h => h.lines.some(l => /\bcargo\s+insta\s+test\b/.test(l.text))));
        }
        const deselect = /\baddopts\s*=.*-m\s+(['"]?)(.+?)\1(?:\s|$|")|\bpytest\b.*-m\s+(['"])(.+?)\3/.exec(a.text);
        const markers = [...(deselect?.[2] ?? deselect?.[4] ?? '').matchAll(/\bnot\s+(\w+)/g)].map(m => m[1]);
        if (markers.length) {
          const verdicts = markers.map(mk => deselectedTag(ctx, mk));
          if (verdicts.includes('hard')) add(p, a.line, null, a.text);
          else if (verdicts.includes('soft')) add(p, a.line, null, a.text, undefined, true);
        }
        if (baseName(p) === '.rspec') {
          const m = /--exclude-pattern[= ]\s*['"]?([^'"\s]+)/.exec(a.text);
          if (m) {
            // A file named outright is a dropped test; a directory glob is usually a split, soft when CI runs it.
            const named = /_spec\.rb$/.test(m[1]) && !baseName(m[1]).includes('*');
            const dir = m[1].replace(/\*.*$/, '').replace(/\/$/, '');
            const runElsewhere = dir !== '' && ctx.files.some(g => isCiPath(pathOf(g)) && g.added.some(x => RUNNER.test(x.text) && x.text.includes(dir)));
            add(p, a.line, null, a.text, undefined, !named || runElsewhere);
          }
        }
        if (pkg && NEUTERED_SCRIPT.test(a.text)) add(p, a.line, null, a.text);
        if (build && (BUILD_NEUTER.test(a.text) || ignoresRealDirs(a.text) || excludesRealDirs(f, a))) add(p, a.line, null, a.text);
        if (baseName(p) === 'Cargo.toml') {
          if (/^\s*test\s*=\s*false\b/.test(a.text)) {
            const sec = cargoSection(f, a);
            if (sec === 'test') add(p, a.line, null, a.text);
            else if (sec == null) add(p, a.line, null, a.text, undefined, true);
          } else if (/^\s*autotests\s*=\s*false\b/.test(a.text)) {
            add(p, a.line, null, a.text, undefined, true);
          }
        }
        if (baseName(p) === 'Rakefile') {
          const m = /\.exclude\s*\(([^)]*)\)/.exec(a.text);
          const paths = (m?.[1].match(/'[^']*'|"[^"]*"/g) ?? []).map(q => q.slice(1, -1));
          const named = paths.filter(q => /_(test|spec)\.rb$/.test(q));
          const dirs = paths.filter(q => /^(test|spec)\//.test(q) && !/^(test|spec)\/(fixtures|support|helpers)\b/.test(q) && !/_(test|spec)\.rb$/.test(q));
          if (named.length || dirs.length) {
            const moved = ctx.files.some(g => g.added.some(x => x !== a && /Rake::TestTask|\bt\.(pattern|test_files)\b|RakeTask/.test(x.text) && [...named, ...dirs].some(q => x.text.includes(q))));
            add(p, a.line, null, a.text, undefined, moved || !named.length);
          }
        }
        if (ci && /^\s*(-\s+)?if\s*:\s*(false|\$\{\{\s*false\s*\}\})\s*$/.test(a.text) && stepRuns(stepOf(f, a))) {
          add(p, a.line, null, a.text);
        }
      }
      if (/^\.mocharc\./.test(baseName(p))) {
        // "grep" with "invert": true runs everything except the specs that match.
        const live = f.added.filter(x => !isCommentLine(x.text));
        const grep = live.find(x => /["']?(grep|fgrep)["']?\s*:/.test(x.text));
        if (grep && live.some(x => /["']?invert["']?\s*:\s*true\b/.test(x.text))) {
          const value = /["']?(?:grep|fgrep)["']?\s*:\s*(["'`]?)([^"'`,]*)\1/.exec(grep.text)?.[2] ?? '';
          add(p, grep.line, null, grep.text, undefined, invertsTestTiers(value));
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
    for (const c of coverageChanges(ctx).hard) {
      add(c.p, c.l.newLine, c.old.text, c.l.text, 'A coverage threshold was cut by 20 points or more in a change that adds code or leaves source out of coverage.');
    }
    for (const c of coverageChanges(ctx).patternHard) {
      add(c.p, c.l.newLine, null, c.l.text, 'Coverage exclude patterns that are a keyword and wildcards match nearly every line, which empties the threshold without lowering it.');
    }
    // TestMain that exits 0 whatever m.Run returned.
    for (const { f, a, p } of addedLines(ctx, (p) => ctx.isTest(p) && language(p) === 'go')) {
      if (!/^\s*os\.Exit\(\s*0\s*\)/.test(a.text)) continue;
      const hunk = hunkLines(f, a);
      const lostCode = hunk.some(l => l.kind === '-' && /\bos\.Exit\(\s*(?!0\s*\))[^)]+\)/.test(l.text));
      const inTestMain = hunk.some(l => l.newLine != null && /func\s+TestMain\s*\(\s*\w+\s+\*testing\.M/.test(l.text));
      if (lostCode || inTestMain) add(p, a.line, null, a.text);
    }
    // exit in an after(:suite) hook forces a zero status. An exit inside a fork block is ordinary.
    for (const { f, a, p } of addedLines(ctx, (p) => ctx.isTest(p) && language(p) === 'rb')) {
      if (!/^\s*exit!?\s*\(?\s*(0|true)?\s*\)?\s*$/.test(a.text)) continue;
      const { lines, i } = newSide(f, a);
      if (i < 0) continue;
      if (lines.slice(Math.max(0, i - 5), i).some(l => /\b(after|append_after|prepend_after)\s*\(\s*:suite\s*\)|\bat_exit\b|Minitest\.after_run/.test(l.text))) add(p, a.line, null, a.text);
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
        // Any glob can cover tests or snapshots, except media and binaries that cannot hold either.
        const ext = /\.([A-Za-z0-9]+)$/.exec(token);
        return !ext || !(MEDIA_EXT.test(ext[1]) || BINARY_EXT.test(ext[1]));
      }
      return language(token) !== 'other';
    };
    // "[attr]vendored -diff" defines a macro, and "*.java vendored" then hides java under a name
    // HIDE_ATTR does not know. Macros may use other macros.
    const macros = new Set();
    const defs = ctx.files.filter(g => g.newPath != null && baseName(g.newPath) === '.gitattributes')
      .flatMap(g => g.hunks.flatMap(h => h.lines.filter(l => l.newLine != null)))
      .map(l => /^\s*\[attr\]([\w.-]+)\s+(.*)$/.exec(l.text)).filter(Boolean);
    const usesMacro = (attrs) => attrs.split(/\s+/).some(x => macros.has(x));
    for (let grew = true; grew;) {
      grew = false;
      for (const [, name, attrs] of defs) {
        if (!macros.has(name) && (HIDE_ATTR.test(attrs) || usesMacro(attrs))) { macros.add(name); grew = true; }
      }
    }
    // Patterns start with '*' here, which the shared comment check would swallow; only '#' is a comment.
    for (const { a, p } of addedLines(ctx, (p) => baseName(p) === '.gitattributes', { comments: true })) {
      if (a.text.trim().startsWith('#')) continue;
      const hides = HIDE_ATTR.test(a.text) || (!/^\s*\[attr\]/.test(a.text) && usesMacro(a.text.trim().split(/\s+/).slice(1).join(' ')));
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
    // pytest collects test functions only inside a class named Test* (or a unittest TestCase). A
    // class renamed out of that name keeps every def test_ line and silently stops running them.
    const PY_COLLECTED = /^\s*class\s+(?:Test\w*\s*[(:]|\w+\s*\([^)]*TestCase)/;
    for (const f of ctx.files) {
      if (f.status === 'deleted' || f.newPath == null || !ctx.isTest(f.newPath) || language(f.newPath) !== 'py') continue;
      const lost = f.removed.find(r => PY_COLLECTED.test(r.text));
      if (!lost || f.added.some(a => PY_COLLECTED.test(a.text))) continue;
      const renamedTo = f.added.find(a => /^\s*class\s+\w+/.test(a.text));
      const stillTests = f.hunks.some(h => h.lines.some(l => l.newLine != null && /^\s+(?:async\s+)?def\s+test_/.test(l.text)));
      if (renamedTo && stillTests) add(f.newPath, renamedTo.line, lost.text, renamedTo.text, 'A pytest class was renamed so its name no longer starts with Test, so pytest stops collecting the tests in it.');
    }
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
      for (const r of removedH.slice(0, 10)) {
        const block = removedBlock(f, r, header);
        const gone = removedWithFeature(ctx, f, block);
        const reshaped = !gone && reshapedTo(ctx, f, block, header);
        if (gone) add(pathOf(f), r.line, r.text, null, `A test was removed along with ${gone.symbol}, which this change deletes from ${gone.file}. Fine if that feature was dropped on purpose.`, true);
        else if (reshaped) add(pathOf(f), r.line, r.text, null, `A test was replaced in the same change that renamed or re-shaped ${reshaped.name} in ${reshaped.file}. Check the new test covers what the old one did.`, true);
        else add(pathOf(f), r.line, r.text, null, undefined, addedH > 0);
      }
    }
  }),

  defineRule({
    id: 'unit-mocked', tier: 'HARD', title: 'Test mocks the code it tests',
    why: 'A test file mocks the module it is the test for, so its assertions check the mock and not the code.',
  }, (ctx, add) => {
    for (const { f, a, p } of addedLines(ctx, (p) => ctx.isTest(p) && language(p) === 'js')) {
      const m = UNIT_MOCK.exec(a.text);
      if (!m) continue;
      const spec = m[3];
      if (stemOf(baseName(spec)) !== stemOf(baseName(p))) continue;
      const imported = f.hunks.some(h => h.lines.some(l => {
        if (l.newLine == null) return false;
        const im = RELATIVE_IMPORT.exec(l.text);
        return im != null && (im[1] ?? im[2]) === spec;
      }));
      if (!imported) continue;
      // A factory that spreads the real module is a partial mock of it.
      const { lines, i } = newSide(f, a);
      const partial = lines.slice(i, i + 11).some(l => MOCK_ACTUAL.test(l.text));
      add(p, a.line, null, a.text, undefined, partial);
    }
  }),

  defineRule({
    id: 'stubbed-call-asserted', tier: 'HARD', title: 'Test stubs the call it makes',
    why: 'A test stubs a method on an object and then calls that same method, so what it checks is the stub.',
  }, (ctx, add) => {
    for (const { f, a, p } of addedLines(ctx, ctx.isTest)) {
      const m = STUB_DO.exec(a.text) ?? STUB_WHEN.exec(a.text);
      if (!m) continue;
      const [, recv, method] = m;
      const call = new RegExp('\\b' + recv + '\\.' + method + '\\s*\\(');
      const { lines, i } = newSide(f, a);
      if (!lines.slice(i + 1).some(l => call.test(l.text) && !/\b(when|verify)\s*\(/.test(l.text))) continue;
      // A spy over the instance under test is the case no honest partial mock looks like.
      const spied = new RegExp('\\b' + recv + '\\s*=\\s*(Mockito\\.)?spy\\s*\\(');
      add(p, a.line, null, a.text, undefined, !f.added.some(x => spied.test(x.text)));
    }
  }),

  defineRule({
    id: 'snapshot-garbage', tier: 'HARD', title: 'Snapshot holds NaN',
    why: 'A saved snapshot or expected string now holds NaN, [object Object] or Invalid Date where it held a real value.',
  }, (ctx, add) => {
    for (const f of ctx.files) {
      const p = f.newPath;
      if (p == null) continue;
      const snap = isSnapshotPath(p);
      if (!snap && !ctx.isTest(p)) continue;
      // In a test file only an expected string counts: toBe(NaN) is how NaN is tested.
      const bad = (t) => (snap ? SNAPSHOT_GARBAGE.test(t) : !isCommentLine(t) && INLINE_EXPECTED.test(t) && QUOTED_GARBAGE.test(t));
      for (const h of f.hunks) {
        const rem = h.lines.filter(l => l.kind === '-');
        h.lines.filter(l => l.kind === '+').forEach((l, k) => {
          if (!bad(l.text)) return;
          const twin = rem.find(r => skeleton(r.text) === skeleton(l.text)) ?? rem[k];
          if (twin && bad(twin.text)) return;
          // A brand-new line has nothing to compare with, so an honest new snapshot of NaN stays soft.
          add(p, l.newLine, twin?.text ?? null, l.text, undefined, !twin);
        });
      }
    }
  }),

  defineRule({
    id: 'assertion-swallowed', tier: 'HARD', title: 'Assertion failure caught',
    why: 'A test catches its own assertion failures and carries on, so the assertions inside can no longer fail it.',
  }, (ctx, add) => {
    // cy.on('fail', () => false) hands every failure back as a pass. Only Cypress code calls on('fail'),
    // and support files are not test paths, so every js file is read. uncaught:exception is not touched.
    for (const { f, a, p } of addedLines(ctx, (p) => language(p) === 'js')) {
      if (CYPRESS_FAIL_SWALLOW.test(a.text)) { add(p, a.line, null, a.text); continue; }
      if (!CYPRESS_FAIL_OPEN.test(a.text)) continue;
      const { lines, i } = newSide(f, a);
      if (i < 0) continue;
      const blk = blockBelow(lines, i);
      if (!blk.body.some(l => /\bthrow\b/.test(l.text))) add(p, a.line, null, a.text, undefined, true);
    }
    for (const { f, a, p } of addedLines(ctx, ctx.isTest)) {
      const lang = language(p);
      const t = a.text;
      if (lang === 'py' && SUPPRESS_ASSERTION.test(t)) { add(p, a.line, null, t); continue; }
      const { lines, i } = newSide(f, a);
      if (i < 0) continue;
      // The try block above must hold an assertion and must not be the "expected to throw" shape.
      const tryHoldsAssert = (open) => {
        const body = lines.slice(open + 1, i);
        return body.some(l => isAssertLine(l.text)) && !body.some(l => TRY_FAILS.test(l.text));
      };

      const py = lang === 'py' && /^\s*except\s*\(?[^:]*\bAssertionError\b[^:]*:\s*(.*)$/.exec(t);
      if (py) {
        const inline = py[1].replace(/\s*#.*$/, '').trim();
        const blk = inline ? { body: [{ text: inline }], seen: true } : blockBelow(lines, i);
        if (blk.body.some(l => isAssertLine(l.text) || HANDLER_ESCAPE.test(l.text))) continue;
        const open = openerAbove(lines, i, /^\s*try\s*:/);
        if (open != null && !tryHoldsAssert(open)) continue;
        add(p, a.line, null, t, undefined, open == null || !blk.seen);
      } else if ((lang === 'js' || lang === 'jvm' || lang === 'cs') && CATCH_OPEN.test(t)) {
        const typed = ASSERTION_TYPES.test(t);
        const blk = blockBelow(lines, i);
        if (blk.body.some(l => isAssertLine(l.text) || HANDLER_ESCAPE.test(l.text))) continue;
        // A catch of an ordinary error only counts when all it does is log.
        if (!typed && !blk.body.every(l => LOG_ONLY.test(l.text) || isCommentLine(l.text))) continue;
        const open = openerAbove(lines, i, /\btry\s*\{\s*$/);
        if (open == null ? !typed : !tryHoldsAssert(open)) continue;
        add(p, a.line, null, t, undefined, open == null || !blk.seen);
      } else if (lang === 'rb' && /^\s*rescue\s+[^#\n]*/.test(t) && ASSERTION_TYPES.test(t)) {
        const blk = blockBelow(lines, i);
        if (blk.body.some(l => isAssertLine(l.text))) continue;
        // A rescue that retries or re-raises is how wait-until helpers are written.
        add(p, a.line, null, t, undefined, blk.body.some(l => HANDLER_ESCAPE.test(l.text)) || !blk.seen);
      }
    }
  }),

  defineRule({
    id: 'test-case-removed', tier: 'SOFT', title: 'Test case removed',
    why: 'A row was taken out of a table of test cases and none was added, so the test covers fewer inputs.',
  }, (ctx, add) => {
    for (const f of ctx.files) {
      if (f.status === 'deleted' || !fileIsTest(ctx, f)) continue;
      // A case that moved into a test of its own is not lost.
      if (f.added.some(a => !isCommentLine(a.text) && TEST_HEADER.test(a.text))) continue;
      for (const h of f.hunks) {
        for (const l of removedRows(h).slice(0, 10)) add(pathOf(f), l.oldLine, l.text, null);
      }
    }
  }),

  defineRule({
    id: 'coverage-lowered', tier: 'SOFT', title: 'Coverage gate loosened',
    why: 'A coverage threshold was lowered, or source was left out of coverage. Fine if it was meant, a cheat if it makes the build pass.',
  }, (ctx, add) => {
    const { soft, exclusions, patternSoft } = coverageChanges(ctx);
    for (const c of soft) add(c.p, c.l.newLine, c.old.text, c.l.text);
    for (const e of exclusions) add(e.p, e.l.newLine, null, e.l.text);
    for (const e of patternSoft) add(e.p, e.l.newLine, null, e.l.text);
  }),

  defineRule({
    id: 'expectation-edited', tier: 'SOFT', title: 'Expected value changed',
    why: 'The expected value in an assertion changed. Fine if the behavior was meant to change, a cheat if the test was bent to match a bug.',
  }, (ctx, add) => {
    for (const f of ctx.files) {
      const scope = testScope(ctx, f);
      if (!scope) continue;
      for (const h of scope.hunks) {
        const rem = h.lines.filter(l => l.kind === '-' && isAssertLine(l.text));
        const ad = h.lines.filter(l => l.kind === '+' && isAssertLine(l.text));
        for (let i = 0; i < Math.min(rem.length, ad.length); i++) {
          if (skeleton(rem[i].text) === skeleton(ad[i].text) && collapse(rem[i].text) !== collapse(ad[i].text)) {
            add(pathOf(f), ad[i].newLine, rem[i].text, ad[i].text);
          } else if (literalToExpression(rem[i].text, ad[i].text)) {
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
      if (!hit && EXCEPT_OPEN.test(t)) {
        const next = nextCodeLine(f, a) ?? '';
        hit = /^\s*(pass|\.\.\.)\s*$/.test(next) || (EXCEPT_BROAD.test(t) && DEFAULT_RETURN_PY.test(next));
      }
      if (!hit && CATCH_OPEN.test(t)) hit = DEFAULT_RETURN_JS.test(nextCodeLine(f, a) ?? '') && /^\s*}\s*$/.test(nextCodeLine(f, a, 1) ?? '');
      if (!hit && language(p) === 'go' && ctx.isTest(p)) hit = goRecoverSwallows(f, a);
      if (!hit && language(p) === 'rb') {
        hit = RESCUE_INLINE.test(t) || (RESCUE_OPEN.test(t) && /^\s*(next|nil|end)\s*$/.test(nextCodeLine(f, a) ?? ''));
      }
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
    id: 'input-special-cased', tier: 'SOFT', title: 'Input special-cased',
    why: 'A source function now returns a fixed answer for specific inputs, which is how code passes a test without solving the problem.',
  }, (ctx, add) => {
    for (const { f, a, p } of addedLines(ctx, (p) => isSourceFile(ctx, p))) {
      if (inputSpecialCased(f, a) || floatGuardChain(f, a) || lookupTableGuard(f, a)) add(p, a.line, null, a.text);
    }
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
      const cut = (language(p) === 'rust' && RUST_CASES_CUT.test(a.text)) || (language(p) === 'py' && PY_EXAMPLES_CUT.test(a.text));
      if (FLAKE.test(a.text) || cut) { flagged.add(a); add(p, a.line, null, a.text); }
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
