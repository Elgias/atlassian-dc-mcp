import { XHTML_ENTITIES } from './xhtml-entities.js';

/**
 * How loosely two storage strings are compared, from strict to loose. Each level includes the previous:
 * - `exact`: byte for byte;
 * - `markup`: forms Confluence treats as the same stored content — character references other than the
 *   five XML ones, `ac:macro-id` attributes and empty `ac:parameter` elements (not inside CDATA);
 * - `spacing`: also space separators read as a plain space, invisible format characters ignored and line
 *   breaks right after a block-level closing tag ignored (outside CDATA);
 * - `typography`: also typographic quotes and dashes read as their ASCII counterparts.
 */
export type MatchLevel = 'exact' | 'markup' | 'spacing' | 'typography';

export const MATCH_LEVELS: readonly MatchLevel[] = ['exact', 'markup', 'spacing', 'typography'];

/**
 * Normalised text with `rawAt[i]` = offset in the raw string where normalised character `i` starts;
 * `rawAt[text.length]` = raw length. Raw spans dropped by normalisation belong to the preceding character.
 */
export interface NormalizedStorage {
  text: string;
  rawAt: number[];
}

export interface TokenSpan {
  start: number;
  end: number;
}

const XML_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);
const XML_SPECIAL_CODE_POINTS = new Set([0x22, 0x26, 0x27, 0x3c, 0x3e]);
const CHARACTER_REFERENCE = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/y;
const MACRO_ID_ATTRIBUTE = /\s+ac:macro-id\s*=\s*(?:"[^"]*"|'[^']*')/y;
const EMPTY_PARAMETER = /<ac:parameter\b(?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*(?:\/>|><\/ac:parameter>)/y;
const BLOCK_ELEMENTS = 'p|h[1-6]|li|ul|ol|dl|dt|dd|table|thead|tbody|tfoot|tr|th|td|caption|colgroup|div|blockquote|pre|' +
  'ac:structured-macro|ac:rich-text-body|ac:plain-text-body|ac:parameter|ac:layout|ac:layout-section|ac:layout-cell|' +
  'ac:task-list|ac:task|ac:task-id|ac:task-status|ac:task-body';
const BLOCK_CLOSING_TAG = new RegExp(`</(?:${BLOCK_ELEMENTS})\\s*>`, 'y');
const CDATA_OR_BLOCK_CLOSING_TAG = new RegExp(`<!\\[CDATA\\[[\\s\\S]*?\\]\\]>|</(?:${BLOCK_ELEMENTS})\\s*>`, 'g');
const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';
const SPACE_SEPARATOR = /\p{Zs}/u;
const FORMAT_CHARACTER = /\p{Cf}/u;
const TYPOGRAPHIC: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
};
const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

/** Numeric references to the five XML special characters stay encoded, like their named forms. */
function decodeReference(reference: string): string | undefined {
  if (reference[0] !== '#') {
    const codePoint = XHTML_ENTITIES.get(reference);
    return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
  }
  const codePoint = reference[1] === 'x' || reference[1] === 'X'
    ? Number.parseInt(reference.slice(2), 16)
    : Number.parseInt(reference.slice(1), 10);
  const valid = codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
  return valid && !XML_SPECIAL_CODE_POINTS.has(codePoint) ? String.fromCodePoint(codePoint) : undefined;
}

function foldCharacter(ch: string, level: MatchLevel): string {
  if ((level !== 'spacing' && level !== 'typography') || ch.charCodeAt(0) < 0x80) {
    return ch;
  }
  if (SPACE_SEPARATOR.test(ch)) {
    return ' ';
  }
  if (FORMAT_CHARACTER.test(ch)) {
    return '';
  }
  return level === 'typography' ? TYPOGRAPHIC[ch] ?? ch : ch;
}

/** Only the first character of a whitespace run can start the macro-id pattern; retrying inside the run would be quadratic. */
function startsWhitespaceRun(raw: string, at: number): boolean {
  return /\s/.test(raw[at]) && (at === 0 || !/\s/.test(raw[at - 1]));
}

/** End of the CDATA section opening at `start`; an unterminated one runs to the end. */
function cdataEnd(raw: string, start: number): number {
  const close = raw.indexOf(CDATA_CLOSE, start + CDATA_OPEN.length);
  return close === -1 ? raw.length : close + CDATA_CLOSE.length;
}

/** [start, end) of every CDATA section of a storage string, in order. */
export function cdataRanges(raw: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let start = raw.indexOf(CDATA_OPEN); start !== -1; start = raw.indexOf(CDATA_OPEN, ranges[ranges.length - 1].end)) {
    ranges.push({ start, end: cdataEnd(raw, start) });
  }
  return ranges;
}

function stickyMatch(pattern: RegExp, raw: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(raw);
}

class NormalizedBuilder {
  private readonly chars: string[] = [];
  private readonly rawAt: number[] = [];

  push(text: string, rawStart: number): void {
    for (let i = 0; i < text.length; i++) {
      this.chars.push(text[i]);
      this.rawAt.push(rawStart);
    }
  }

  finish(rawLength: number): NormalizedStorage {
    this.rawAt.push(rawLength);
    return { text: this.chars.join(''), rawAt: this.rawAt };
  }
}

/** The markup construct at `at` that normalisation decodes or drops: its raw length and replacement. */
function markupAt(raw: string, at: number): { length: number; replacement: string } | undefined {
  const ch = raw[at];
  if (ch === '&') {
    const reference = stickyMatch(CHARACTER_REFERENCE, raw, at);
    const decoded = reference && !XML_ENTITIES.has(reference[1]) ? decodeReference(reference[1]) : undefined;
    return reference && decoded !== undefined ? { length: reference[0].length, replacement: decoded } : undefined;
  }
  const dropped = ch === '<'
    ? stickyMatch(EMPTY_PARAMETER, raw, at)
    : startsWhitespaceRun(raw, at) ? stickyMatch(MACRO_ID_ATTRIBUTE, raw, at) : null;
  return dropped ? { length: dropped[0].length, replacement: '' } : undefined;
}

/** Copies the CDATA section at `start`, folding characters only, and returns where it ends. */
function pushCdata(raw: string, start: number, level: MatchLevel, builder: NormalizedBuilder): number {
  const end = cdataEnd(raw, start);
  for (let i = start; i < end; i++) {
    builder.push(foldCharacter(raw[i], level), i);
  }
  return end;
}

/** Offset right after the block-level closing tag that starts at `at`, if one does. */
function blockCloseEnd(raw: string, at: number): number | undefined {
  const blockClose = raw[at] === '<' ? stickyMatch(BLOCK_CLOSING_TAG, raw, at) : null;
  return blockClose ? at + blockClose[0].length : undefined;
}

function isLineBreak(ch: string): boolean {
  return ch === '\n' || ch === '\r';
}

/** Normalises a storage-format string (a whole body or a fragment) for comparison at `level`. */
export function normalizeStorage(raw: string, level: MatchLevel): NormalizedStorage {
  if (level === 'exact') {
    return { text: raw, rawAt: Array.from({ length: raw.length + 1 }, (_, i) => i) };
  }
  const builder = new NormalizedBuilder();
  const foldsLayout = level === 'spacing' || level === 'typography';
  let afterBlockClose: number | undefined;
  let at = 0;
  while (at < raw.length) {
    if (raw.startsWith(CDATA_OPEN, at)) {
      at = pushCdata(raw, at, level, builder);
      continue;
    }
    if (foldsLayout && at === afterBlockClose && isLineBreak(raw[at])) {
      at++;
      afterBlockClose = at;
      continue;
    }
    if (foldsLayout) {
      afterBlockClose = blockCloseEnd(raw, at) ?? afterBlockClose;
    }
    const markup = markupAt(raw, at);
    builder.push(foldCharacter(markup?.replacement ?? raw[at], level), at);
    at += markup?.length ?? 1;
  }
  return builder.finish(raw.length);
}

/**
 * The body as plain, line-oriented text: normalised at the spacing level, with a line break after every
 * block-level closing tag outside CDATA. Comparing it back at the spacing level ignores those line breaks.
 */
export function editableText(raw: string): string {
  return normalizeStorage(raw, 'spacing').text
    .replace(CDATA_OR_BLOCK_CLOSING_TAG, match => (match.startsWith(CDATA_OPEN) ? match : `${match}\n`));
}

/** Splits normalised text into word, whitespace-run and single-symbol tokens. */
export function tokenize(text: string): TokenSpan[] {
  return Array.from(text.matchAll(TOKEN), m => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
}
