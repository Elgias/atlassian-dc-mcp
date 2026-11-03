import { diffSequences, type DiffHunk } from './myers-diff.js';
import {
  MATCH_LEVELS,
  cdataRanges,
  normalizeStorage,
  tokenize,
  type MatchLevel,
  type NormalizedStorage,
  type TokenSpan,
} from './storage-normalization.js';

export interface StorageEdit {
  oldStr: string;
  newStr: string;
}

export interface BodyChange {
  offset: number;
  removed: string;
  inserted: string;
}

/** An applied edit: where oldStr matched in the body as it stood before the edit, and what changed there. */
export interface AppliedStorageEdit {
  index: number;
  matchedAt: MatchLevel;
  offset: number;
  changes: BodyChange[];
}

export interface StorageMatch {
  offset: number;
  before: string;
  match: string;
  after: string;
  inlineCommentRef?: string;
}

/**
 * Most insertions plus deletions one diff may search for. The search keeps O(D²) state, so a region
 * that differs by more is replaced as a whole instead of being refined.
 */
export const MAX_DIFF_EDITS = 2000;

const CLOSING_TAG = /<\/[^<>]*>/g;
const INLINE_COMMENT_OPEN = '<ac:inline-comment-marker';
const INLINE_COMMENT_CLOSE = '</ac:inline-comment-marker>';
const MARKER_REF = /\bac:ref="([^"]+)"/;

interface Side {
  raw: string;
  normalized: NormalizedStorage;
  tokens: TokenSpan[];
}

interface Splice {
  start: number;
  end: number;
  text: string;
}

/** Where `side` sits in a body: its normalised text starts at `offset` of `body`. */
interface Anchor {
  side: Side;
  body: NormalizedStorage;
  offset: number;
}

interface UniqueMatch {
  level: MatchLevel;
  anchor: Anchor;
}

function toSide(raw: string, level: MatchLevel): Side {
  const normalized = normalizeStorage(raw, level);
  return { raw, normalized, tokens: tokenize(normalized.text) };
}

function interner(): (text: string) => number {
  const ids = new Map<string, number>();
  return text => {
    const id = ids.get(text) ?? ids.size;
    ids.set(text, id);
    return id;
  };
}

function boundary(side: Side, tokenIndex: number): number {
  return tokenIndex < side.tokens.length ? side.tokens[tokenIndex].start : side.normalized.text.length;
}

/** Token index ranges that each end with a closing tag; the last one takes any trailing tokens. */
function segments(side: Side): Array<{ start: number; end: number }> {
  const ends = new Set(Array.from(side.normalized.text.matchAll(CLOSING_TAG), m => (m.index ?? 0) + m[0].length));
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  side.tokens.forEach((token, i) => {
    if (ends.has(token.end)) {
      ranges.push({ start, end: i + 1 });
      start = i + 1;
    }
  });
  return start < side.tokens.length ? [...ranges, { start, end: side.tokens.length }] : ranges;
}

function wholeHunk(aLength: number, bLength: number): DiffHunk[] {
  return aLength + bLength === 0 ? [] : [{ aStart: 0, aEnd: aLength, bStart: 0, bEnd: bLength }];
}

function shifted(hunks: DiffHunk[], aOffset: number, bOffset: number): DiffHunk[] {
  return hunks.map(h => ({ aStart: h.aStart + aOffset, aEnd: h.aEnd + aOffset, bStart: h.bStart + bOffset, bEnd: h.bEnd + bOffset }));
}

/**
 * Token-level hunks between two sides: first between segments (text up to each closing tag), then
 * between the tokens of each differing segment run, like a line diff refined to words.
 */
function diffTokens(a: Side, b: Side): DiffHunk[] {
  const id = interner();
  const tokenIds = (side: Side) => side.tokens.map(({ start, end }) => id(side.normalized.text.slice(start, end)));
  const [aIds, bIds] = [tokenIds(a), tokenIds(b)];
  const [aSegments, bSegments] = [segments(a), segments(b)];
  const segmentIds = (side: Side, ranges: Array<{ start: number; end: number }>) =>
    ranges.map(r => id(side.normalized.text.slice(side.tokens[r.start].start, side.tokens[r.end - 1].end)));
  const segmentHunks = diffSequences(segmentIds(a, aSegments), segmentIds(b, bSegments), MAX_DIFF_EDITS)
    ?? wholeHunk(aSegments.length, bSegments.length);
  const tokenAt = (ranges: Array<{ start: number }>, index: number, total: number) => (index < ranges.length ? ranges[index].start : total);
  return segmentHunks.flatMap(h => {
    const aFrom = tokenAt(aSegments, h.aStart, aIds.length);
    const aTo = tokenAt(aSegments, h.aEnd, aIds.length);
    const bFrom = tokenAt(bSegments, h.bStart, bIds.length);
    const bTo = tokenAt(bSegments, h.bEnd, bIds.length);
    const refined = diffSequences(aIds.slice(aFrom, aTo), bIds.slice(bFrom, bTo), MAX_DIFF_EDITS) ?? wholeHunk(aTo - aFrom, bTo - bFrom);
    return shifted(refined, aFrom, bFrom);
  });
}

/** Raw splices of the body that turn the anchored side into `to`, one per hunk between them. */
function splicesFor(anchor: Anchor, to: Side): Splice[] {
  const { side, body, offset } = anchor;
  return diffTokens(side, to).map(hunk => ({
    start: body.rawAt[offset + boundary(side, hunk.aStart)],
    end: body.rawAt[offset + boundary(side, hunk.aEnd)],
    text: to.raw.slice(to.normalized.rawAt[boundary(to, hunk.bStart)], to.normalized.rawAt[boundary(to, hunk.bEnd)]),
  }));
}

function toChanges(raw: string, splices: Splice[]): BodyChange[] {
  return splices.map(({ start, end, text }) => ({ offset: start, removed: raw.slice(start, end), inserted: text }));
}

function applySplices(raw: string, splices: Splice[]): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const splice of splices) {
    parts.push(raw.slice(cursor, splice.start), splice.text);
    cursor = splice.end;
  }
  parts.push(raw.slice(cursor));
  return parts.join('');
}

function occurrences(text: string, needle: string, limit = Number.POSITIVE_INFINITY): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(needle); at !== -1 && found.length < limit; at = text.indexOf(needle, at + needle.length)) {
    found.push(at);
  }
  return found;
}

function locateUnique(body: string, oldStr: string, index: number): UniqueMatch {
  for (const level of MATCH_LEVELS) {
    const find = toSide(oldStr, level);
    if (!find.normalized.text) {
      continue;
    }
    const normalizedBody = normalizeStorage(body, level);
    const found = occurrences(normalizedBody.text, find.normalized.text, 2);
    if (found.length > 1) {
      const count = occurrences(normalizedBody.text, find.normalized.text).length;
      throw new Error(
        `edits[${index}].oldStr must occur exactly once in the page body, found ${count} when compared at ` +
        `the ${level} level. Include more surrounding text to make it unique.`,
      );
    }
    if (found.length === 1) {
      return { level, anchor: { side: find, body: normalizedBody, offset: found[0] } };
    }
  }
  throw new Error(
    `edits[${index}].oldStr was not found in the page body, also when ignoring character references, macro ids, ` +
    'space variants and typographic quotes and dashes. Re-read the text around it with confluence_findInContent.',
  );
}

/**
 * Applies find/replace edits to a storage body, in order, each to the result of the previous ones.
 * Each oldStr must occur exactly once at the strictest match level where it occurs at all; otherwise an
 * error is thrown and nothing is applied. Only the tokens that differ between oldStr and newStr are
 * rewritten, so non-breaking spaces, character references and macro ids around them keep their stored form.
 */
export function applyStorageEdits(body: string, edits: StorageEdit[]): { body: string; applied: AppliedStorageEdit[] } {
  let current = body;
  const applied = edits.map((edit, index) => {
    if (!edit.oldStr) {
      throw new Error(`edits[${index}].oldStr must not be empty`);
    }
    const { level, anchor } = locateUnique(current, edit.oldStr, index);
    // Typographic characters in newStr are written as given; the typography fold is 1:1, so spacing offsets fit the anchor.
    const diffLevel = level === 'typography' ? 'spacing' : level;
    const splices = splicesFor({ ...anchor, side: toSide(edit.oldStr, diffLevel) }, toSide(edit.newStr, diffLevel));
    const changes = toChanges(current, splices);
    current = applySplices(current, splices);
    return { index, matchedAt: level, offset: anchor.body.rawAt[anchor.offset], changes };
  });
  return { body: current, applied };
}

/**
 * Applies to `body` only the differences between it and `edited`, a copy of the body edited elsewhere.
 * Both are compared at the spacing level, so `edited` may be the editable form of the body; unchanged
 * regions keep their stored bytes.
 */
export function mergeEditedBody(body: string, edited: string): { body: string; changes: BodyChange[] } {
  const base = toSide(body, 'spacing');
  const splices = splicesFor({ side: base, body: base.normalized, offset: 0 }, toSide(edited, 'spacing'));
  return { body: applySplices(body, splices), changes: toChanges(body, splices) };
}

/** Ref of the inline comment marker that encloses `offset`, if any. Markers do not nest. */
export function inlineCommentRefAt(body: string, offset: number): string | undefined {
  const open = body.lastIndexOf(INLINE_COMMENT_OPEN, offset);
  if (open === -1) {
    return undefined;
  }
  const close = body.indexOf(INLINE_COMMENT_CLOSE, open);
  if (close !== -1 && close < offset) {
    return undefined;
  }
  const tagEnd = body.indexOf('>', open);
  return /\bac:ref="([^"]+)"/.exec(body.slice(open, tagEnd === -1 ? undefined : tagEnd))?.[1];
}

/** Refs of the inline comment markers of a body; marker text inside CDATA is code, not a marker. */
function inlineCommentRefs(body: string): Set<string> {
  const refs = new Set<string>();
  const cdata = cdataRanges(body);
  let next = 0;
  for (let at = body.indexOf(INLINE_COMMENT_OPEN); at !== -1; at = body.indexOf(INLINE_COMMENT_OPEN, at + 1)) {
    while (next < cdata.length && cdata[next].end <= at) {
      next++;
    }
    if (next < cdata.length && cdata[next].start <= at) {
      continue;
    }
    const tagEnd = body.indexOf('>', at);
    const ref = MARKER_REF.exec(body.slice(at, tagEnd === -1 ? undefined : tagEnd))?.[1];
    if (ref) {
      refs.add(ref);
    }
  }
  return refs;
}

/** Inline comment refs present in `before` and missing from `after`. */
export function lostInlineCommentRefs(before: string, after: string): string[] {
  const kept = inlineCommentRefs(after);
  return [...inlineCommentRefs(before)].filter(ref => !kept.has(ref));
}

function describeMatch(body: string, start: number, end: number, contextChars: number): StorageMatch {
  const inlineCommentRef = inlineCommentRefAt(body, start);
  return {
    offset: start,
    before: body.slice(Math.max(0, start - contextChars), start),
    match: body.slice(start, end),
    after: body.slice(end, end + contextChars),
    ...(inlineCommentRef ? { inlineCommentRef } : {}),
  };
}

/** Finds `query` at the strictest match level where it occurs and returns the raw text around each match. */
export function findInStorage(
  body: string,
  query: string,
  options: { contextChars?: number; maxMatches?: number } = {},
): { matchedAt?: MatchLevel; total: number; matches: StorageMatch[] } {
  for (const level of MATCH_LEVELS) {
    const needle = normalizeStorage(query, level).text;
    const normalizedBody = needle ? normalizeStorage(body, level) : undefined;
    const found = normalizedBody ? occurrences(normalizedBody.text, needle) : [];
    if (normalizedBody && found.length > 0) {
      const matches = found.slice(0, options.maxMatches ?? 20).map(at => describeMatch(
        body, normalizedBody.rawAt[at], normalizedBody.rawAt[at + needle.length], options.contextChars ?? 200,
      ));
      return { matchedAt: level, total: found.length, matches };
    }
  }
  return { total: 0, matches: [] };
}

/**
 * Compares a body sent to Confluence with what it stored. Differences Confluence makes itself
 * (character references, macro ids, empty parameters) count as normalisation, not as a mismatch.
 */
export function compareStoredBody(sent: string, stored: string) {
  const a = normalizeStorage(sent, 'markup').text;
  const b = normalizeStorage(stored, 'markup');
  const limit = Math.min(a.length, b.text.length);
  let at = 0;
  while (at < limit && a[at] === b.text[at]) {
    at++;
  }
  const matches = a.length === b.text.length && at === limit;
  return {
    storedMatchesSent: matches,
    normalisedByServer: sent !== stored,
    ...(matches ? {} : {
      firstDifference: { offset: b.rawAt[at], sent: a.slice(at, at + 80), stored: b.text.slice(at, at + 80) },
    }),
  };
}
