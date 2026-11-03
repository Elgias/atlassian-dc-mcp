import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AttachmentGatewaySide } from '@atlassian-dc-mcp/common';
import { ContentResourceService } from '../confluence-client/index.js';
import { findInContent, saveContentBody } from '../content-body.js';
import { readUploadedText, resolveCreateBody, saveBodyFile } from '../content-files.js';

jest.mock('../confluence-client/index.js', () => ({
  ContentResourceService: { getContentById: jest.fn() },
  AttachmentsService: {},
  SearchService: {},
  UserService: {},
  OpenAPI: { BASE: '', TOKEN: '', VERSION: '' },
}));

const NBSP = ' ';

describe('page bodies on the local filesystem', () => {
  let root: string;
  const side = (overrides: Partial<AttachmentGatewaySide> = {}): AttachmentGatewaySide => ({
    enabled: true, roots: [root], maxBytes: 1024, ...overrides,
  });

  beforeEach(() => {
    jest.resetAllMocks();
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-mcp-body-')));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('resolveCreateBody', () => {
    it('takes inline content or a UTF-8 file from the upload root', async () => {
      fs.writeFileSync(path.join(root, 'page.xml'), '<p>Привіт</p>', 'utf8');
      expect(await resolveCreateBody('<p/>', undefined, side())).toEqual({ success: true, data: '<p/>' });
      expect(await resolveCreateBody(undefined, 'page.xml', side())).toEqual({ success: true, data: '<p>Привіт</p>' });
    });

    it('rejects both, neither, a path outside the root and a disabled gateway', async () => {
      fs.writeFileSync(path.join(root, 'page.xml'), '<p/>');
      const results = await Promise.all([
        resolveCreateBody('<p/>', 'page.xml', side()),
        resolveCreateBody(undefined, undefined, side()),
        resolveCreateBody(undefined, '../page.xml', side()),
        resolveCreateBody(undefined, 'page.xml', side({ enabled: false })),
      ]);
      expect(results.map(r => r.success)).toEqual([false, false, false, false]);
    });
  });

  it('reads an empty content as absent and drops a leading BOM', async () => {
    fs.writeFileSync(path.join(root, 'page.xml'), '\ufeff<p>body</p>', 'utf8');
    expect(await resolveCreateBody('', 'page.xml', side())).toEqual({ success: true, data: '<p>body</p>' });
    expect(await resolveCreateBody('', undefined, side())).toEqual({ success: true, data: '' });
  });

  it('refuses an upload file over the size limit', async () => {
    fs.writeFileSync(path.join(root, 'big.xml'), 'x'.repeat(2048));
    await expect(readUploadedText('big.xml', side())).rejects.toThrow(/exceeds/);
  });

  describe('saveBodyFile', () => {
    it('names the file after the version and form and never overwrites it', async () => {
      const content = { contentId: '42', version: 3, body: `<p>a${NBSP}b</p>` };
      const saved = await saveBodyFile(content, 'editable', side());
      expect(saved).toEqual({ savedPath: path.join(root, '42-v3.editable.xml'), form: 'editable', length: 11 });
      expect(fs.readFileSync(saved.savedPath, 'utf8')).toBe('<p>a b</p>\n');
      await expect(saveBodyFile(content, 'editable', side())).rejects.toThrow();
      await expect(saveBodyFile({ ...content, body: 'x'.repeat(2048) }, 'storage', side(), 'big.xml')).rejects.toThrow(/over the configured download limit/);
      expect((await saveBodyFile(content, 'storage', side(), 'copy.xml')).savedPath).toBe(path.join(root, 'copy.xml'));
    });
  });

  describe('content-body', () => {
    const page = { id: '42', type: 'page', title: 'Big page', space: { key: 'DOC' }, version: { number: 5 }, body: { storage: { value: `<p>rule${NBSP}set</p>` } } };

    it('finds text without returning the body', async () => {
      (ContentResourceService.getContentById as jest.Mock).mockResolvedValue(page);
      expect(await findInContent('42', 'rule set', { contextChars: 3 })).toEqual({
        success: true,
        data: {
          contentId: '42', title: 'Big page', version: 5, bodyLength: 15, matchedAt: 'spacing', total: 1,
          matches: [{ offset: 3, before: '<p>', match: `rule${NBSP}set`, after: '</p' }],
        },
      });
      expect(ContentResourceService.getContentById).toHaveBeenCalledWith('42', 'body.storage,version,space');
    });

    it('saves the body in the requested form', async () => {
      (ContentResourceService.getContentById as jest.Mock).mockResolvedValue(page);
      expect(await saveContentBody('42', side(), { form: 'storage' })).toEqual({
        success: true,
        data: {
          contentId: '42', title: 'Big page', version: 5,
          savedBody: { savedPath: path.join(root, '42-v5.storage.xml'), form: 'storage', length: 15 },
        },
      });
    });

    it('reports content without a storage body', async () => {
      (ContentResourceService.getContentById as jest.Mock).mockResolvedValue({ ...page, body: {} });
      expect((await findInContent('42', 'rule')).error).toBe('Content 42 has no storage body to read or edit');
    });

    it('passes a read failure through', async () => {
      (ContentResourceService.getContentById as jest.Mock).mockRejectedValue({ status: 404, statusText: 'Not Found', body: {} });
      expect((await saveContentBody('42', side())).error).toBe('Error getting content: 404 Not Found');
    });
  });
});
