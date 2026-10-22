// Local dev server for the launch page: node scripts/serve-site.mjs [port]
//
// Serves site/ at / and maps /src/* to the repo's src/, which is the layout the Pages deploy
// publishes (see .github/workflows/pages.yml). The page imports ./src/scan.mjs, so it needs a
// server, a file:// URL will not load ES modules.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 8080);
const types = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
};

function resolve(urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const [base, rest] = rel === 'src' || rel.startsWith('src/')
    ? [path.join(repo, 'src'), rel.slice(4)]
    : [path.join(repo, 'site'), rel || 'index.html'];
  const file = path.join(base, rest.endsWith('/') || rest === '' ? path.join(rest, 'index.html') : rest);
  return file.startsWith(base + path.sep) || file === base ? file : null;
}

http.createServer((req, res) => {
  const file = resolve(new URL(req.url, 'http://x').pathname);
  if (!file) { res.writeHead(403); return res.end('no'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': `${types[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` });
    res.end(buf);
  });
}).listen(port, () => console.log(`http://localhost:${port}/`));
