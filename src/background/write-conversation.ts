import type { Attachment, Conversation } from '../model/conversation';
import { CodedError } from '../shared/errors';
import { log } from '../shared/logger';
import { MAX_LISTED_FAILURES, type FileFailure, type SavedLocation } from '../shared/messages';
import type { Settings } from '../shared/settings';
import type { ExportSink } from '../sinks/types';
import {
  moveToFolder,
  planConversationExport,
  renderNote,
  type BuildContext,
  type ExportPlan,
} from './conversation-export';
import { FileWriteError } from '../sinks/source';
import { HttpError } from '../util/http';
import { DownloadInterruptedError } from './downloader';
import { FILE_CONCURRENCY, forEachLimit } from '../util/pool';
import { embedsInWord } from '../render/docx';
import type { FileSource } from '../sinks/types';

export interface WritableSink extends ExportSink {
  /** Set when a write probably hit a Save As dialog (DownloadsSink). */
  readonly saveDialogSuspected?: boolean;
  /** Files written at the same time; FILE_CONCURRENCY when not set. */
  readonly fileConcurrency?: number;
  /** Picks the folder to write into, e.g. `Chat (2)` when `Chat` exists. */
  prepareFolder?(folderPath: string): Promise<string>;
  /** Completes the export (closes an archive) and says where it was saved. */
  finish(markdownPath: string): Promise<SavedLocation>;
  /** Drops a half-written export (an open archive) after a failure. */
  abort?(): Promise<void>;
  /** Deletes a file written by an earlier export; a sink that cannot leaves it. */
  removeFile?(path: string): Promise<void>;
}

export interface WriteContext extends BuildContext {
  /** Human-readable reason for a failed or unavailable attachment. */
  describeFailure: (error: unknown) => string;
  /** Folder (relative to the export root) to write into instead of the planned one: overwrite mode. */
  folderOverride?: string;
  /** A new link for a file whose link was refused, e.g. an expired signed link. */
  refreshLink?: (attachment: Attachment) => Promise<string | null>;
  /**
   * Files the earlier export wrote into the folder being written again (paths from
   * the export root): those the chat no longer has are deleted afterwards.
   */
  previousFiles?: readonly string[];
  /** After each file, saved or not: how many of the chat's files are done. */
  onFileDone?: (done: number, total: number) => void;
}

/** The server refused the link (401, 403, 404, 410): a fresh link may work. */
export function isRefusedLink(error: unknown): boolean {
  const reason =
    error instanceof DownloadInterruptedError || error instanceof FileWriteError
      ? error.reason
      : error instanceof HttpError
        ? `HTTP_${error.status}`
        : '';
  return /^SERVER_(FORBIDDEN|UNAUTHORIZED|BAD_CONTENT)$|^HTTP_(401|403|404|410)$/.test(reason);
}

export interface WriteOutcome {
  plan: ExportPlan;
  /** Markdown path relative to the sink root. */
  markdownPath: string;
  location: SavedLocation;
  savedFiles: number;
  failedFiles: number;
  /** Files that were not saved, with the reason; at most MAX_LISTED_FAILURES. */
  failures: FileFailure[];
  /**
   * Of the failed files, those that did not arrive for a passing reason (network,
   * server): another export may get them, unlike unavailable or refused ones.
   */
  missingFiles: number;
  /** Paths (from the export root) of the files saved, for the next export of the chat. */
  writtenFiles: string[];
}

/**
 * A failure another export may get past: the connection or the server (429, 5xx).
 * A refused or missing file (403, 404) or a disk error would fail the same way
 * again, so it does not make the chat worth exporting again.
 */
export function isTransientFailure(error: unknown): boolean {
  const reason =
    error instanceof DownloadInterruptedError || error instanceof FileWriteError
      ? error.reason
      : error instanceof HttpError
        ? `HTTP_${error.status}`
        : '';
  if (error instanceof TypeError) return true;
  return /^NETWORK_|^SERVER_(FAILED|NO_RANGE|CONTENT_LENGTH_MISMATCH)$|^HTTP_(429|5\d\d)$/.test(
    reason,
  );
}

function isSaveDialog(error: unknown): boolean {
  return error instanceof DownloadInterruptedError && error.saveDialogSuspected;
}

/** A file went to another folder: Chrome asks where to save each file. */
const askedWhere = () => new CodedError('save-dialog', 'Chrome asks where to save each file');
/** A file download was cancelled: in its Save As dialog or in the downloads list. */
const cancelled = () => new CodedError('download-cancelled', 'A file download was cancelled');

/**
 * Rethrows errors that should stop an export instead of marking one file: a
 * probable Save As dialog, and coded errors from the sink (no folder access, the
 * folder is gone).
 */
export function rethrowIfFatal(error: unknown, sink: WritableSink): void {
  if (isSaveDialog(error)) throw cancelled();
  if (sink.saveDialogSuspected) throw askedWhere();
  if (error instanceof CodedError) throw error;
}

/**
 * Saves a conversation: its attachments into `files/`, a few at a time, then the
 * Markdown, whose links point only at files that were saved. A failed file does
 * not stop the export. A probable Save As dialog does, so the user is not asked
 * once per file, and so does a coded error from the sink (no access to the
 * chosen folder, the folder is gone).
 */
export async function writeConversation(
  conversation: Conversation,
  settings: Settings,
  ctx: WriteContext,
  makeSink: (root: string[]) => WritableSink,
): Promise<WriteOutcome> {
  let plan = planConversationExport(conversation, settings, ctx);
  const sink = makeSink(plan.root);
  const saved = new Map<string, string>();
  const failed = new Map<string, string>();
  let missingFiles = 0;
  let filesDone = 0;
  const stopForDialog = () => {
    throw askedWhere();
  };
  const stopIfFatal = (error: unknown) => {
    if (isSaveDialog(error)) throw cancelled();
    if (error instanceof CodedError) throw error;
  };

  try {
    if (ctx.folderOverride) plan = moveToFolder(plan, ctx.folderOverride);
    if (sink.prepareFolder) plan = moveToFolder(plan, await sink.prepareFolder(plan.folderPath));

    // A Word note embeds the chat's images: the offscreen document keeps them for it.
    const word = settings.noteFormat === 'docx';
    const forNote = (path: string, source: FileSource): FileSource =>
      word && source.kind === 'url' && embedsInWord(path) ? { ...source, forNote: true } : source;
    const writeOne = async (file: ExportPlan['files'][number]) => {
      const { attachment } = file;
      if (!attachment.source) {
        failed.set(
          attachment.id,
          attachment.unavailableReason ?? ctx.describeFailure('unavailable'),
        );
        return;
      }
      try {
        try {
          await sink.writeFile(file.path, forNote(file.path, attachment.source));
        } catch (error) {
          stopIfFatal(error);
          const source = attachment.source;
          const fresh =
            source.kind === 'url' && isRefusedLink(error) && ctx.refreshLink
              ? await ctx.refreshLink(attachment).catch(() => null)
              : null;
          if (!fresh || source.kind !== 'url' || fresh === source.url) throw error;
          await sink.writeFile(file.path, forNote(file.path, { kind: 'url', url: fresh }));
        }
        saved.set(attachment.id, file.link);
      } catch (error) {
        stopIfFatal(error);
        failed.set(attachment.id, ctx.describeFailure(error));
        if (isTransientFailure(error)) missingFiles++;
      }
      if (sink.saveDialogSuspected) stopForDialog();
    };
    await forEachLimit(plan.files, sink.fileConcurrency ?? FILE_CONCURRENCY, async (file) => {
      await writeOne(file);
      ctx.onFileDone?.(++filesDone, plan.files.length);
    });

    const note = renderNote(conversation, settings, ctx, plan, { saved, failed });
    try {
      if (word) {
        const title = conversation.title || ctx.labels.untitled;
        await sink.writeFile(plan.markdownPath, { kind: 'docx', markdown: note, title });
      } else await sink.writeText(plan.markdownPath, note);
    } catch (error) {
      stopIfFatal(error);
      throw error;
    }
    // The note is the last file: if Chrome asked and the user put it elsewhere, it is
    // saved there, and the sink reports where (DownloadsSink.finish).

    // A file the chat no longer has, left by the export this one replaces.
    const planned = new Set([...plan.files.map((f) => f.path), plan.markdownPath]);
    for (const path of ctx.previousFiles ?? []) {
      if (planned.has(path) || !sink.removeFile) continue;
      await sink.removeFile(path).catch((error: unknown) => {
        stopIfFatal(error);
        log.info('Old file not removed', path, error);
      });
    }

    const failures = plan.files
      .filter((file) => failed.has(file.attachment.id))
      .map((file) => ({
        name: file.link.slice(file.link.lastIndexOf('/') + 1),
        reason: failed.get(file.attachment.id) ?? '',
      }));
    for (const f of failures) log.info('File not saved', conversation.title, f.name, f.reason);
    return {
      plan,
      markdownPath: plan.markdownPath,
      location: await sink.finish(plan.markdownPath),
      savedFiles: saved.size,
      failedFiles: failed.size,
      failures: failures.slice(0, MAX_LISTED_FAILURES),
      missingFiles,
      writtenFiles: plan.files.filter((f) => saved.has(f.attachment.id)).map((f) => f.path),
    };
  } catch (error) {
    await sink.abort?.().catch(() => undefined);
    throw error;
  }
}
