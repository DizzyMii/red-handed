// Hunks from real pull requests that red-handed called CAUGHT and that were honest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, hits } from './helpers.mjs';

const diff = (lines) => lines.join(String.fromCharCode(10)) + String.fromCharCode(10);

// facebook/react#37853. The hunk only adds lines: a regression test for a bug fixed in a
// follow-up, written as it.failing so it still runs and fails the build if it starts passing.
const react_37853_new_it_failing = diff([
  "diff --git a/packages/react-dom/src/__tests__/ReactDOMFizzStaticBrowser-test.js b/packages/react-dom/src/__tests__/ReactDOMFizzStaticBrowser-test.js",
  "--- a/packages/react-dom/src/__tests__/ReactDOMFizzStaticBrowser-test.js",
  "+++ b/packages/react-dom/src/__tests__/ReactDOMFizzStaticBrowser-test.js",
  "@@ -864,3 +864,10 @@",
  "     expect(getVisibleChildren(container)).toEqual(<div>Hello</div>);",
  "   });",
  " ",
  "+  it.failing('can resume after a resumed prerender aborts again', async () => {",
  "+    const controller = new AbortController();",
  "+    const prerendered = await serverAct(() =>",
  "+      ReactDOMFizzStatic.prerender(<App />, {signal: controller.signal}),",
  "+    );",
  "+    expect(prerendered.postponed).not.toBe(null);",
  "+  });",
  "+",
]);

test('wild react#37853: a new it.failing test is not a test that was switched off', () => {
  const r = run(react_37853_new_it_failing);
  assert.deepEqual(hits(r, 'test-skipped'), []);
  assert.notEqual(r.verdict, 'CAUGHT');
});
