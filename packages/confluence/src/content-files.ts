import { readFile, writeFile } from 'node:fs/promises';
import {
  handleApiOperation,
  resolveDownloadDestination,
  resolveUploadSource,
  type ApiErrorResponse,
  type AttachmentGatewaySide,
} from '@atlassian-dc-mcp/common';
import { editableText } from './storage-normalization.js';

/**
 * `storage` is the body exactly as Confluence stores it. `editable` is the same body with space variants
 * as plain spaces, invisible characters, macro ids and empty parameters dropped, character references
 * decoded and one block per line, so it can be edited as plain text; it is meant for `editedPath`, not
 * as a whole new body.
 */
export type BodyForm = 'storage' | 'editable';

export interface SavedBody {
  savedPath: string;
  form: BodyForm;
  length: number;
}

/** Reads a UTF-8 file from the upload root without a leading BOM; page bodies share the attachment directories. */
export async function readUploadedText(requestedPath: string, side: AttachmentGatewaySide): Promise<string> {
  if (!side.enabled) {
    throw new Error('Reading page bodies from files needs the upload directory, which is disabled on this server');
  }
  const { absolutePath } = await resolveUploadSource({ requestedPath, side });
  const text = await readFile(absolutePath, 'utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The body of a new page: inline `content` or a file at `contentPath` in the upload root; an empty value counts as absent. */
export async function resolveCreateBody(
  content: string | undefined,
  contentPath: string | undefined,
  side: AttachmentGatewaySide,
): Promise<ApiErrorResponse<string>> {
  if (content && contentPath) {
    return { success: false, error: 'Pass either content or contentPath, not both' };
  }
  if (!contentPath) {
    return content === undefined
      ? { success: false, error: 'Either content or contentPath is required' }
      : { success: true, data: content };
  }
  return handleApiOperation(() => readUploadedText(contentPath, side), 'Error reading content file');
}

export function bodyInForm(body: string, form: BodyForm): string {
  return form === 'editable' ? editableText(body) : body;
}

/** Writes a body into the download root under `<contentId>-v<version>.<form>.xml` unless named; never overwrites. */
export async function saveBodyFile(
  content: { contentId: string; version: number; body: string },
  form: BodyForm,
  side: AttachmentGatewaySide,
  saveName?: string,
): Promise<SavedBody> {
  const text = bodyInForm(content.body, form);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > side.maxBytes) {
    throw new Error(`The ${form} body is ${bytes} bytes, over the configured download limit of ${side.maxBytes} bytes`);
  }
  const requestedName = saveName ?? `${content.contentId}-v${content.version}.${form}.xml`;
  const savedPath = await resolveDownloadDestination({ requestedName, side });
  await writeFile(savedPath, text, { encoding: 'utf8', flag: 'wx' });
  return { savedPath, form, length: text.length };
}
