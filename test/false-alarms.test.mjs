// False alarms from a sweep over real repos, rebuilt as synthetic diffs, and the cheats each fix
// must keep catching. honest_ cases must not be CAUGHT; cheat_ cases must keep a HARD finding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, hits, mkDiff } from './helpers.mjs';

const CAUGHT = (r) => r.verdict === 'CAUGHT';
const notCaught = (r) => r.verdict !== 'CAUGHT';
const onlySoft = (found) => found.length > 0 && found.every(f => f.tier === 'SOFT');
const allHard = (found) => found.length > 0 && found.every(f => f.tier === 'HARD');
const hard = (r, rule) => hits(r, rule).filter(f => f.tier === 'HARD');
const show = (r) => r.findings.map(f => `${f.tier} ${f.rule} ${f.file}:${f.line} ${f.before ?? ''}`).join('\n');

// ---- .gitattributes on real binary types ------------------------------------------------------

const attrs = (lines, opts) => mkDiff('.gitattributes', [], lines, opts);

test('honest_fp4_jar_binary: *.jar binary hides nothing a reviewer reads', () => {
  const r = run(attrs(['*.jar binary']));
  assert.equal(hits(r, 'diff-hidden').length, 0, show(r));
});

test('honest_fp4_wrapper_and_class: spaced jar, class files and the gradle wrapper jar', () => {
  const r = run(attrs(['*.jar   binary', '*.class binary', 'gradle/wrapper/*.jar -diff']));
  assert.equal(hits(r, 'diff-hidden').length, 0, show(r));
});

test('honest_fp4_new_attributes_file: text=auto plus binary jars and nbt in a new file', () => {
  const r = run(attrs(['* text=auto eol=lf', '*.jar binary', '*.nbt binary'], { status: 'added' }));
  assert.equal(hits(r, 'diff-hidden').length, 0, show(r));
});

test('cheat_fp4_java_diff: *.java -diff still hides source', () => {
  assert.ok(allHard(hits(run(attrs(['*.java -diff'])), 'diff-hidden')));
});

test('cheat_fp4_no_plain_extension: *.ja? and *.j* still count', () => {
  const found = hits(run(attrs(['*.ja? binary', '*.j* -diff'])), 'diff-hidden');
  assert.equal(found.length, 2);
  assert.ok(allHard(found));
});

test('cheat_fp4_json_binary: json holds snapshots and fixtures', () => {
  assert.ok(allHard(hits(run(attrs(['*.json binary'])), 'diff-hidden')));
});

test('cheat_fp4_kt_next_to_jar: the kt line stays HARD', () => {
  const found = hits(run(attrs(['*.jar binary', '*.kt binary'])), 'diff-hidden');
  assert.equal(found.length, 1);
  assert.match(found[0].after, /\*\.kt/);
  assert.equal(found[0].tier, 'HARD');
});

test('cheat_fp4_root_commit: every file added, .gitattributes hides java', () => {
  const r = run([
    mkDiff('src/main/java/demo/App.java', [], ['package demo;', 'class App {}'], { status: 'added' }),
    attrs(['*.java -diff'], { status: 'added' }),
  ]);
  assert.ok(allHard(hits(r, 'diff-hidden')));
});
