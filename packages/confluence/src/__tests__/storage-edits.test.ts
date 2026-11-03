import {
  MAX_DIFF_EDITS,
  applyStorageEdits,
  compareStoredBody,
  findInStorage,
  inlineCommentRefAt,
  lostInlineCommentRefs,
  mergeEditedBody,
} from '../storage-edits.js';
import { editableText } from '../storage-normalization.js';

const NBSP = ' ';
const MARKER = '<ac:inline-comment-marker ac:ref="r1">reviewed text</ac:inline-comment-marker>';

describe('applyStorageEdits', () => {
  const body = `<p>Host</p><table><tr><td>a${NBSP}b</td><td>old</td></tr></table>`;
  const edit = (input: string, oldStr: string, newStr: string) => applyStorageEdits(input, [{ oldStr, newStr }]).body;

  it('replaces each oldStr in order', () => {
    const result = applyStorageEdits(body, [
      { oldStr: '<td>old</td>', newStr: '<td>new</td>' },
      { oldStr: '<p>Host</p>', newStr: '<p>Hosts</p>' },
    ]);
    expect(result.body).toBe(`<p>Hosts</p><table><tr><td>a${NBSP}b</td><td>new</td></tr></table>`);
    expect(result.applied.map(({ index, matchedAt }) => ({ index, matchedAt }))).toEqual([
      { index: 0, matchedAt: 'exact' },
      { index: 1, matchedAt: 'exact' },
    ]);
  });

  it('sees the result of earlier edits', () => {
    const result = applyStorageEdits(body, [{ oldStr: 'old', newStr: 'mid' }, { oldStr: 'mid', newStr: 'new' }]);
    expect(result.body).toContain('<td>new</td>');
  });

  it('deletes oldStr when newStr is empty', () => {
    expect(edit(body, '<p>Host</p>', '')).toBe(body.slice('<p>Host</p>'.length));
  });

  it('keeps $ sequences in newStr literal', () => {
    expect(edit(body, 'old', "$& $' $1")).toContain("<td>$& $' $1</td>");
  });

  it('matches oldStr typed with a plain space where storage has U+00A0 and keeps the U+00A0', () => {
    const result = applyStorageEdits(body, [{ oldStr: '<td>a b</td>', newStr: '<td>a c</td>' }]);
    expect(result.body).toContain(`<td>a${NBSP}c</td>`);
    expect(result.applied[0]).toMatchObject({ matchedAt: 'spacing', changes: [{ removed: 'b', inserted: 'c' }] });
  });

  it('rejects an oldStr that occurs more than once at the strictest level that finds it', () => {
    expect(() => edit(body, '<td>', 'x')).toThrow(/edits\[0\].*found 2.*exact level.*more surrounding text/);
  });

  it('does not loosen the comparison when the exact one finds the text', () => {
    const input = `<p>a b</p><p>a${NBSP}b</p>`;
    expect(edit(input, 'a b', 'a c')).toBe(`<p>a c</p><p>a${NBSP}b</p>`);
  });

  it('matches an oldStr written with line breaks between blocks', () => {
    expect(edit(body, '<p>Host</p>\n<table>', '<p>Hosts</p>\n<table>')).toBe(body.replace('Host', 'Hosts'));
  });

  it('rejects an oldStr that is not there at any level', () => {
    expect(() => edit(body, 'missing', 'x')).toThrow(/edits\[0\]\.oldStr was not found.*confluence_findInContent/);
  });

  it('rejects an empty oldStr', () => {
    expect(() => edit(body, '', 'x')).toThrow(/edits\[0\]\.oldStr must not be empty/);
  });

  it('applies nothing when a later edit fails', () => {
    const input = body;
    expect(() => applyStorageEdits(input, [{ oldStr: 'old', newStr: 'new' }, { oldStr: 'missing', newStr: 'x' }]))
      .toThrow(/edits\[1\]/);
    expect(input).toBe(body);
  });

  it('matches a character reference in oldStr against the stored character', () => {
    const input = 'author’s note';
    const result = applyStorageEdits(input, [{ oldStr: 'author&rsquo;s note', newStr: 'author&rsquo;s draft' }]);
    expect(result.body).toBe('author’s draft');
    expect(result.applied[0].matchedAt).toBe('markup');
  });

  it('keeps the macro id of a macro that oldStr spells without it', () => {
    const input = '<ac:structured-macro ac:name="drawio" ac:macro-id="m-1"><ac:parameter ac:name="revision">1</ac:parameter></ac:structured-macro>';
    const oldStr = '<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="revision">1</ac:parameter>';
    const result = edit(input, oldStr, oldStr.replace('>1<', '>2<'));
    expect(result).toBe(input.replace('>1<', '>2<'));
  });

  it('matches ASCII quotes and dashes against typographic ones and keeps the stored characters', () => {
    const input = `<p>the author’s note — draft</p>`;
    const result = applyStorageEdits(input, [{ oldStr: "author's note - draft", newStr: "author's note - final" }]);
    expect(result.body).toBe(`<p>the author’s note — final</p>`);
    expect(result.applied[0].matchedAt).toBe('typography');
  });

  it('writes a typographic change that newStr asks for when the match was at the typography level', () => {
    const result = applyStorageEdits('<p>a \u2013 b, it\u2019s</p>', [{ oldStr: "a - b, it's", newStr: "a \u2014 b, it's" }]);
    expect(result.body).toBe('<p>a \u2014 b, it\u2019s</p>');
    expect(result.applied[0]).toMatchObject({ matchedAt: 'typography', changes: [{ removed: '\u2013', inserted: '\u2014' }] });
  });

  it('reports an oldStr that normalises to nothing as not found', () => {
    expect(() => edit(body, '\u200b', 'x')).toThrow(/edits\[0\]\.oldStr was not found/);
    expect(() => edit(body, ' ac:macro-id="m-1"', 'x')).toThrow(/edits\[0\]\.oldStr was not found/);
  });

  it('reports only the tokens that changed', () => {
    const [applied] = applyStorageEdits('<p>one two three</p>', [{ oldStr: 'one two three', newStr: 'one 2 three' }]).applied;
    expect(applied.changes).toEqual([{ offset: 7, removed: 'two', inserted: '2' }]);
  });
});

describe('mergeEditedBody', () => {
  const stored = `<p>Intro${NBSP}text</p><ac:structured-macro ac:name="code" ac:macro-id="m-9"><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro><p>Status: draft</p>`;

  it('applies the edits of an editable copy and keeps the stored form elsewhere', () => {
    const result = mergeEditedBody(stored, editableText(stored).replace('draft', 'approved'));
    expect(result.body).toBe(stored.replace('draft', 'approved'));
    expect(result.changes).toEqual([{ offset: stored.indexOf('draft'), removed: 'draft', inserted: 'approved' }]);
  });

  it('changes nothing when the copy only differs in spacing and markup forms', () => {
    const result = mergeEditedBody(stored, editableText(stored));
    expect(result).toEqual({ body: stored, changes: [] });
  });

  it('refines only the changed blocks and keeps the stored form of unchanged tokens in them', () => {
    const page = `<p>one${NBSP}two</p><p>three${NBSP}four</p><p>five${NBSP}six</p>`;
    const result = mergeEditedBody(page, editableText(page).replace('two', '2').replace('six', '6'));
    expect(result.body).toBe(`<p>one${NBSP}2</p><p>three${NBSP}four</p><p>five${NBSP}6</p>`);
    expect(result.changes.map(c => [c.removed, c.inserted])).toEqual([['two', '2'], ['six', '6']]);
  });

  it('replaces a region as a whole when it differs by more than a diff may search', () => {
    const words = (prefix: string) => `<p>${Array.from({ length: MAX_DIFF_EDITS }, (_, i) => `${prefix}${i}`).join(' ')}</p>`;
    const result = mergeEditedBody(words('a'), words('b'));
    expect(result.body).toBe(words('b'));
    expect(result.changes).toHaveLength(1);
  });
});

describe('findInStorage', () => {
  const body = `<p>rule set${NBSP}in the page</p><p>${MARKER}</p>`;

  it('returns raw context at the strictest level that matches', () => {
    expect(findInStorage(body, 'set in the', { contextChars: 4 })).toEqual({
      matchedAt: 'spacing',
      total: 1,
      matches: [{ offset: body.indexOf('set'), before: 'ule ', match: `set${NBSP}in the`, after: ' pag' }],
    });
  });

  it('reports the inline comment a match sits in', () => {
    expect(findInStorage(body, 'reviewed').matches[0].inlineCommentRef).toBe('r1');
  });

  it('reports no level when nothing matches', () => {
    expect(findInStorage(body, 'absent')).toEqual({ total: 0, matches: [] });
  });
});

describe('inline comment markers', () => {
  it('ignores marker text inside CDATA', () => {
    const code = '<ac:plain-text-body><![CDATA[<ac:inline-comment-marker ac:ref="doc">x</ac:inline-comment-marker>]]></ac:plain-text-body>';
    expect(lostInlineCommentRefs(code + MARKER, code.replace('doc', 'other') + MARKER)).toEqual([]);
    expect(lostInlineCommentRefs(code + MARKER, code)).toEqual(['r1']);
  });

  it('reports refs that a new body drops', () => {
    expect(lostInlineCommentRefs(MARKER, 'reviewed text')).toEqual(['r1']);
    expect(lostInlineCommentRefs(MARKER, MARKER.replace('text', 'words'))).toEqual([]);
  });

  it('tells whether an offset lies inside a marker', () => {
    const body = `<p>Intro ${MARKER} tail</p>`;
    expect(inlineCommentRefAt(body, body.indexOf('reviewed'))).toBe('r1');
    expect(inlineCommentRefAt(body, body.indexOf('Intro'))).toBeUndefined();
    expect(inlineCommentRefAt(body, body.indexOf('tail'))).toBeUndefined();
  });
});

describe('compareStoredBody', () => {
  it('accepts what Confluence normalises itself', () => {
    const sent = '<p>a&nbsp;b</p><ac:structured-macro ac:name="toc"><ac:parameter ac:name="x" /></ac:structured-macro>';
    const stored = `<p>a${NBSP}b</p><ac:structured-macro ac:name="toc" ac:macro-id="m-2"></ac:structured-macro>`;
    expect(compareStoredBody(sent, stored)).toEqual({ storedMatchesSent: true, normalisedByServer: true });
  });

  it('reports where the stored body lost content', () => {
    const result = compareStoredBody('<p>abc</p><p>def</p>', '<p>abc</p>');
    expect(result).toMatchObject({ storedMatchesSent: false, firstDifference: { offset: 10, sent: '<p>def</p>', stored: '' } });
  });
});
