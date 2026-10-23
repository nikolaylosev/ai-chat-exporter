import type { Attachment, Conversation, Message } from '../model/conversation';
import { renderHtml } from '../render/html';
import { renderJson } from '../render/json';
import { renderMarkdown, type RenderLabels, type RenderOptions } from '../render/markdown';
import { PLATFORM_LABEL } from '../shared/platform';
import { exportRootFolder, NOTE_EXTENSION, type Settings } from '../shared/settings';
import { localDate } from '../util/dates';
import {
  MIN_TITLE_LENGTH,
  PATH_BUDGET,
  planConversationFolder,
  fitFileNames,
  sanitizeRelativeDir,
  uniqueFileNames,
} from '../util/filename';

export interface BuildContext {
  now: Date;
  labels: RenderLabels;
  timeZone?: string;
  /** Extra parent folders inside the export root, e.g. a project's `chats/`. */
  parents?: string[];
}

export interface PlannedFile {
  attachment: Attachment;
  /** Path relative to the Markdown file: `files/<name>`. */
  link: string;
  /** Path relative to the export root. */
  path: string;
}

export interface ExportPlan {
  /** Export root as sanitized segments relative to the destination (Downloads or the chosen folder). */
  root: string[];
  /** Folder path relative to the export root. */
  folderPath: string;
  /** Markdown path relative to the export root. */
  markdownPath: string;
  /** Files to download, in conversation order. Empty when attachments are turned off. */
  files: PlannedFile[];
  createdSource: RenderOptions['createdSource'];
  overBudget: boolean;
}

export interface DownloadResults {
  /** Attachment id → link relative to the Markdown file. */
  saved: ReadonlyMap<string, string>;
  /** Attachment id → reason. */
  failed: ReadonlyMap<string, string>;
}

const FILES_DIR = 'files';

/** Creation date for the folder name: the platform's, else the first message's, else now. */
export function creationDate(
  c: Conversation,
  now: Date,
): { date: string | Date; source: RenderOptions['createdSource'] } {
  if (c.createdAt) return { date: c.createdAt, source: 'platform' };
  const first = c.messages.find((m) => m.createdAt)?.createdAt;
  if (first) return { date: first, source: 'first-message' };
  return { date: now, source: 'export' };
}

/** Messages that end up in the Markdown, and so the attachments that are downloaded. */
export function exportedMessages(c: Conversation, settings: Settings): Message[] {
  return settings.claudeBranches === 'all'
    ? [...c.messages, ...c.branches.flatMap((b) => b.messages)]
    : c.messages;
}

/** Name on disk: extracted text gets `.extracted.txt` so it is never mistaken for the original. */
function diskName(a: Attachment): string {
  return a.note === 'extracted-text-only' || a.note === 'extracted-text-partial'
    ? `${a.name}.extracted.txt`
    : a.name;
}

export function planConversationExport(
  c: Conversation,
  settings: Settings,
  ctx: BuildContext,
): ExportPlan {
  const root = sanitizeRelativeDir(exportRootFolder(settings));
  const rootPath = root.join('/');
  const created = creationDate(c, ctx.now);
  const attachments = settings.saveAttachments
    ? exportedMessages(c, settings).flatMap((m) => m.attachments)
    : [];
  let names = uniqueFileNames(attachments.map(diskName));
  const longest = (list: string[]) => Math.max(0, ...list.map((n) => `${FILES_DIR}/${n}`.length));

  const plan = (innerLength: number) =>
    planConversationFolder({
      rootPath,
      parents: ctx.parents ?? [],
      title: c.title,
      date: localDate(created.date, ctx.timeZone),
      platformLabel: settings.includePlatformInFolderName ? PLATFORM_LABEL[c.platform] : null,
      fallbackTitle: ctx.labels.untitled,
      noteExtension: NOTE_EXTENSION[settings.noteFormat],
      longestInnerPath: innerLength,
    });

  let folder = plan(longest(names));
  if (folder.overBudget) {
    // The title is already as short as allowed: shorten the file names instead.
    folder = plan(0);
    const used = (rootPath ? rootPath.length + 1 : 0) + folder.folderPath.length + 1;
    const room = Math.max(MIN_TITLE_LENGTH, PATH_BUDGET - used - FILES_DIR.length - 1);
    names = fitFileNames(attachments.map(diskName), room);
  }

  return {
    root,
    folderPath: folder.folderPath,
    markdownPath: folder.markdownPath,
    files: attachments.map((attachment, i) => {
      const link = `${FILES_DIR}/${names[i] ?? attachment.id}`;
      return { attachment, link, path: `${folder.folderPath}/${link}` };
    }),
    createdSource: created.source,
    overBudget: folder.overBudget,
  };
}

/**
 * The same plan inside another folder, e.g. `Chat (2)` when `Chat` already exists.
 * A note named after its folder is renamed with it, so note names stay unique in
 * Obsidian. Links inside the note are relative and do not change.
 */
export function moveToFolder(plan: ExportPlan, folderPath: string): ExportPlan {
  if (folderPath === plan.folderPath) return plan;
  const move = (path: string) => folderPath + path.slice(plan.folderPath.length);
  const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
  const markdownName = base(plan.markdownPath);
  const extension = markdownName.slice(markdownName.lastIndexOf('.'));
  const markdownPath =
    markdownName === `${base(plan.folderPath)}${extension}`
      ? `${folderPath}/${base(folderPath)}${extension}`
      : move(plan.markdownPath);
  return {
    ...plan,
    folderPath,
    markdownPath,
    files: plan.files.map((file) => ({ ...file, path: move(file.path) })),
  };
}

export function renderConversationExport(
  c: Conversation,
  settings: Settings,
  ctx: BuildContext,
  plan: ExportPlan,
  results: DownloadResults = { saved: new Map(), failed: new Map() },
): string {
  return renderMarkdown(c, {
    labels: ctx.labels,
    includeThinking: settings.saveThinking,
    includeToolCalls: settings.saveToolCalls,
    toolCallDetail: settings.toolCallDetail,
    includeBranches: settings.claudeBranches === 'all',
    exportedAt: ctx.now,
    createdSource: plan.createdSource,
    attachmentPaths: results.saved,
    attachmentErrors: results.failed,
    ...(ctx.timeZone ? { timeZone: ctx.timeZone } : {}),
  });
}

/** The note in the format the settings ask for: Markdown, its HTML page, or JSON. */
export function renderNote(
  c: Conversation,
  settings: Settings,
  ctx: BuildContext,
  plan: ExportPlan,
  results: DownloadResults = { saved: new Map(), failed: new Map() },
): string {
  if (settings.noteFormat === 'json') {
    return renderJson(c, {
      includeThinking: settings.saveThinking,
      includeToolCalls: settings.saveToolCalls,
      includeBranches: settings.claudeBranches === 'all',
      exportedAt: ctx.now,
      attachmentPaths: results.saved,
      attachmentErrors: results.failed,
    });
  }
  const markdown = renderConversationExport(c, settings, ctx, plan, results);
  return settings.noteFormat === 'html'
    ? renderHtml(markdown, c.title || ctx.labels.untitled)
    : markdown;
}
