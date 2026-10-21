import { matchesAny } from './glob.mjs';

const norm = (p) => String(p).replace(/\\/g, '/');

const TEST_PATTERNS = [
  /(^|\/)(test|tests|__tests__|spec|specs|testing)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /(^|\/)test_[^\/]*\.py$/i,
  /_test\.py$/i,
  /(^|\/)conftest\.py$/i,
  /(^|\/)src\/test\//i,
  /(Test|Tests|IT|Spec)\.(java|kt|kts|scala|groovy)$/, // case-sensitive, or Submit.java counts as a test
  /_test\.go$/i,
  /(Test|Tests)\.cs$/,
  /(^|\/)[^\/]*\.Tests?\//i,
  /_spec\.rb$/i,
  /_test\.rb$/i,
];

export function isTestPath(p, extraGlobs = []) {
  const s = norm(p);
  return TEST_PATTERNS.some(r => r.test(s)) || matchesAny(s, extraGlobs);
}

const LANGUAGES = new Map([
  ['js', 'js'], ['jsx', 'js'], ['mjs', 'js'], ['cjs', 'js'], ['ts', 'js'], ['tsx', 'js'], ['mts', 'js'], ['cts', 'js'],
  ['py', 'py'],
  ['java', 'jvm'], ['kt', 'jvm'], ['kts', 'jvm'], ['scala', 'jvm'], ['groovy', 'jvm'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['cs', 'cs'],
  ['rb', 'rb'],
]);

export function language(p) {
  const m = /\.([^./]+)$/.exec(norm(p));
  return (m && LANGUAGES.get(m[1].toLowerCase())) || 'other';
}

const EXCLUDED_DIRS = /(^|\/)(node_modules|vendor|dist|build|target|\.venv)\//;

export function isSourcePath(p, extraTestGlobs = []) {
  const s = norm(p);
  return language(s) !== 'other'
    && !isTestPath(s, extraTestGlobs)
    && !EXCLUDED_DIRS.test(s)
    && !/\.min\.js$/i.test(s)
    && !/\.d\.ts$/i.test(s);
}

const SNAPSHOT_PATTERNS = [
  /__snapshots__\//,
  /\.snap$/,
  /\.ambr$/,
  /(^|\/)testdata\/.*\.golden$/,
  /\.golden$/,
  /\.approved\.[^\/]+$/,
  /\.received\.[^\/]+$/,
];

export function isSnapshotPath(p) {
  const s = norm(p);
  return SNAPSHOT_PATTERNS.some(r => r.test(s));
}

const CI_PATTERNS = [
  /^\.github\/workflows\/[^\/]+\.ya?ml$/,
  /^\.circleci\//,
  /(^|\/)\.gitlab-ci\.yml$/,
  /(^|\/)azure-pipelines\.yml$/,
  /(^|\/)Jenkinsfile$/,
  /(^|\/)\.travis\.yml$/,
  /(^|\/)bitbucket-pipelines\.yml$/,
];

export function isCiPath(p) {
  const s = norm(p);
  return CI_PATTERNS.some(r => r.test(s));
}

const BUILD_GLOBS = [
  'package.json', 'Makefile', 'makefile', 'justfile', 'Justfile', 'tox.ini', 'noxfile.py',
  'pytest.ini', 'setup.cfg', 'pyproject.toml', 'build.gradle', 'build.gradle.kts', 'pom.xml',
  'Cargo.toml', 'jest.config.{js,ts,mjs,cjs,json}', 'vitest.config.{js,ts,mjs,mts}', 'karma.conf.js',
  '.mocharc.{js,json,yml,yaml,cjs}', 'playwright.config.{js,ts}', 'cypress.config.{js,ts}',
  'phpunit.xml', 'Rakefile', '.rspec', 'Directory.Build.props', '*.csproj',
];

export function isBuildPath(p) {
  return matchesAny(norm(p), BUILD_GLOBS);
}

// A line is an assertion when it matches this and is not a comment (see isCommentLine).
export const ASSERT = /\bexpect\s*\(|\bassert\w*\s*[\(!]|\bassert\s+\S|\bassert\.\w+\s*\(|\bself\.assert\w+\s*\(|\bAssert\.\w+\s*\(|\bAssertions\.\w+|\bassertThat\s*\(|\b(require|assert)\.\w+\s*\(t\b|\bt\.(Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(|\bassert_(eq|ne)?!\s*\(|\bpanic!\s*\(|\bshould\b|\.should\s*\(|\bexpect\s*\{|\bverify\s*\(|\bfail\s*\(|\bpytest\.raises\s*\(|\bwith\s+self\.assertRaises/;

// Trimmed lines starting with a comment marker. Rust attributes and the
// python type/noqa/pylint pragmas look like comments but are code for our purposes.
export function isCommentLine(text) {
  const t = String(text).trim();
  if (/^#\[/.test(t) || /^#\s*(type:|noqa|pylint)/.test(t)) return false;
  return /^(\/\/|#|\/\*|\*|--)/.test(t);
}
