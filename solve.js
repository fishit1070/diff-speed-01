// A faster drop-in for makefun-diff 1.0.0: run(input) returns makefun-diff's own patch of the input, byte for byte,
// by the same rule its header states — the same line cut, the same prefix/suffix trim, the same greedy Myers search
// with make.fun's tie-break (the deletion when a deletion and an insertion reach the same point), no edge pruning,
// the same first path to both ends, and the same patch assembly. The difference is only in how the search is
// computed: lines are interned to integer ids, the search is pure integer arithmetic over a trace of the furthest
// old position per diagonal per edit count (no object allocated per step), and the winning path's runs are
// reconstructed by walking that trace backwards with the same candidate rules the forward pass used. The trace
// holds old positions + 1 in 16-bit slots whenever the middles are at most 60000 lines (the value always fits);
// longer middles take an identical 32-bit trace.

/** The patch's first word, and the kept lines a hunk shows around each change run. */
const FORMAT = 'makefun-diff/1';
const CONTEXT = 3;

/** Run kinds, as small ints in the search; the patch writes '=', '-', '+' for them. */
const KEEP = 0;
const DELETE = 1;
const INSERT = 2;
const OPCHAR = ['=', '-', '+'];

/** Middles up to this many lines take the 16-bit trace (old position + 1 <= 60001 < 65535, the missing mark). */
const SMALL_LIMIT = 60000;

/**
 * Cut a text into its lines and intern each distinct line to an integer id shared by both texts of a case, so
 * line equality is integer equality. Lines are cut after every "\n"; a last line with no "\n" is a line too and
 * is interned apart (it differs from the same text with a newline). Fills `ids` with the text's line ids and
 * `idStr` (shared) with id -> the full line as the patch writes it.
 */
function scanLines(text, map, bareMap, idStr, ids) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  for (let i = 0; i < last; i++) {
    const part = parts[i];
    let id = map.get(part);
    if (id === undefined) {
      id = idStr.length;
      map.set(part, id);
      idStr.push(part + '\n');
    }
    ids.push(id);
  }
  const tail = parts[last];
  if (tail !== '') {
    let id = bareMap.get(tail);
    if (id === undefined) {
      id = idStr.length;
      bareMap.set(tail, id);
      idStr.push(tail);
    }
    ids.push(id);
  }
}

/**
 * The runs of the edit script of a into b (the middle slices, as integer-id arrays), as parallel arrays of kinds
 * and counts in order — the same runs the reference's linked-list history yields, reconstructed from the
 * furthest-point trace. Positions follow the reference: an old position is the last old line consumed (-1 for
 * none), and the candidate rules (a move past either text's end is no candidate, the -2 of a missing candidate,
 * the deletion on a tie) are applied exactly as the forward pass applies them. 16-bit trace: slot values are
 * old positions + 1, and 0xffff marks a diagonal no path reaches.
 */
function editRuns16(a, b) {
  const MISS = 0xffff;
  const oldLen = a.length;
  const newLen = b.length;
  const oldEnd = oldLen - 1;
  const newEnd = newLen - 1;
  let capLevels = 8192;
  let trace = new Uint16Array((capLevels * (capLevels + 1)) / 2);
  let x = -1;
  let y = -1;
  while (x < oldEnd && y < newEnd && a[x + 1] === b[y + 1]) {
    x++;
    y++;
  }
  trace[0] = x + 1;
  let foundD = 0;
  let foundK = 0;
  if (!(x + 1 >= oldLen && y + 1 >= newLen)) {
    foundD = -1;
    const maxEdit = oldLen + newLen;
    outer: for (let d = 1; d <= maxEdit; d++) {
      if (d + 1 > capLevels) {
        const nc = capLevels * 2;
        const nt = new Uint16Array((nc * (nc + 1)) / 2);
        nt.set(trace);
        trace = nt;
        capLevels = nc;
      }
      const basePrev = ((d - 1) * d) / 2;
      const baseCur = (d * (d + 1)) / 2;
      const kTarget = oldLen - newLen;
      let prevAddW = MISS;
      let k = -d - 2;
      for (let j = 0; j <= d; j++) {
        k += 2;
        const remW = j >= 1 ? prevAddW : MISS;
        const addW = j <= d - 1 ? trace[basePrev + j] : MISS;
        prevAddW = addW;
        const canRemove = remW !== MISS && remW < oldLen;
        const canAdd = addW !== MISS && addW - 1 - k < newLen;
        if (!canRemove && !canAdd) {
          trace[baseCur + j] = MISS;
          continue;
        }
        const byDeletion = canRemove ? remW : -2;
        const byInsertion = canAdd ? addW - 1 : -2;
        let sx = byDeletion >= byInsertion ? remW : addW - 1;
        let sy = sx - k;
        while (sx < oldEnd && sy < newEnd && a[sx + 1] === b[sy + 1]) {
          sx++;
          sy++;
        }
        trace[baseCur + j] = sx + 1;
        if (k === kTarget && sx === oldEnd) {
          foundD = d;
          foundK = k;
          break outer;
        }
      }
    }
    if (foundD === -1) throw new Error('makefun-diff: the search ended without reaching both ends');
  }
  return backtrack16(trace, foundD, foundK, oldLen, newLen);
}

/** Walk the 16-bit trace backwards from the winning cell, re-deriving each move with the forward rules. */
function backtrack16(trace, foundD, foundK, oldLen, newLen) {
  const MISS = 0xffff;
  const segKinds = [];
  const segCounts = [];
  let cx = trace[(foundD * (foundD + 1)) / 2 + (foundK + foundD) / 2] - 1;
  let ck = foundK;
  for (let d = foundD; d >= 1; d--) {
    const basePrev = ((d - 1) * d) / 2;
    const j = (ck + d) / 2;
    const remW = j >= 1 ? trace[basePrev + j - 1] : MISS;
    const addW = j <= d - 1 ? trace[basePrev + j] : MISS;
    const canRemove = remW !== MISS && remW < oldLen;
    const canAdd = addW !== MISS && addW - 1 - ck < newLen;
    const byDeletion = canRemove ? remW : -2;
    const byInsertion = canAdd ? addW - 1 : -2;
    let prevX;
    let kind;
    if (byDeletion >= byInsertion) {
      prevX = remW - 1;
      kind = DELETE;
    } else {
      prevX = addW - 1;
      kind = INSERT;
    }
    const stepX = kind === DELETE ? prevX + 1 : prevX;
    const snake = cx - stepX;
    if (snake > 0) {
      segKinds.push(KEEP);
      segCounts.push(snake);
    }
    segKinds.push(kind);
    segCounts.push(1);
    cx = prevX;
    ck = kind === DELETE ? ck - 1 : ck + 1;
  }
  if (cx + 1 > 0) {
    segKinds.push(KEEP);
    segCounts.push(cx + 1);
  }
  return mergeSegments(segKinds, segCounts);
}

/** The same search with a 32-bit trace of plain old positions (-1 for none), for middles past SMALL_LIMIT. */
function editRuns32(a, b) {
  const MISSING = -2147483648;
  const oldLen = a.length;
  const newLen = b.length;
  const oldEnd = oldLen - 1;
  const newEnd = newLen - 1;
  let capLevels = 8192;
  let trace = new Int32Array((capLevels * (capLevels + 1)) / 2);
  let x = -1;
  let y = -1;
  while (x < oldEnd && y < newEnd && a[x + 1] === b[y + 1]) {
    x++;
    y++;
  }
  trace[0] = x;
  let foundD = 0;
  let foundK = 0;
  if (!(x + 1 >= oldLen && y + 1 >= newLen)) {
    foundD = -1;
    const maxEdit = oldLen + newLen;
    outer: for (let d = 1; d <= maxEdit; d++) {
      if (d + 1 > capLevels) {
        const nc = capLevels * 2;
        const nt = new Int32Array((nc * (nc + 1)) / 2);
        nt.set(trace);
        trace = nt;
        capLevels = nc;
      }
      const basePrev = ((d - 1) * d) / 2;
      const baseCur = (d * (d + 1)) / 2;
      const kTarget = oldLen - newLen;
      let prevAdd = MISSING;
      let k = -d - 2;
      for (let j = 0; j <= d; j++) {
        k += 2;
        const rem = j >= 1 ? prevAdd : MISSING;
        const add = j <= d - 1 ? trace[basePrev + j] : MISSING;
        prevAdd = add;
        const canRemove = rem !== MISSING && rem + 1 < oldLen;
        const canAdd = add !== MISSING && add - k < newLen;
        if (!canRemove && !canAdd) {
          trace[baseCur + j] = MISSING;
          continue;
        }
        const byDeletion = canRemove ? rem + 1 : -2;
        const byInsertion = canAdd ? add : -2;
        let sx = byDeletion >= byInsertion ? rem + 1 : add;
        let sy = sx - k;
        while (sx < oldEnd && sy < newEnd && a[sx + 1] === b[sy + 1]) {
          sx++;
          sy++;
        }
        trace[baseCur + j] = sx;
        if (k === kTarget && sx === oldEnd) {
          foundD = d;
          foundK = k;
          break outer;
        }
      }
    }
    if (foundD === -1) throw new Error('makefun-diff: the search ended without reaching both ends');
  }
  const segKinds = [];
  const segCounts = [];
  let cx = trace[(foundD * (foundD + 1)) / 2 + (foundK + foundD) / 2];
  let ck = foundK;
  for (let d = foundD; d >= 1; d--) {
    const basePrev = ((d - 1) * d) / 2;
    const j = (ck + d) / 2;
    const rem = j >= 1 ? trace[basePrev + j - 1] : MISSING;
    const add = j <= d - 1 ? trace[basePrev + j] : MISSING;
    const canRemove = rem !== MISSING && rem + 1 < oldLen;
    const canAdd = add !== MISSING && add - ck < newLen;
    const byDeletion = canRemove ? rem + 1 : -2;
    const byInsertion = canAdd ? add : -2;
    let prevX;
    let kind;
    if (byDeletion >= byInsertion) {
      prevX = rem;
      kind = DELETE;
    } else {
      prevX = add;
      kind = INSERT;
    }
    const stepX = kind === DELETE ? prevX + 1 : prevX;
    const snake = cx - stepX;
    if (snake > 0) {
      segKinds.push(KEEP);
      segCounts.push(snake);
    }
    segKinds.push(kind);
    segCounts.push(1);
    cx = prevX;
    ck = kind === DELETE ? ck - 1 : ck + 1;
  }
  if (cx + 1 > 0) {
    segKinds.push(KEEP);
    segCounts.push(cx + 1);
  }
  return mergeSegments(segKinds, segCounts);
}

/** Reverse the backwards-collected segments into chronological runs, merging neighbours of one kind. */
function mergeSegments(segKinds, segCounts) {
  const kinds = [];
  const counts = [];
  for (let i = segKinds.length - 1; i >= 0; i--) {
    const kind = segKinds[i];
    if (kinds.length > 0 && kinds[kinds.length - 1] === kind) counts[counts.length - 1] += segCounts[i];
    else {
      kinds.push(kind);
      counts.push(segCounts[i]);
    }
  }
  return { kinds, counts };
}

/** A line as the patch writes it: its op, the line, a newline, and "%" on a line of its own when it had none. */
function written(op, line) {
  return line.endsWith('\n') ? `${op}${line}` : `${op}${line}\n%\n`;
}

/** makefun-diff's patch of the two texts, assembled exactly as the reference assembles it. */
function diffPatch(oldText, newText) {
  const map = new Map();
  const bareMap = new Map();
  const idStr = [];
  const aIds = [];
  const bIds = [];
  scanLines(oldText, map, bareMap, idStr, aIds);
  scanLines(newText, map, bareMap, idStr, bIds);
  const a = (i) => idStr[aIds[i]];
  const b = (j) => idStr[bIds[j]];
  const n = aIds.length;
  const m = bIds.length;

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && aIds[prefix] === bIds[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && aIds[n - 1 - suffix] === bIds[m - 1 - suffix]) suffix++;

  const aMid = Int32Array.from(aIds).subarray(prefix, n - suffix);
  const bMid = Int32Array.from(bIds).subarray(prefix, m - suffix);
  const mid = aMid.length <= SMALL_LIMIT && bMid.length <= SMALL_LIMIT ? editRuns16(aMid, bMid) : editRuns32(aMid, bMid);

  const kinds = [];
  const counts = [];
  if (prefix > 0) {
    kinds.push(KEEP);
    counts.push(prefix);
  }
  for (let i = 0; i < mid.kinds.length; i++) {
    kinds.push(mid.kinds[i]);
    counts.push(mid.counts[i]);
  }
  if (suffix > 0) {
    kinds.push(KEEP);
    counts.push(suffix);
  }

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (let r = 0; r < kinds.length; r++) {
    const kind = kinds[r];
    const count = counts[r];
    if (kind === KEEP) {
      o += count;
      p += count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (kind === DELETE) {
      c.dels += count;
      o += count;
      deleted += count;
    } else {
      c.ins += count;
      p += count;
      inserted += count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written(OPCHAR[KEEP], a(at)));
      for (let i = 0; i < c.dels; i++) out.push(written(OPCHAR[DELETE], a(c.o + i)));
      for (let i = 0; i < c.ins; i++) out.push(written(OPCHAR[INSERT], b(c.p + i)));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written(OPCHAR[KEEP], a(at)));
  }
  return out.join('');
}

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  return diffPatch(input.old, input.new);
}
