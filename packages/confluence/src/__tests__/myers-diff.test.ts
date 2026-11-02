import { diffSequences, type DiffHunk } from '../myers-diff.js';

function ids(text: string): number[] {
  return Array.from(text, ch => ch.charCodeAt(0));
}

function apply(a: number[], b: number[], hunks: DiffHunk[]): number[] {
  const out: number[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    out.push(...a.slice(cursor, hunk.aStart), ...b.slice(hunk.bStart, hunk.bEnd));
    cursor = hunk.aEnd;
  }
  return out.concat(a.slice(cursor));
}

function editCount(hunks: DiffHunk[]): number {
  return hunks.reduce((sum, h) => sum + (h.aEnd - h.aStart) + (h.bEnd - h.bStart), 0);
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe('diffSequences', () => {
  it('returns no hunks for equal sequences, including empty ones', () => {
    expect(diffSequences([], [], 10)).toEqual([]);
    expect(diffSequences(ids('abc'), ids('abc'), 10)).toEqual([]);
  });

  it('inserts into and deletes from empty sequences', () => {
    expect(diffSequences([], ids('ab'), 10)).toEqual([{ aStart: 0, aEnd: 0, bStart: 0, bEnd: 2 }]);
    expect(diffSequences(ids('ab'), [], 10)).toEqual([{ aStart: 0, aEnd: 2, bStart: 0, bEnd: 0 }]);
  });

  it('reports a replaced middle as one hunk', () => {
    expect(diffSequences(ids('aXYb'), ids('aZb'), 10)).toEqual([{ aStart: 1, aEnd: 3, bStart: 1, bEnd: 2 }]);
  });

  it('finds the shortest edit script of the Myers paper example', () => {
    const a = ids('ABCABBA');
    const b = ids('CBABAC');
    const hunks = diffSequences(a, b, 100)!;
    expect(editCount(hunks)).toBe(5);
    expect(apply(a, b, hunks)).toEqual(b);
  });

  it('gives up when more edits than allowed are needed', () => {
    expect(diffSequences(ids('abcd'), ids('wxyz'), 7)).toBeUndefined();
    expect(diffSequences(ids('abcd'), ids('wxyz'), 8)).toBeDefined();
  });

  it('produces ordered, disjoint hunks that turn a into b for random inputs', () => {
    const random = seededRandom(42);
    const sequence = () => Array.from({ length: Math.floor(random() * 40) }, () => Math.floor(random() * 4));
    for (let run = 0; run < 300; run++) {
      const a = sequence();
      const b = sequence();
      const hunks = diffSequences(a, b, Number.POSITIVE_INFINITY)!;
      expect(apply(a, b, hunks)).toEqual(b);
      hunks.forEach((hunk, i) => {
        expect(hunk.aEnd - hunk.aStart + hunk.bEnd - hunk.bStart).toBeGreaterThan(0);
        if (i > 0) {
          expect(hunk.aStart).toBeGreaterThan(hunks[i - 1].aEnd - 1);
          expect(hunk.bStart).toBeGreaterThanOrEqual(hunks[i - 1].bEnd);
        }
      });
    }
  });
});
