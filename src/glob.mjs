// Glob matching copied from the RPIV helper, extended with {a,b} alternatives.
// Case-insensitive always. A glob without a slash matches the basename anywhere.

function translate(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
        else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) { re += '\\{'; continue; }
      const alts = glob.slice(i + 1, end).split(',');
      re += '(?:' + alts.map(translate).join('|') + ')';
      i = end;
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return re;
}

export function globToRegex(glob) {
  const prefix = glob.includes('/') ? '' : '(?:.*/)?';
  return new RegExp('^' + prefix + translate(glob) + '$', 'i');
}

const globCache = new Map();
export function matchesAny(relPath, globs) {
  if (relPath == null) return false;
  const p = String(relPath).replace(/\\/g, '/');
  return (globs || []).some(g => {
    let r = globCache.get(g);
    if (!r) { r = globToRegex(g); globCache.set(g, r); }
    return r.test(p);
  });
}
