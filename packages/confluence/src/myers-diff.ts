/** A differing region: `a[aStart, aEnd)` is replaced by `b[bStart, bEnd)`; either side may be empty. */
export interface DiffHunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

interface Window {
  a: readonly number[];
  b: readonly number[];
  offset: number;
  n: number;
  m: number;
}

interface EditStep {
  x: number;
  y: number;
  insert: boolean;
}

function commonPrefix(a: readonly number[], b: readonly number[]): number {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) {
    length++;
  }
  return length;
}

function commonSuffix(a: readonly number[], b: readonly number[], prefix: number): number {
  let length = 0;
  while (
    length < a.length - prefix &&
    length < b.length - prefix &&
    a[a.length - 1 - length] === b[b.length - 1 - length]
  ) {
    length++;
  }
  return length;
}

/** Furthest-reaching paths per edit distance; trace[d] holds diagonals -d-1..d+1 before step d. */
function forwardTrace(w: Window, maxEdits: number): Int32Array[] | undefined {
  const max = Math.min(w.n + w.m, maxEdits);
  const center = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(center - d - 1, center + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[center + k - 1] < v[center + k + 1]);
      let x = down ? v[center + k + 1] : v[center + k - 1] + 1;
      let y = x - k;
      while (x < w.n && y < w.m && w.a[w.offset + x] === w.b[w.offset + y]) {
        x++;
        y++;
      }
      v[center + k] = x;
      if (x >= w.n && y >= w.m) {
        return trace;
      }
    }
  }
  return undefined;
}

function backtrack(trace: Int32Array[], n: number, m: number): EditStep[] {
  const steps: EditStep[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d];
    const at = (k: number) => v[k + d + 1];
    const k = x - y;
    const insert = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevX = at(insert ? k + 1 : k - 1);
    const prevY = prevX - (insert ? k + 1 : k - 1);
    steps.push({ x: prevX, y: prevY, insert });
    x = prevX;
    y = prevY;
  }
  return steps.reverse();
}

function toHunks(steps: EditStep[], offset: number): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  for (const step of steps) {
    const last = hunks[hunks.length - 1];
    const ax = step.x + offset;
    const by = step.y + offset;
    const hunk = last && last.aEnd === ax && last.bEnd === by ? last : { aStart: ax, aEnd: ax, bStart: by, bEnd: by };
    if (hunk !== last) {
      hunks.push(hunk);
    }
    if (step.insert) {
      hunk.bEnd++;
    } else {
      hunk.aEnd++;
    }
  }
  return hunks;
}

/**
 * Myers' O(ND) shortest edit script between two sequences of token ids, as ordered differing regions.
 * Returns undefined when more than `maxEdits` insertions and deletions would be needed.
 */
export function diffSequences(a: readonly number[], b: readonly number[], maxEdits: number): DiffHunk[] | undefined {
  const prefix = commonPrefix(a, b);
  const suffix = commonSuffix(a, b, prefix);
  const window: Window = { a, b, offset: prefix, n: a.length - prefix - suffix, m: b.length - prefix - suffix };
  const trace = forwardTrace(window, maxEdits);
  return trace ? toHunks(backtrack(trace, window.n, window.m), prefix) : undefined;
}
