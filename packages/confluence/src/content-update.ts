import { handleApiOperation, type ApiErrorResponse, type AttachmentGateway } from '@atlassian-dc-mcp/common';
import { ContentResourceService } from './confluence-client/index.js';
import { shapeConfluenceMutationAck } from './confluence-response-mapper.js';
import type { ConfluenceContent } from './confluence-service.js';
import { getStorageContent, type StorageContent } from './content-body.js';
import { readUploadedText, saveBodyFile, type BodyForm, type SavedBody } from './content-files.js';
import {
  applyStorageEdits,
  compareStoredBody,
  lostInlineCommentRefs,
  mergeEditedBody,
  type AppliedStorageEdit,
  type BodyChange,
  type StorageEdit,
} from './storage-edits.js';

/** Where the new body comes from; at most one is set. */
export interface BodySource {
  content?: string;
  contentPath?: string;
  edits?: StorageEdit[];
  editedPath?: string;
}

export interface PageUpdate {
  contentId: string;
  version: number;
  title?: string;
  versionComment?: string;
  parentId?: string;
  output?: 'ack' | 'full';
  body: BodySource;
  dryRun?: boolean;
  allowInlineCommentLoss?: boolean;
  saveResult?: BodyForm;
}

interface PlannedBody {
  source: keyof BodySource;
  body: string;
  applied?: AppliedStorageEdit[];
  changes?: BodyChange[];
}

interface BodyUpdateReport {
  source?: keyof BodySource;
  applied?: unknown[];
  changes?: unknown[];
  changeCount?: number;
  verification?: ReturnType<typeof compareStoredBody>;
  verificationError?: string;
  savedBody?: SavedBody;
  saveError?: string;
}

const PREVIEW_CHARS = 200;
const PREVIEW_CHANGES = 20;

function provided(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

function validationError(update: PageUpdate): string | undefined {
  if (update.parentId && update.parentId === update.contentId) {
    return `parentId (${update.parentId}) must be different from contentId; a page cannot be its own parent`;
  }
  const { content, contentPath, edits, editedPath } = update.body;
  const sources = Object.entries({ content, contentPath, editedPath })
    .filter(([, value]) => provided(value))
    .map(([name]) => name)
    .concat(edits ? ['edits'] : []);
  return sources.length > 1
    ? `Pass at most one of content, contentPath, edits and editedPath; got ${sources.join(', ')}`
    : undefined;
}

function assertEditableVersion(current: StorageContent, version: number): void {
  const currentVersion = current.version.number;
  if (version !== currentVersion + 1) {
    throw new Error(
      `Page ${current.id} is at version ${currentVersion}, so version must be ${currentVersion + 1}. ` +
      'Re-read the page if it changed since you prepared the edits.',
    );
  }
}

async function planBody(update: PageUpdate, current: StorageContent, gateway: AttachmentGateway): Promise<PlannedBody | undefined> {
  const { content, contentPath, edits, editedPath } = update.body;
  const currentBody = current.body.storage.value;
  if (provided(content)) {
    return { source: 'content', body: content };
  }
  if (provided(contentPath)) {
    return { source: 'contentPath', body: await readUploadedText(contentPath, gateway.upload) };
  }
  if (edits) {
    assertEditableVersion(current, update.version);
    const { body, applied } = applyStorageEdits(currentBody, edits);
    return { source: 'edits', body, applied };
  }
  if (provided(editedPath)) {
    assertEditableVersion(current, update.version);
    const { body, changes } = mergeEditedBody(currentBody, await readUploadedText(editedPath, gateway.upload));
    return { source: 'editedPath', body, changes };
  }
  return undefined;
}

function clip(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}… (+${text.length - PREVIEW_CHARS} chars)` : text;
}

function previewChanges(changes: BodyChange[]) {
  return changes.slice(0, PREVIEW_CHANGES).map(({ offset, removed, inserted }) => ({ offset, removed: clip(removed), inserted: clip(inserted) }));
}

function summarize(planned: PlannedBody): BodyUpdateReport {
  return {
    source: planned.source,
    ...(planned.applied ? {
      applied: planned.applied.map(({ index, matchedAt, offset, changes }) => ({ index, matchedAt, offset, changes: previewChanges(changes) })),
    } : {}),
    ...(planned.changes ? { changeCount: planned.changes.length, changes: previewChanges(planned.changes) } : {}),
  };
}

function toUpdate(update: PageUpdate, current: StorageContent, body: string | undefined): ConfluenceContent {
  return {
    id: update.contentId,
    type: current.type,
    title: update.title || current.title,
    space: current.space,
    version: { number: update.version, message: update.versionComment },
    ...(body !== undefined ? { body: { storage: { value: body, representation: 'storage' as const } } } : {}),
    ...(update.parentId ? { ancestors: [{ id: update.parentId }] } : {}),
  };
}

async function reportAfterWrite(update: PageUpdate, planned: PlannedBody | undefined, gateway: AttachmentGateway): Promise<BodyUpdateReport | undefined> {
  if (!planned && !update.saveResult) {
    return undefined;
  }
  const report: BodyUpdateReport = planned ? summarize(planned) : {};
  const stored = await getStorageContent(update.contentId);
  if (!stored.success || !stored.data) {
    return { ...report, verificationError: stored.error };
  }
  const storedBody = stored.data.body.storage.value;
  if (planned) {
    report.verification = compareStoredBody(planned.body, storedBody);
  }
  if (update.saveResult) {
    try {
      const content = { contentId: stored.data.id, version: stored.data.version.number, body: storedBody };
      report.savedBody = await saveBodyFile(content, update.saveResult, gateway.download);
    } catch (error) {
      report.saveError = error instanceof Error ? error.message : String(error);
    }
  }
  return report;
}

/**
 * Updates a page's title, parent and/or body. A body comes whole (content, contentPath) or as changes to the
 * current body (edits, editedPath), which then require version = current + 1. Nothing is written when the new
 * body would drop an inline comment marker, unless allowInlineCommentLoss is set. After a body write the page
 * is re-read and the response reports whether Confluence stored what was sent.
 */
export async function updatePage(update: PageUpdate, gateway: AttachmentGateway): Promise<ApiErrorResponse<unknown>> {
  const invalid = validationError(update);
  if (invalid) {
    return { success: false, error: invalid };
  }
  const current = await getStorageContent(update.contentId);
  if (!current.success || !current.data) {
    return { success: false, error: `Failed to retrieve content with ID ${update.contentId}: ${current.error || 'Unknown error'}` };
  }
  const page = current.data;
  const planned = await handleApiOperation(() => planBody(update, page, gateway), 'Error preparing the new body');
  if (!planned.success) {
    return planned;
  }
  const lost = planned.data ? lostInlineCommentRefs(page.body.storage.value, planned.data.body) : [];
  if (lost.length > 0 && !update.allowInlineCommentLoss) {
    return inlineCommentRefusal(lost);
  }
  if (update.dryRun) {
    return { success: true, data: dryRunResult(page, planned.data, lost) };
  }
  const saved = await handleApiOperation(
    () => ContentResourceService.update2(update.contentId, toUpdate(update, page, planned.data?.body)),
    'Error updating content',
  );
  if (!saved.success || !saved.data) {
    return saved;
  }
  const bodyUpdate = await reportAfterWrite(update, planned.data, gateway);
  const data = update.output === 'full' ? saved.data : shapeConfluenceMutationAck(saved.data);
  return { success: true, data: bodyUpdate ? { ...data, bodyUpdate } : data };
}

function inlineCommentRefusal(lost: string[]): ApiErrorResponse<unknown> {
  return {
    success: false,
    error: `The new body removes ${lost.length} inline comment marker(s), which would detach their comment threads; ` +
      'nothing was written. Keep the <ac:inline-comment-marker> elements, or pass allowInlineCommentLoss.',
    details: { lostInlineCommentRefs: lost },
  };
}

function dryRunResult(page: StorageContent, planned: PlannedBody | undefined, lost: string[]) {
  return {
    dryRun: true,
    contentId: page.id,
    version: page.version.number,
    ...(planned ? summarize(planned) : {}),
    lengthBefore: page.body.storage.value.length,
    ...(planned ? { lengthAfter: planned.body.length } : {}),
    lostInlineCommentRefs: lost,
  };
}
