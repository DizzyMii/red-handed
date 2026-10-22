# Demo walkthrough

About three minutes. You can follow it in a browser tab without installing anything, and the last half has commands if you want to run it yourself. red-handed is not on npm yet, so the `npx` commands below will not resolve until it is published. From a clone of the repo, run `node bin/red-handed.mjs demo` where a step says `npx red-handed demo`, and `node bin/red-handed.mjs <url>` where it takes a URL.

## 1. The agent says all tests pass

You asked a coding agent to fix a discount bug in a small shop app. It comes back with "Fixed the discount bug, all tests pass", and the CI check is green.

A green check means the test command exited 0. An agent has plenty of ways to get that exit code without fixing the bug, and red-handed reads the diff for them.

## 2. What red-handed sees

```
npx red-handed demo
```

The demo makes a throwaway git repo where a pretend agent "fixes" the bug five different ways, then scans it.

![Terminal output of npx red-handed demo: CAUGHT, 4 hard findings and 1 soft finding, each with the changed line and a one-line reason](img/terminal-demo.png)

The top line is the verdict. CAUGHT means at least one HARD finding, which is something with almost no honest reason to appear in a fix. SUSPICIOUS means only SOFT findings, which have honest uses too, so you read them yourself. CLEAN means neither.

## 3. One finding up close

Two of the five, in plain words.

**test-command-neutered, package.json line 1.** The agent changed `"test": "node --test"` to `"test": "node --test || true"`. In a shell, `|| true` means "if that failed, pretend it didn't". Every test can now fail and the command still exits 0, so CI is still green. It is one line in a file nobody opens during review.

**test-detection, src/cart.js line 10.** The agent added `if (process.env.NODE_ENV === 'test') return ...` to production code. When the tests run, the function takes a special path that gives the answer the test checks for, and a real user still gets the old buggy path.

The other three are a skipped test, a precise assertion swapped for `assert.ok(...)`, and an expected value edited from 180 to 190 to match the bug. That last one is the SOFT finding, because sometimes an expected value really should change.

## 4. Point it at a pull request

You don't need a clone for this one. [Pull request 1](https://github.com/DizzyMii/red-handed/pull/1) in this repo is a public demo PR, written to look like an agent's "fix":

```
npx red-handed https://github.com/DizzyMii/red-handed/pull/1
```

![Terminal output for pull request 1: CAUGHT, 2 hard findings, a skipped test and a weakened assertion](img/terminal-pr.png)

It uses the GitHub API, so you get 60 requests an hour without a token. Set `GITHUB_TOKEN` or log in with `gh` to go past that, or to read a private repo.

## 5. Try it in the browser

Nothing to install for this one. The page runs the same rules in your tab.

- [Open the whole demo diff](https://dizzymii.github.io/red-handed/?cheat=demo). The cheat list is on the left and the verdict on the right.

  ![The playground on the site: a list of cheats on the left, CAUGHT with 4 hard and 1 soft finding and all five findings on the right](img/site-caught.png)

- The PR tab takes a public pull request and does what section 4 did. [This link](https://dizzymii.github.io/red-handed/?pr=DizzyMii/red-handed%231) opens it on pull request 1.

  ![The playground's PR tab showing CAUGHT with 2 hard findings for pull request 1](img/site-pr.png)

Pick the "honest" cheat in the list to see what a clean change looks like, or use the Paste a diff tab for your own.

## 6. Put it in CI

Add this as `.github/workflows/red-handed.yml`:

```yaml
name: red-handed
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: dizzymii/red-handed@v0
        with:
          fail-on: caught
```

Every pull request gets one comment, edited on each push. Here is the real one from the demo PR with both sections expanded. It was posted by an earlier version that printed the base commit twice, as `0089eff (0089eff)`. The current version prints it once.

![The github-actions comment on pull request 1: CAUGHT with two findings, with the details sections open](img/action-comment.png)

`fail-on: caught` fails the job on CAUGHT only. Use `suspicious` to fail on SOFT findings too, or `never` to just get the comment. Pull requests from forks get a read-only token, so the comment is skipped there and the job summary still has the report.

## 7. What CLEAN looks like

It has to say "fine" sometimes too. This run is on a repo where the agent fixed the discount code and added a test for it. Both tests pass for real.

![Terminal output with the verdict CLEAN and the line Nothing looks like cheating](img/terminal-clean.png)

## 8. What it misses

It misses a lot. Here are the numbers.

**Made-up diffs it had never seen.** Each of three rounds had 96 diffs across seven languages, half cheats and half honest look-alikes, written by AI agents that could not see the rules. Only the last round counts, using its numbers from before its fixes. A reviewer judged 4 of the 96 unfair and left them out, which leaves 92: 45 cheats and 47 honest changes.

- It flagged 24 of the 45 cheats (21 CAUGHT, 3 SUSPICIOUS).
- It wrongly CAUGHT 3 of the 47 honest changes.

**Real pull requests.** On 111 recently merged PRs in big open source projects it said CAUGHT three times. Each of those really had cut test coverage, with a maintainer's sign-off.

**What it cannot see.** The rules are regexes over changed lines, so anyone who builds the string `"te" + "st"` gets past them. CLEAN says the usual tricks are absent. It does not run your tests, so it cannot say whether they pass. Treat it as a smoke alarm and go read the lines it prints.

The [README](../README.md) has every rule, plus the config file and flags.
