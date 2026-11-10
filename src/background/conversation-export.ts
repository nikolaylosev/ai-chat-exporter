import type { Attachment, Conversation, Message } from '../model/conversation';
import {
  dirOf,
  keepLine,
  relativePath,
  vaultSafeName,
  type AttachmentPlace,
  type VaultRules,
} from '../obsidian/vault';
import { renderHtml } from '../render/html';
import { renderJson } from '../render/json';
import { renderMarkdown, type RenderLabels, type RenderOptions } from '../render/markdown';
import { PLATFORM_LABEL, type Platform } from '../shared/platform';
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
  /** Writing into an Obsidian vault: its rules (obsidian/vault.ts). */
  vault?: VaultRules;
}

export interface PlannedFile {
  attachment: Attachment;
  /** The file's name on disk. */
  name: string;
  /**
   * What the note links to: the path relative to the note (`files/<name>`), or in
   * a vault whose links are not relative, the path from the vault root.
   */
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
  /** The vault the plan is for, so a moved plan puts its files by the same rules. */
  vault?: VaultRules;
}

export interface DownloadResults {
  /** Attachment id → link relative to the Markdown file. */
  saved: ReadonlyMap<string, string>;
  /** Attachment id → reason. */
  failed: ReadonlyMap<string, string>;
}

const FILES_DIR = 'files';

/**
 * Folders inside a vault where a platform's chats go: `AI Chats/Claude`. Empty
 * outside a vault, where the export root holds the chats.
 */
export function vaultBase(settings: Settings, platform: Platform, vault?: VaultRules): string[] {
  return vault ? [...sanitizeRelativeDir(settings.obsidianFolder), PLATFORM_LABEL[platform]] : [];
}

/** The folder of a chat's files, relative to the export root (the vault's root in a vault). */
function filesDir(folderPath: string, place: AttachmentPlace | undefined): string {
  if (!place || place.kind === 'chat') return `${folderPath}/${FILES_DIR}`;
  if (place.kind === 'beside') return folderPath;
  if (place.kind === 'beside-sub') return `${folderPath}/${place.dir}`;
  // A folder of the chat's own in the vault's attachment folder: names stay as they were.
  return `${place.dir}/${folderPath.slice(folderPath.lastIndexOf('/') + 1)}`;
}

function placeFiles(
  attachments: readonly Attachment[],
  names: readonly string[],
  folderPath: string,
  markdownPath: string,
  vault: VaultRules | undefined,
): PlannedFile[] {
  const dir = filesDir(folderPath, vault?.attachments);
  return attachments.map((attachment, i) => {
    const name = names[i] ?? attachment.id;
    const path = `${dir}/${name}`;
    return { attachment, name, link: vaultLink(path, markdownPath, vault), path };
  });
}

/**
 * How a note at `markdownPath` links to `path` (both from the export root): a
 * relative path, as outside a vault; in a vault, the path from its root, which
 * a wikilink always resolves, unless the vault wants relative Markdown links.
 */
export function vaultLink(path: string, markdownPath: string, vault?: VaultRules): string {
  return !vault || (!vault.wiki && vault.linkFormat === 'relative')
    ? relativePath(dirOf(markdownPath), path)
    : path;
}

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
  const { vault } = ctx;
  // In a vault, names keep clear of what breaks a wikilink.
  const named = (name: string) => (vault ? vaultSafeName(name) : name);
  let names = uniqueFileNames(attachments.map((a) => named(diskName(a))));
  const longest = (list: string[]) => Math.max(0, ...list.map((n) => `${FILES_DIR}/${n}`.length));

  const plan = (innerLength: number) =>
    planConversationFolder({
      rootPath,
      parents: ctx.parents ?? vaultBase(settings, c.platform, vault),
      title: named(c.title),
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
    names = fitFileNames(
      attachments.map((a) => named(diskName(a))),
      room,
    );
  }

  return {
    root,
    folderPath: folder.folderPath,
    markdownPath: folder.markdownPath,
    files: placeFiles(attachments, names, folder.folderPath, folder.markdownPath, vault),
    createdSource: created.source,
    overBudget: folder.overBudget,
    ...(vault ? { vault } : {}),
  };
}

/**
 * The same plan inside another folder, e.g. `Chat (2)` when `Chat` already exists.
 * A note named after its folder is renamed with it, so note names stay unique in
 * Obsidian. The files are placed again: in a vault they may sit outside the folder.
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
  const files = placeFiles(
    plan.files.map((f) => f.attachment),
    plan.files.map((f) => f.name),
    folderPath,
    markdownPath,
    plan.vault,
  );
  return { ...plan, folderPath, markdownPath, files };
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
    ...(ctx.vault
      ? { obsidian: { wiki: ctx.vault.wiki, keepLine: keepLine(ctx.labels.keepNotes) } }
      : {}),
  });
}

/**
 * The note in the format the settings ask for: Markdown, its HTML page, or JSON.
 * A Word note is its Markdown here; the offscreen document makes the document
 * where the images are (see writeConversation).
 */
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
