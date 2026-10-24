import type { Conversation } from '../model/conversation';
import { errorText } from '../shared/error-text';
import { CodedError, errorCode, type ErrorCode } from '../shared/errors';
import { t } from '../shared/i18n';
import {
  isJobActive,
  itemKey,
  JOB_KEY,
  jobCounts,
  type JobItem,
  type JobState,
} from '../shared/job';
import { log } from '../shared/logger';
import { setBadge as setIconBadge, type BadgeState } from './badge';
import { sendToTab, type JobStartItem, type SavedLocation } from '../shared/messages';
import { PLATFORM_LABEL, type Platform } from '../shared/platform';
import { exportRootFolder, exportsAsZip, loadSettings } from '../shared/settings';
import { DownloadsSink } from '../sinks/downloads-sink';
import { FolderSink, ZipArchive } from '../sinks/offscreen-sinks';
import { sanitizeRelativeDir } from '../util/filename';
import { refreshFound } from '../shared/search-cache';
import { downloadAndWait } from './downloader';
import { bulkArchiveName, exportConversation, zipTarget } from './export-conversation';
import { reportLabels } from './labels';
import {
  exportProject,
  projectChatOptions,
  projectLabels,
  recordProjectChat,
  writePendingProjectNotes,
} from './project-job';
import { projectFolderName } from './project-export';
import { createBlobUrl, offscreenFiles, revokeBlobUrl } from './offscreen-client';
import { registry } from './registry';
import { renderReport, reportPath, wantsReport } from './report';
import { WorkerTab } from './tabs';

/**
 * Bulk export: one conversation at a time, with a pause between them
 * (docs/ARCHITECTURE.md, section 10); the next one is read while the current one
 * is written. The state is saved after every conversation, so a restarted
 * service worker resumes the job (resumeJob).
 */

/** Problems that would fail every remaining conversation too: the job stops. */
const STOP_CODES = new Set<ErrorCode>([
  'archive-lost',
  'not-signed-in',
  // Asking again at once only prolongs the limit; a later run continues (skip unchanged).
  'rate-limited',
  'save-dialog',
  'download-cancelled',
  'save-cancelled',
  'folder-not-chosen',
  'folder-permission',
  'folder-missing',
]);

interface Running {
  job: JobState;
  archive: ZipArchive | undefined;
  tab: WorkerTab;
  /** The next chat, being read while the current one is written. */
  next?: { id: string; conversation: Promise<Conversation> };
}

let current: Running | null = null;

export async function loadJob(): Promise<JobState | null> {
  const data = await chrome.storage.session.get(JOB_KEY);
  return (data[JOB_KEY] as JobState | undefined) ?? null;
}

function saveJob(job: JobState): Promise<void> {
  return chrome.storage.session.set({ [JOB_KEY]: job });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A bulk archive is saved in parts of about this size, so the offscreen document
 * never holds an unbounded archive in memory and a lost part costs little.
 */
export const PART_LIMIT_BYTES = 500 * 1024 * 1024;
/** A lost part is started again this many times at most; then the job stops. */
const MAX_RECOVERIES = 3;

/** `Claude - 2026-10-13 15-40.zip` → `Claude - 2026-10-13 15-40 (part 2).zip` */
export function partName(name: string, part: number): string {
  const base = name.replace(/\.zip$/i, '').replace(/ \(part \d+\)$/, '');
  return `${base} (part ${part}).zip`;
}

/**
 * The offscreen document lost the open part. Everything in it goes back into the
 * queue (a project with its chats), its folder names are given back, and the
 * next item starts a new part under the same name.
 */
export function requeueLostPart(job: JobState, current: JobItem | null, archive: ZipArchive): void {
  const members = job.archiveMembers ?? {};
  const lost = new Set([...Object.keys(members), ...(current ? [itemKey(current)] : [])]);
  for (const folders of Object.values(members)) archive.release(folders);
  archive.release(archive.takeReserved());

  const lostProjects = new Set(
    job.items.filter((i) => i.kind === 'project' && lost.has(itemKey(i))).map((i) => i.id),
  );
  // A lost project is exported again with its chats, so its queued chats go.
  job.items = job.items.filter((i) => !(i.projectId && lostProjects.has(i.projectId)));
  for (const id of lostProjects) delete job.projects?.[id];

  for (const item of job.items) {
    if (!lost.has(itemKey(item))) continue;
    item.status = 'pending';
    delete item.message;
    delete item.path;
    delete item.savedFiles;
    delete item.failedFiles;
    delete item.failures;
    // The project's note was in the lost part too, or will be written after this chat.
    const progress = item.projectId ? job.projects?.[item.projectId] : undefined;
    if (progress) progress.written = false;
  }
  job.archiveMembers = {};
  archive.reset();
}

/** A function, not an inline check: TypeScript would keep the status narrowed to 'running'. */
const isSkipped = (item: JobItem) => item.status === 'skipped';

export async function startJob(platform: Platform, items: JobStartItem[]): Promise<void> {
  // A finished job may still be closing its tab; it no longer counts as running.
  if (isJobActive(current?.job) || isJobActive(await loadJob())) {
    throw new CodedError('busy', 'Another bulk export is running');
  }
  if (items.length === 0) throw new Error('No conversations selected');
  const settings = await loadSettings();
  const startedAt = new Date();
  // One project gets an archive named after it; anything else a dated bulk archive.
  const only = items.length === 1 ? items[0] : undefined;
  const archiveName =
    only?.kind === 'project'
      ? `${projectFolderName(only.title, settings, projectLabels(platform).untitled, platform)}.zip`
      : bulkArchiveName(PLATFORM_LABEL[platform], startedAt);
  const job: JobState = {
    id: crypto.randomUUID(),
    platform,
    status: 'running',
    items: items.map((item) => ({ ...item, status: 'pending' })),
    settings,
    startedAt: startedAt.toISOString(),
    tab: {},
    archiveName,
  };
  await saveJob(job);
  void run(job);
}

/** Stops after the conversation being exported now. */
export async function cancelJob(): Promise<void> {
  const job = current?.job ?? (await loadJob());
  if (!isJobActive(job)) return;
  job.status = 'cancelling';
  await saveJob(job);
  // No loop is running (the worker restarted and has not resumed yet): finish here.
  if (!isJobActive(current?.job)) void run(job);
}

/** Called when the service worker starts: goes on with a job a stopped worker left. */
export async function resumeJob(): Promise<void> {
  const job = await loadJob();
  if (!isJobActive(current?.job) && isJobActive(job)) {
    log.info('Resuming bulk export', job.id);
    void run(job);
  }
}

function exportRoot(job: JobState): string[] {
  return sanitizeRelativeDir(exportRootFolder(job.settings));
}

/**
 * Keeps the service worker awake while a job runs. Chrome stops a worker after 30
 * seconds without extension events; a job can wait that long for a slow chat, a
 * large archive being finished or downloaded. An extension API call resets the
 * timer. Stopping the worker mid-job is survivable (the job resumes), but at the
 * archive's close it made the whole part export again (seen 2026-10-15).
 */
function keepAwake(): () => void {
  const timer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => undefined);
  }, 20_000);
  return () => clearInterval(timer);
}

async function run(job: JobState): Promise<void> {
  const release = keepAwake();
  try {
    await runJob(job);
  } finally {
    release();
  }
}

async function runJob(job: JobState): Promise<void> {
  const archive = exportsAsZip(job.settings, { bulk: true, hasFiles: true })
    ? new ZipArchive(
        offscreenFiles,
        zipTarget(job.settings, exportRoot(job)),
        job.archiveName ?? bulkArchiveName(PLATFORM_LABEL[job.platform], new Date(job.startedAt)),
        job.archive,
      )
    : undefined;
  const tab = new WorkerTab(job.platform, job.tab);
  current = { job, archive, tab };
  await setBadge('working');
  let lastLocation: SavedLocation | undefined;
  let projectLocation: SavedLocation | undefined;

  // Normally one pass; another one when the last part was lost while being finished.
  for (;;) {
    try {
      // Items are looked up one at a time: a project adds its chats right after itself.
      const pending = () =>
        job.items.filter((i) => i.status === 'pending' || i.status === 'running');
      for (let item = pending()[0]; item; item = pending()[0]) {
        if (job.status !== 'running') break;
        item.status = 'running';
        await saveJob(job);
        let location: SavedLocation | undefined;
        try {
          location = await exportItem(job, item, tab, archive);
        } catch (error) {
          const recoveries = job.recoveries ?? 0;
          if (!archive || errorCode(error) !== 'archive-lost' || recoveries >= MAX_RECOVERIES) {
            throw error;
          }
          log.warn('The archive part was lost; exporting its chats again', error);
          job.recoveries = recoveries + 1;
          requeueLostPart(job, item, archive);
          job.archive = archive.snapshot();
          await saveJob(job);
          continue;
        }
        if (item.kind === 'project' && location) projectLocation = location;
        lastLocation = location ?? lastLocation;
        if (archive) {
          const folders = archive.takeReserved();
          if (!isSkipped(item))
            job.archiveMembers = { ...job.archiveMembers, [itemKey(item)]: folders };
          // A full part is saved now and the next item starts the next part.
          if (archive.isOpen && archive.size >= PART_LIMIT_BYTES && pending().length > 0) {
            try {
              job.parts = [...(job.parts ?? []), await archive.close()];
              job.archiveMembers = {};
              archive.name = partName(archive.name, job.parts.length + 1);
              job.archiveName = archive.name;
            } catch (error) {
              const recoveries = job.recoveries ?? 0;
              if (errorCode(error) !== 'archive-lost' || recoveries >= MAX_RECOVERIES) throw error;
              job.recoveries = recoveries + 1;
              requeueLostPart(job, null, archive);
            }
          }
          job.archive = archive.snapshot();
        }
        await saveJob(job);
        // A chat read ahead has had its pause already.
        const upcoming = pending()[0];
        if (!isSkipped(item) && upcoming && current?.next?.id !== upcoming.id) {
          await sleep(job.settings.delayBetweenChatsMs);
        }
      }
    } catch (error) {
      job.status = 'stopped';
      const code = errorCode(error);
      job.stopReason = { code, message: describeError(error) };
      log.warn('Bulk export stopped', error);
    }

    if ((await finish(job, archive, tab, lastLocation, projectLocation)) !== 'again') break;
  }
  // A new job may have started while this one was closing.
  if (current?.job === job) current = null;
}

const describeError = errorText;

/** Exports one item; its own problems are recorded, stopping ones thrown. */
async function exportItem(
  job: JobState,
  item: JobItem,
  tab: WorkerTab,
  archive: ZipArchive | undefined,
): Promise<SavedLocation | undefined> {
  if (item.kind === 'project') {
    try {
      const project = await withTab(tab, (tabId) =>
        sendToTab(tabId, 'project:get', { id: item.id }),
      );
      return await exportProject(job, item, project, archive);
    } catch (error) {
      item.status = 'error';
      item.message = describeError(error);
      log.warn('Project failed', item.id, error);
      if (STOP_CODES.has(errorCode(error))) throw error;
      return undefined;
    }
  }
  try {
    return await exportConversationItem(job, item, tab, archive);
  } finally {
    await recordProjectChat(job, item, archive);
  }
}

async function exportConversationItem(
  job: JobState,
  item: JobItem,
  tab: WorkerTab,
  archive: ZipArchive | undefined,
): Promise<SavedLocation | undefined> {
  const { settings } = job;
  const options = projectChatOptions(job, item);
  try {
    const recordId = options?.recordId ?? item.id;
    if (
      settings.skipUnchanged &&
      (await registry.isUnchanged(job.platform, recordId, item.updatedAt))
    ) {
      item.status = 'skipped';
      return undefined;
    }
    const conversation = await (takeReadAhead(item) ?? readConversation(job, item, tab));
    await readAhead(job, item, tab);
    const outcome = await exportConversation(conversation, settings, registry, archive, {
      ...options,
      listUpdatedAt: item.updatedAt,
      refreshLink: (attachment) =>
        withTab(tab, (tabId) =>
          sendToTab(tabId, 'conversation:file-link', {
            conversationId: conversation.id,
            attachmentId: attachment.id,
          }),
        ).then((r) => r.url),
    });
    item.title = conversation.title || item.title;
    // A chat found by search earlier is remembered under its title then; keep it current.
    await refreshFound(job.platform, item.id, { title: conversation.title });
    item.status = outcome.failedFiles ? 'warning' : 'done';
    item.savedFiles = outcome.savedFiles;
    item.failedFiles = outcome.failedFiles;
    if (outcome.failures.length) item.failures = outcome.failures;
    else delete item.failures;
    item.path = outcome.markdownPath;
    return outcome.location;
  } catch (error) {
    // A remembered search result that is gone from the platform is forgotten.
    if (errorCode(error) === 'chat-not-found') await refreshFound(job.platform, item.id, 'gone');
    item.status = 'error';
    item.message = describeError(error);
    log.warn('Conversation failed', item.id, error);
    if (STOP_CODES.has(errorCode(error))) throw error;
    return undefined;
  }
}

function readConversation(job: JobState, item: JobItem, tab: WorkerTab): Promise<Conversation> {
  return withTab(tab, (tabId) =>
    sendToTab(tabId, 'conversation:get', {
      id: item.id,
      options: { artifactVersions: job.settings.artifactVersions },
    }),
  );
}

/** The chat read ahead for `item`, if it was; one read for another item is dropped. */
function takeReadAhead(item: JobItem): Promise<Conversation> | null {
  const next = current?.next;
  if (current) delete current.next;
  return next?.id === item.id ? next.conversation : null;
}

/**
 * Starts reading the chat that comes after `item`, after the usual pause, so it is
 * ready when `item` is written. Not for a project (it adds its chats first) or a
 * chat that "skip unchanged" will skip.
 */
async function readAhead(job: JobState, item: JobItem, tab: WorkerTab): Promise<void> {
  const next = job.items.find((i) => i !== item && i.status === 'pending');
  if (!next || next.kind === 'project' || current?.job !== job) return;
  const recordId = projectChatOptions(job, next)?.recordId ?? next.id;
  if (
    job.settings.skipUnchanged &&
    (await registry.isUnchanged(job.platform, recordId, next.updatedAt))
  ) {
    return;
  }
  if (current?.job !== job) return;
  const conversation = sleep(job.settings.delayBetweenChatsMs).then(() =>
    job.status === 'running'
      ? readConversation(job, next, tab)
      : Promise.reject(new Error('The job ended')),
  );
  // Read when its turn comes; an unused read must not be an unhandled rejection.
  conversation.catch(() => undefined);
  current.next = { id: next.id, conversation };
}

/** Runs a request in the worker tab; if the user closed that tab, retries once in a new one. */
async function withTab<T>(tab: WorkerTab, action: (tabId: number) => Promise<T>): Promise<T> {
  const tabId = await tab.get();
  try {
    return await action(tabId);
  } catch (error) {
    const gone = await chrome.tabs.get(tabId).then(
      () => false,
      () => true,
    );
    if (!gone) throw error;
    return action(await tab.get());
  }
}

async function finish(
  job: JobState,
  archive: ZipArchive | undefined,
  tab: WorkerTab,
  lastLocation: SavedLocation | undefined,
  projectLocation?: SavedLocation,
): Promise<'done' | 'again'> {
  const wasRunning = job.status === 'running';
  if (job.status === 'running') job.status = 'finished';
  if (job.status === 'cancelling') job.status = 'cancelled';
  job.finishedAt = new Date().toISOString();
  const root = exportRoot(job);
  const counts = jobCounts(job);
  const topLevel = job.items.filter((i) => !i.projectId);
  const singleProject = topLevel.length === 1 && topLevel[0]?.kind === 'project';

  try {
    await writePendingProjectNotes(job, archive);
    if (wantsReport(job)) {
      const path = reportPath(new Date(job.finishedAt));
      const text = renderReport(job, PLATFORM_LABEL[job.platform], reportLabels());
      if (archive?.isOpen) await archive.add(path, { kind: 'text', text, mime: 'text/markdown' });
      else if (!archive) await reportSink(job, root).writeText(path, text);
      job.reportPath = path;
    }
    if (archive?.isOpen) {
      if (counts.done + counts.warning > 0 || job.reportPath) job.location = await archive.close();
      else await archive.discard();
      delete job.archive;
    } else if (singleProject && projectLocation) {
      // A single project: point at its note, not at the export root.
      job.location = projectLocation;
    } else if (lastLocation) {
      job.location =
        lastLocation.kind === 'folder'
          ? { kind: 'folder', folder: lastLocation.folder, path: root.join('/') }
          : { kind: 'downloads', path: root.join('/') };
    }
  } catch (error) {
    const recoveries = job.recoveries ?? 0;
    if (
      archive &&
      wasRunning &&
      errorCode(error) === 'archive-lost' &&
      recoveries < MAX_RECOVERIES
    ) {
      log.warn('The last archive part was lost; exporting its chats again', error);
      job.recoveries = recoveries + 1;
      requeueLostPart(job, null, archive);
      job.archive = archive.snapshot();
      job.status = 'running';
      delete job.finishedAt;
      delete job.reportPath;
      await saveJob(job);
      return 'again';
    }
    log.warn('Could not finish the bulk export', error);
    await archive?.discard().catch(() => undefined);
    job.status = 'stopped';
    job.stopReason = { code: errorCode(error), message: describeError(error) };
  }

  await saveJob(job);
  await tab.release();
  await setBadge(
    job.status === 'stopped' ? 'failed' : counts.error || counts.warning ? 'partial' : 'done',
  );
  await notifyFinished(job);
  return 'done';
}

function reportSink(job: JobState, root: string[]) {
  if (job.settings.destination === 'folder') return new FolderSink(offscreenFiles, true);
  return new DownloadsSink(
    { download: (request) => downloadAndWait(request), createBlobUrl, revokeBlobUrl },
    { root, conflictAction: 'uniquify' },
  );
}

/** The mark on every tab's icon: a bulk export's result stays 8 s. */
function setBadge(state: BadgeState): Promise<void> {
  return setIconBadge(state, { clearAfterMs: 8000 });
}

async function notifyFinished(job: JobState): Promise<void> {
  if (!job.settings.showNotifications) return;
  const c = jobCounts(job);
  const message =
    job.status === 'stopped' && job.stopReason
      ? t('jobNotifyStopped', job.stopReason.message)
      : t('jobNotifyDone', [
          String(c.done + c.warning),
          String(c.warning),
          String(c.error),
          String(c.skipped),
        ]);
  await chrome.notifications
    .create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: t('extName'),
      message,
    })
    .catch(() => undefined);
}
