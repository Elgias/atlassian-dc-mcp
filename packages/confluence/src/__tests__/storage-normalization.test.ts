import { cdataRanges, editableText, normalizeStorage, tokenize, type NormalizedStorage } from '../storage-normalization.js';
import { XHTML_ENTITIES } from '../xhtml-entities.js';

function expectConsistentMap(raw: string, normalized: NormalizedStorage) {
  expect(normalized.rawAt).toHaveLength(normalized.text.length + 1);
  expect(normalized.rawAt[normalized.text.length]).toBe(raw.length);
  normalized.rawAt.forEach((at, i) => {
    if (i > 0) {
      expect(at).toBeGreaterThanOrEqual(normalized.rawAt[i - 1]);
    }
  });
}

describe('XHTML_ENTITIES', () => {
  it('holds the XHTML 1.0 named references except the XML ones', () => {
    expect(XHTML_ENTITIES.size).toBe(248);
    for (const xml of ['amp', 'lt', 'gt', 'quot', 'apos']) {
      expect(XHTML_ENTITIES.has(xml)).toBe(false);
    }
  });

  it('maps names to their code points', () => {
    expect(XHTML_ENTITIES.get('nbsp')).toBe(160);
    expect(XHTML_ENTITIES.get('copy')).toBe(169);
    expect(XHTML_ENTITIES.get('yuml')).toBe(255);
    expect(XHTML_ENTITIES.get('Rho')).toBe(929);
    expect(XHTML_ENTITIES.get('Sigma')).toBe(931);
    expect(XHTML_ENTITIES.get('sigmaf')).toBe(962);
    expect(XHTML_ENTITIES.get('rsquo')).toBe(8217);
    expect(XHTML_ENTITIES.get('diams')).toBe(9830);
  });
});

describe('normalizeStorage', () => {
  it('keeps the exact level byte for byte', () => {
    const raw = '<p>a&nbsp;b c</p>';
    expect(normalizeStorage(raw, 'exact')).toEqual({ text: raw, rawAt: Array.from({ length: raw.length + 1 }, (_, i) => i) });
  });

  it('decodes character references other than the XML ones at the markup level', () => {
    const raw = 'a&nbsp;b&#8217;c&#x2019;d&amp;e&lt;f&unknown;g&#0;h';
    const normalized = normalizeStorage(raw, 'markup');
    expect(normalized.text).toBe('a b’c’d&amp;e&lt;f&unknown;g&#0;h');
    expect(normalized.rawAt[1]).toBe(1);
    expect(normalized.rawAt[2]).toBe('a&nbsp;'.length);
    expectConsistentMap(raw, normalized);
  });

  it('keeps numeric references to the XML special characters and to surrogates encoded', () => {
    const raw = '&#60;&#x3C;&#62;&#38;&#34;&#39;&#xD800;&#xDFFF;&#xE000;';
    expect(normalizeStorage(raw, 'markup').text).toBe('&#60;&#x3C;&#62;&#38;&#34;&#39;&#xD800;&#xDFFF;\ue000');
  });

  it('drops macro ids and empty parameters at the markup level, attaching them to the preceding character', () => {
    const raw = '<ac:structured-macro ac:name="code" ac:macro-id="m-1"><ac:parameter ac:name="width" />' +
      '<ac:parameter ac:name="x"></ac:parameter><ac:parameter ac:name="language">sql</ac:parameter></ac:structured-macro>';
    const normalized = normalizeStorage(raw, 'markup');
    expect(normalized.text).toBe(
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">sql</ac:parameter></ac:structured-macro>',
    );
    const quote = '<ac:structured-macro ac:name="code'.length;
    expect(normalized.rawAt[quote + 1]).toBe(raw.indexOf('>'));
    expectConsistentMap(raw, normalized);
  });

  it('drops a macro id preceded by a run of whitespace and keeps whitespace runs elsewhere', () => {
    const raw = '<ac:structured-macro ac:name="toc"   \n  ac:macro-id="m"><p>a     b</p></ac:structured-macro>';
    expect(normalizeStorage(raw, 'markup').text).toBe('<ac:structured-macro ac:name="toc"><p>a     b</p></ac:structured-macro>');
  });

  it('lists CDATA sections, an unterminated one running to the end', () => {
    expect(cdataRanges('a<![CDATA[x]]>b<![CDATA[y')).toEqual([{ start: 1, end: 14 }, { start: 15, end: 25 }]);
    expect(cdataRanges('<p/>')).toEqual([]);
  });

  it('leaves CDATA alone at the markup level but folds spacing inside it', () => {
    const raw = '<![CDATA[a&nbsp;b c ac:macro-id="x"]]>&nbsp;';
    expect(normalizeStorage(raw, 'markup').text).toBe('<![CDATA[a&nbsp;b c ac:macro-id="x"]]> ');
    expect(normalizeStorage(raw, 'spacing').text).toBe('<![CDATA[a&nbsp;b c ac:macro-id="x"]]> ');
  });

  it('reads space variants as a plain space and drops invisible characters at the spacing level', () => {
    const raw = 'a b c d​e­f﻿g ’—';
    const normalized = normalizeStorage(raw, 'spacing');
    expect(normalized.text).toBe('a b c defg ’—');
    expectConsistentMap(raw, normalized);
  });

  it('ignores line breaks right after block-level closing tags at the spacing level only', () => {
    const raw = '<p>a</p>\r\n<p>b <strong>c</strong>\nd</p>\n<![CDATA[x</p>\ny]]>';
    expect(normalizeStorage(raw, 'markup').text).toBe(raw);
    const normalized = normalizeStorage(raw, 'spacing');
    expect(normalized.text).toBe('<p>a</p><p>b <strong>c</strong>\nd</p><![CDATA[x</p>\ny]]>');
    expectConsistentMap(raw, normalized);
  });

  it('folds typographic quotes and dashes at the typography level', () => {
    expect(normalizeStorage('‘a’ “b” c–d—e−f', 'typography').text).toBe('\'a\' "b" c-d-e-f');
  });

  it('maps unchanged characters to themselves', () => {
    const raw = 'x&rsquo;y z ac:macro-id="q" w';
    const normalized = normalizeStorage(raw, 'typography');
    for (let i = 0; i < normalized.text.length; i++) {
      const ch = normalized.text[i];
      if (/[a-z]/.test(ch)) {
        expect(raw[normalized.rawAt[i]]).toBe(ch);
      }
    }
  });
});

describe('editableText', () => {
  it('puts each block on its own line, outside CDATA, and compares back equal at the spacing level', () => {
    const raw = '<h2>T</h2><table><tbody><tr><td>a b</td></tr></tbody></table><ac:structured-macro ac:name="code" ac:macro-id="m">' +
      '<ac:plain-text-body><![CDATA[</p>]]></ac:plain-text-body></ac:structured-macro><p><strong>x</strong> y</p>';
    const editable = editableText(raw);
    expect(editable).toBe(
      '<h2>T</h2>\n<table><tbody><tr><td>a b</td>\n</tr>\n</tbody>\n</table>\n<ac:structured-macro ac:name="code">' +
      '<ac:plain-text-body><![CDATA[</p>]]></ac:plain-text-body>\n</ac:structured-macro>\n<p><strong>x</strong> y</p>\n',
    );
    expect(normalizeStorage(editable, 'spacing').text).toBe(normalizeStorage(raw, 'spacing').text);
  });
});

describe('tokenize', () => {
  it('splits into words, whitespace runs and single symbols that cover the text', () => {
    const text = 'Розділ 12: a_b  <p>';
    const tokens = tokenize(text);
    expect(tokens.map(({ start, end }) => text.slice(start, end))).toEqual(['Розділ', ' ', '12', ':', ' ', 'a_b', '  ', '<', 'p', '>']);
    expect(tokens[0].start).toBe(0);
    tokens.forEach((token, i) => {
      if (i > 0) {
        expect(token.start).toBe(tokens[i - 1].end);
      }
    });
    expect(tokens[tokens.length - 1].end).toBe(text.length);
  });
});
