import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AttachmentGateway } from '@atlassian-dc-mcp/common';
import { ContentResourceService } from '../confluence-client/index.js';
import { updatePage, type PageUpdate } from '../content-update.js';

jest.mock('../confluence-client/index.js', () => ({
  ContentResourceService: { getContentById: jest.fn(), update2: jest.fn() },
  AttachmentsService: {},
  SearchService: {},
  UserService: {},
  OpenAPI: { BASE: '', TOKEN: '', VERSION: '' },
}));

const NBSP = ' ';
const MARKER = '<ac:inline-comment-marker ac:ref="r1">reviewed</ac:inline-comment-marker>';
const BODY = `<h2>Plan</h2><p>Status:${NBSP}draft</p><p>${MARKER} text</p>`;

function page(version: number, body: string) {
  return { id: '42', type: 'page', title: 'Big page', space: { key: 'DOC' }, version: { number: version }, body: { storage: { value: body } } };
}

describe('updatePage', () => {
  const getContentById = ContentResourceService.getContentById as jest.Mock;
  const update2 = ContentResourceService.update2 as jest.Mock;
  let root: string;
  let gateway: AttachmentGateway;
  const run = (update: Partial<PageUpdate>) => updatePage({ contentId: '42', version: 8, body: {}, ...update }, gateway);

  beforeEach(() => {
    jest.resetAllMocks();
    root =fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-mcp-update-')));
    const side = { enabled: true, roots: [root], maxBytes: 1024 * 1024 };
    gateway = { upload: side, download: side };
    update2.mockImplementation(async (id: string, content: { version: { number: number } }) => ({
      id, type: 'page', title: 'Big page', space: { key: 'DOC' }, version: { number: content.version.number },
    }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('applies edits typed with plain spaces, saves version + 1 and verifies what was stored', async () => {
    const patched = BODY.replace('draft', 'approved');
    getContentById.mockResolvedValueOnce(page(7, BODY)).mockResolvedValueOnce(page(8, patched));

    const result = await run({ body: { edits: [{ oldStr: 'Status: draft', newStr: 'Status: approved' }] }, versionComment: 'approve' });

    expect(update2).toHaveBeenCalledWith('42', {
      id: '42', type: 'page', title: 'Big page', space: { key: 'DOC' },
      version: { number: 8, message: 'approve' },
      body: { storage: { value: patched, representation: 'storage' } },
    });
    expect(result).toEqual({
      success: true,
      data: {
        id: '42', type: 'page', title: 'Big page', spaceKey: 'DOC', version: 8,
        bodyUpdate: {
          source: 'edits',
          applied: [{ index: 0, matchedAt: 'spacing', offset: BODY.indexOf('Status'), changes: [{ offset: BODY.indexOf('draft'), removed: 'draft', inserted: 'approved' }] }],
          verification: { storedMatchesSent: true, normalisedByServer: false },
        },
      },
    });
  });

  it('refuses edits prepared against another version', async () => {
    getContentById.mockResolvedValue(page(9, BODY));
    const result = await run({ body: { edits: [{ oldStr: 'draft', newStr: 'x' }] } });
    expect(result.error).toMatch(/at version 9, so version must be 10/);
    expect(update2).not.toHaveBeenCalled();
  });

  it('merges a locally edited editable copy and keeps the stored form elsewhere', async () => {
    fs.writeFileSync(path.join(root, 'edited.xml'), BODY.replace(NBSP, ' ').replace('draft', 'final'));
    getContentById.mockResolvedValueOnce(page(7, BODY)).mockResolvedValueOnce(page(8, BODY.replace('draft', 'final')));

    const result = await run({ body: { editedPath: 'edited.xml' } });

    expect(update2.mock.calls[0][1].body.storage.value).toBe(BODY.replace('draft', 'final'));
    expect(result.data).toMatchObject({ bodyUpdate: { source: 'editedPath', changeCount: 1, verification: { storedMatchesSent: true } } });
  });

  it('writes a whole body from contentPath', async () => {
    fs.writeFileSync(path.join(root, 'page.xml'), `<p>${MARKER} new</p>`);
    getContentById.mockResolvedValueOnce(page(7, BODY)).mockResolvedValueOnce(page(8, `<p>${MARKER} new</p>`));

    const result = await run({ body: { contentPath: 'page.xml' } });

    expect(update2.mock.calls[0][1].body.storage.value).toBe(`<p>${MARKER} new</p>`);
    expect(result.data).toMatchObject({ bodyUpdate: { source: 'contentPath' } });
  });

  it('refuses edits that drop an inline comment marker unless told to report', async () => {
    getContentById.mockResolvedValue(page(7, BODY));
    const edits = [{ oldStr: MARKER, newStr: 'reviewed' }];

    const refused = await run({ body: { edits } });
    expect(refused).toMatchObject({ success: false, details: { lostInlineCommentRefs: ['r1'] } });
    expect(update2).not.toHaveBeenCalled();

    const reported = await run({ body: { edits }, onInlineCommentLoss: 'report' });
    expect(reported.data).toMatchObject({ bodyUpdate: { lostInlineCommentRefs: ['r1'] } });
    expect(update2).toHaveBeenCalledTimes(1);
  });

  it('writes a whole body that drops an inline comment marker and reports it, unless told to refuse', async () => {
    getContentById.mockResolvedValue(page(7, BODY));

    const reported = await run({ body: { content: '<p>reviewed text</p>' } });
    expect(reported.data).toMatchObject({ bodyUpdate: { source: 'content', lostInlineCommentRefs: ['r1'] } });
    expect(update2).toHaveBeenCalledTimes(1);

    const refused = await run({ body: { content: '<p>reviewed text</p>' }, onInlineCommentLoss: 'refuse' });
    expect(refused).toMatchObject({ success: false, details: { lostInlineCommentRefs: ['r1'] } });
    expect(update2).toHaveBeenCalledTimes(1);
  });

  it('reports the planned change without saving on dryRun', async () => {
    getContentById.mockResolvedValue(page(7, BODY));

    const result = await run({ body: { edits: [{ oldStr: 'Plan', newStr: 'Roadmap' }] }, dryRun: true });

    expect(update2).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({
      dryRun: true, version: 7, source: 'edits', lengthBefore: BODY.length, lengthAfter: BODY.length + 3, lostInlineCommentRefs: [],
    });
  });

  it('rejects more than one body source and a move under itself before reading the page', async () => {
    expect((await run({ body: { content: '<p/>', edits: [{ oldStr: 'a', newStr: 'b' }] } })).error)
      .toMatch(/at most one of content, contentPath, edits and editedPath; got content, edits/);
    expect((await run({ parentId: '42' })).error).toMatch(/cannot be its own parent/);
    expect(getContentById).not.toHaveBeenCalled();
  });

  it('saves the stored body of the new version when asked, and reports a failed save without failing the update', async () => {
    getContentById.mockResolvedValueOnce(page(7, BODY)).mockResolvedValueOnce(page(8, BODY));
    const saved = await run({ body: { content: BODY }, saveResult: 'editable' });
    const savedPath = path.join(root, '42-v8.editable.xml');
    expect(saved.data).toMatchObject({ bodyUpdate: { savedBody: { savedPath, form: 'editable' } } });
    expect(fs.readFileSync(savedPath, 'utf8')).toBe(`<h2>Plan</h2>\n<p>Status: draft</p>\n<p>${MARKER} text</p>\n`);

    getContentById.mockResolvedValueOnce(page(7, BODY)).mockResolvedValueOnce(page(8, BODY));
    const again = await run({ body: { content: BODY }, saveResult: 'editable' });
    expect(again.success).toBe(true);
    expect(again.data).toMatchObject({ bodyUpdate: { saveError: expect.any(String) } });
  });

  it('does not re-read the page after an update without a body', async () => {
    getContentById.mockResolvedValue(page(7, BODY));
    const result = await run({ title: 'Renamed' });
    expect(update2.mock.calls[0][1]).not.toHaveProperty('body');
    expect(update2.mock.calls[0][1].title).toBe('Renamed');
    expect(getContentById).toHaveBeenCalledTimes(1);
    expect(result.data).not.toHaveProperty('bodyUpdate');
  });

  it('passes a save conflict through', async () => {
    getContentById.mockResolvedValue(page(7, BODY));
    update2.mockRejectedValue({ status: 409, statusText: 'Conflict', body: { message: 'Version must be incremented' } });
    expect(await run({ body: { content: BODY } })).toEqual({
      success: false, error: 'Error updating content: 409 Conflict', details: { message: 'Version must be incremented' },
    });
  });

  it('reports a page it cannot read', async () => {
    getContentById.mockRejectedValue({ status: 404, statusText: 'Not Found', body: {} });
    expect((await run({ body: { content: BODY } })).error).toBe('Failed to retrieve content with ID 42: Error getting content: 404 Not Found');
  });
});
