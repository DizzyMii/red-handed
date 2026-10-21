import fs from 'node:fs';

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

function version() {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}

export async function main(argv = [], io = {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  fetch: globalThis.fetch,
  cwd: process.cwd(),
  stdin: process.stdin,
}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout.write(HELP);
    return 0;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    io.stdout.write(`${version()}\n`);
    return 0;
  }
  io.stderr.write('red-handed: not implemented yet\n');
  return 2;
}
