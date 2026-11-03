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

function isStorageContent(value: unknown): value is StorageContent {
  const content = value as { body?: { storage?: { value?: unknown } }; version?: { number?: unknown } } | null;
  return typeof content?.body?.storage?.value === 'string' && typeof content.version?.number === 'number';
}

export async function getStorageContent(contentId: string): Promise<ApiErrorResponse<StorageContent>> {
  return handleApiOperation(async () => {
    const content: unknown = await ContentResourceService.getContentById(contentId, 'body.storage,version,space');
    if (!isStorageContent(content)) {
      throw new Error(`Content ${contentId} has no storage body to read or edit`);
    }
    return content;
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
