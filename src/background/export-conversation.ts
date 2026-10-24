import type { Attachment, Conversation } from '../model/conversation';
import { localDateTime } from '../util/dates';
import { exportsAsZip, type Settings } from '../shared/settings';
import { exportedMessages } from './conversation-export';
import { DownloadsSink } from '../sinks/downloads-sink';
import type { ZipArchive } from '../sinks/offscreen-sinks';
import { FolderSink, ZipSink, type ZipTarget } from '../sinks/offscreen-sinks';
import { downloadWithRetry, removeDownloaded } from './downloader';
import { describeFailure, renderLabels } from './labels';
import { fixRecompressedNames } from '../util/image-type';
import { createBlobUrl, offscreenFiles, revokeBlobUrl, sniffImageType } from './offscreen-client';
import type { ExportRecord, RecordDestination, Registry } from './registry';
import { writeConversation, type WritableSink, type WriteOutcome } from './write-conversation';

export function recordDestination(settings: Settings, zip: boolean): RecordDestination {
  return zip ? 'zip' : settings.destination;
}

export function zipTarget(settings: Settings, root: string[]): ZipTarget {
  const overwrite = settings.onFolderExists === 'overwrite';
  return settings.destination === 'folder'
    ? { kind: 'folder', overwrite }
    : {
        kind: 'downloads',
        root,
        conflictAction: overwrite ? 'overwrite' : 'uniquify',
        download: (request) => downloadWithRetry(request),
      };
}

/**
 * The sink for the current settings. With `archive`, the conversation goes into
 * a bulk export's shared archive instead of an archive of its own.
 */
export function sinkFactory(
  settings: Settings,
  registry: Registry,
  archive?: ZipArchive,
  zip = false,
): (root: string[]) => WritableSink {
  const overwrite = settings.onFolderExists === 'overwrite';
  return (root) => {
    if (archive) return new ZipSink(archive);
    if (zip) return new ZipSink(offscreenFiles, zipTarget(settings, root));
    if (settings.destination === 'folder') return new FolderSink(offscreenFiles, overwrite);
    return new DownloadsSink(
      {
        download: (request) => downloadWithRetry(request),
        createBlobUrl,
        revokeBlobUrl,
        reserveFolder: (path, reuse) => registry.reserveFolder(path, reuse),
        removeDownloaded,
      },
      { root, conflictAction: overwrite ? 'overwrite' : 'uniquify' },
    );
  };
}

/**
 * Writes one conversation and records it in the export registry. In overwrite
 * mode, a conversation exported before to the same kind of destination goes back
 * into its recorded folder, even if its title or the date format changed.
 */
export interface ExportOptions {
  /** Folders inside the export root, e.g. a project's `chats/`. */
  parents?: string[];
  /** Registry key when it is not the conversation id: a chat saved with its project. */
  recordId?: string;
  /**
   * The chat list's update time, recorded instead of the conversation's: "skip
   * unchanged" compares with the list, and ChatGPT's two times differ by seconds.
   */
  listUpdatedAt?: string | null;
  /** A new link for a file whose link was refused (see WriteContext). */
  refreshLink?: (attachment: Attachment) => Promise<string | null>;
  /** Progress of the chat's files (see WriteContext). */
  onFileDone?: (done: number, total: number) => void;
}

export async function exportConversation(
  conversation: Conversation,
  settings: Settings,
  registry: Registry,
  archive?: ZipArchive,
  options: ExportOptions = {},
): Promise<WriteOutcome> {
  const now = new Date();
  const hasFiles = exportedMessages(conversation, settings).some((m) => m.attachments.length > 0);
  // One chat into Downloads: an archive of its own when it has files to save.
  const zip = !archive && exportsAsZip(settings, { bulk: false, hasFiles });
  // Before the files are planned, so the note links to the corrected names.
  if (settings.saveAttachments) {
    // A folder or a ZIP is written from the offscreen document, which keeps the file
    // it reads here; Downloads fetches by itself, so only the first bytes are read.
    const keep = Boolean(archive) || zip || settings.destination === 'folder';
    await fixRecompressedNames(conversation, (url) => sniffImageType(url, keep));
  }
  const destination = archive ? 'zip' : recordDestination(settings, zip);
  const recordId = options.recordId ?? conversation.id;
  const previous = await registry.record(conversation.platform, recordId);
  const reuse = reusedFolder(settings, destination, previous);
  // Writing into the earlier folder means replacing what is there, whatever the setting.
  const effective: Settings = reuse ? { ...settings, onFolderExists: 'overwrite' } : settings;

  const outcome = await writeConversation(
    conversation,
    effective,
    {
      now,
      labels: renderLabels(conversation.platform),
      describeFailure,
      ...(options.parents ? { parents: options.parents } : {}),
      ...(reuse ? { folderOverride: reuse } : {}),
      ...(reuse && previous?.files ? { previousFiles: previous.files } : {}),
      ...(options.refreshLink ? { refreshLink: options.refreshLink } : {}),
      ...(options.onFileDone ? { onFileDone: options.onFileDone } : {}),
    },
    sinkFactory(effective, registry, archive, zip),
  );

  await registry.remember(conversation.platform, recordId, {
    updatedAt: options.listUpdatedAt ?? conversation.updatedAt,
    exportedAt: now.toISOString(),
    destination,
    folder: outcome.plan.folderPath,
    ...(outcome.missingFiles ? { missingFiles: outcome.missingFiles } : {}),
    ...(destination !== 'zip' && outcome.writtenFiles.length
      ? { files: outcome.writtenFiles }
      : {}),
  });
  return outcome;
}

/**
 * The recorded folder to write into again, or null for a new one. It is reused
 * in "overwrite" mode, and also when the earlier export missed files: that
 * folder is completed instead of left half-done next to a `(2)` copy. Never for
 * a ZIP, which keeps no folder.
 */
export function reusedFolder(
  settings: Settings,
  destination: RecordDestination,
  previous: ExportRecord | undefined,
): string | null {
  if (!previous || destination === 'zip' || previous.destination !== destination) return null;
  return settings.onFolderExists === 'overwrite' || previous.missingFiles ? previous.folder : null;
}

/** Name of a bulk export's archive, e.g. `Claude - 2026-10-13 15-40.zip`. */
export function bulkArchiveName(platformLabel: string, now: Date, timeZone?: string): string {
  return `${platformLabel} - ${localDateTime(now, timeZone).replace(':', '-')}.zip`;
}
