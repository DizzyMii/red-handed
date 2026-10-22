import fs from 'node:fs';
import path from 'node:path';
import { version } from './version.mjs';
import { scan } from './scan.mjs';
import { localSource, fileSource, stdinSource, prSource, parsePrSpec } from './sources.mjs';
import { terminal, markdown, json, rulesList, wantColor } from './report.mjs';
import { runDemo } from './demo.mjs';
import { RULES } from './rules.mjs';

const HELP = `red-handed: catch AI agents cheating on tests in a code diff

Examples:
  npx red-handed                                  scan the local repo against its base branch
  npx red-handed demo                             watch it catch a pretend agent
  npx red-handed https://github.com/o/r/pull/1    scan a public pull request
  git diff main | npx red-handed -                scan a diff from stdin

Usage:
  red-handed [target] [--base <ref>] [--format terminal|json|markdown] [--json]
             [--strict] [--no-color] [--max <n>]
  red-handed demo
  red-handed rules
  red-handed --help | -h
  red-handed --version | -v

Exit codes: 0 clean or suspicious, 1 caught, 2 error.
`;

class UsageError extends Error {}

const FORMATS = ['terminal', 'json', 'markdown'];

function parseArgs(argv) {
  const opts = { target: null, base: null, format: 'terminal', strict: false, noColor: false, max: 30 };
  const value = (i, flag) => {
    if (i + 1 >= argv.length) throw new UsageError(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    if (a.startsWith('--') && a.includes('=')) {
      inline = a.slice(a.indexOf('=') + 1);
      a = a.slice(0, a.indexOf('='));
    }
    const take = () => {
      if (inline !== null) return inline;
      const v = value(i, a);
      i++;
      return v;
    };
    if (a === '--base') opts.base = take();
    else if (a === '--format') {
      opts.format = take();
      if (!FORMATS.includes(opts.format)) throw new UsageError(`unknown format "${opts.format}": expected terminal, json or markdown`);
    } else if (a === '--json') opts.format = 'json';
    else if (a === '--strict') opts.strict = true;
    else if (a === '--no-color') opts.noColor = true;
    else if (a === '--max') {
      const n = Number(take());
      if (!Number.isInteger(n) || n < 1) throw new UsageError('--max needs a positive whole number');
      opts.max = n;
    } else if (a !== '-' && a.startsWith('-')) throw new UsageError(`unknown option ${a}`);
    else if (opts.target === null) opts.target = a;
    else throw new UsageError(`unexpected extra argument "${a}"`);
  }
  return opts;
}

async function buildSource(opts, io) {
  const t = opts.target;
  if (t === null) return localSource(io.cwd, opts.base);
  if (t === '-') return stdinSource(io.stdin);
  if (parsePrSpec(t)) return prSource(t, { fetch: io.fetch, env: io.env, version: version() });
  const file = path.resolve(io.cwd, t);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return fileSource(file);
  throw new UsageError(`unknown target "${t}": expected a GitHub PR URL, owner/repo#N, a .diff file or -`);
}

export async function main(argv = [], io = {}) {
  io = {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    fetch: globalThis.fetch,
    cwd: process.cwd(),
    stdin: process.stdin,
    ...io,
  };
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout.write(HELP);
    return 0;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    io.stdout.write(`${version()}\n`);
    return 0;
  }
  try {
    const opts = parseArgs(argv);
    const color = wantColor(io, opts.noColor);
    if (opts.target === 'rules') {
      io.stdout.write(rulesList(RULES, { color }));
      return 0;
    }
    if (opts.target === 'demo') return await runDemo(io, { noColor: opts.noColor });
    const source = await buildSource(opts, io);
    const result = scan(source);
    if (opts.format === 'json') io.stdout.write(json(result));
    else if (opts.format === 'markdown') io.stdout.write(markdown(result));
    else io.stdout.write(terminal(result, { color, max: opts.max, dumb: io.env?.TERM === 'dumb' }));
    if (result.verdict === 'CAUGHT') return 1;
    if (result.verdict === 'SUSPICIOUS' && opts.strict) return 1;
    return 0;
  } catch (e) {
    io.stderr.write(`red-handed: ${e.message}\n`);
    if (e instanceof UsageError) io.stderr.write(`\n${HELP}`);
    return 2;
  }
}
