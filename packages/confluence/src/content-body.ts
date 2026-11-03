import { handleApiOperation, type ApiErrorResponse, type AttachmentGatewaySide } from '@atlassian-dc-mcp/common';
import { ContentResourceService } from './confluence-client/index.js';
import { saveBodyFile, type BodyForm } from './content-files.js';
import { findInStorage } from './storage-edits.js';

export interface StorageContent {
  id: string;
  type: string;
  title: string;
  space: { key: string };
  version: { number: number };
  body: { storage: { value: string } };
}

type FetchedContent = Omit<StorageContent, 'version' | 'body'> & {
  version?: { number?: unknown };
  body?: { storage?: { value?: unknown } };
};

/** Reads content with its storage body; without `requireBody` a missing body reads as empty. */
export async function getStorageContent(
  contentId: string,
  options: { requireBody?: boolean } = {},
): Promise<ApiErrorResponse<StorageContent>> {
  return handleApiOperation(async () => {
    const content = (await ContentResourceService.getContentById(contentId, 'body.storage,version,space')) as unknown as FetchedContent;
    const version = content.version?.number;
    const body = content.body?.storage?.value;
    if (typeof version !== 'number') {
      throw new Error(`Content ${contentId} has no version`);
    }
    if (typeof body !== 'string' && options.requireBody !== false) {
      throw new Error(`Content ${contentId} has no storage body to read or edit`);
    }
    return { ...content, version: { number: version }, body: { storage: { value: typeof body === 'string' ? body : '' } } };
  }, 'Error getting content');
}

export async function findInContent(
  contentId: string,
  query: string,
  options: { contextChars?: number; maxMatches?: number } = {},
): Promise<ApiErrorResponse<unknown>> {
  const current = await getStorageContent(contentId);
  if (!current.success || !current.data) {
    return current;
  }
  const { id, title, version, body } = current.data;
  const found = findInStorage(body.storage.value, query, options);
  return {
    success: true,
    data: { contentId: id, title, version: version.number, bodyLength: body.storage.value.length, ...found },
  };
}

export async function saveContentBody(
  contentId: string,
  side: AttachmentGatewaySide,
  options: { form?: BodyForm; saveName?: string } = {},
): Promise<ApiErrorResponse<unknown>> {
  const current = await getStorageContent(contentId);
  if (!current.success || !current.data) {
    return current;
  }
  const { id, title, version, body } = current.data;
  return handleApiOperation(async () => {
    const savedBody = await saveBodyFile(
      { contentId: id, version: version.number, body: body.storage.value },
      options.form ?? 'storage',
      side,
      options.saveName,
    );
    return { contentId: id, title, version: version.number, savedBody };
  }, 'Error saving content body');
}
