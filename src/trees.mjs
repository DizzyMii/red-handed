// The base and head trees around a diff, as the rules may read them. A source can carry
// trees = { base, head }, each { list() -> string[] | null, read(path) -> string | null | undefined,
// capped }. read answers a file's text, null when the file is not in that tree, and undefined
// when nobody knows (not fetched, over a cap, binary). Without trees every read is undefined, and
// the engine judges on the diff alone, as it always did.

import { indexText } from './symbols.mjs';

const cache = new WeakMap();

export function treeAccess(ctx) {
  if (cache.has(ctx)) return cache.get(ctx);
  const trees = ctx.source?.trees;
  const available = !!(trees?.base && trees?.head);
  const reads = new Map();
  const lists = new Map();
  const files = new Map();
  const acc = {
    available,
    // Asks made while no trees were there, for the note.
    wanted: 0,
    read(side, p) {
      if (!available) { acc.wanted++; return undefined; }
      const key = `${side}\0${p}`;
      if (!reads.has(key)) {
        let v;
        try { v = trees[side].read(p); } catch { v = undefined; }
        reads.set(key, typeof v === 'string' ? v.replace(/\r\n/g, '\n') : v === null ? null : undefined);
      }
      return reads.get(key);
    },
    list(side) {
      if (!available) { acc.wanted++; return null; }
      if (!lists.has(side)) {
        let v;
        try { v = trees[side].list(); } catch { v = null; }
        lists.set(side, Array.isArray(v) ? new Set(v) : null);
      }
      return lists.get(side);
    },
    file(side, p) {
      const key = `${side}\0${p}`;
      if (!files.has(key)) {
        const text = acc.read(side, p);
        files.set(key, typeof text === 'string' ? indexText(p, text) : text);
      }
      return files.get(key);
    },
    get capped() { return available && !!(trees.base.capped || trees.head.capped); },
    get cap() { return trees?.base?.cap ?? trees?.head?.cap ?? null; },
  };
  cache.set(ctx, acc);
  return acc;
}
