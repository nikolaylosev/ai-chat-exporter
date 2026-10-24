import type { Project } from '../model/project';
import type { Platform } from '../shared/platform';
import { t } from '../shared/i18n';
import type { JobItem, JobState, ProjectProgress } from '../shared/job';
import { log } from '../shared/logger';
import { MAX_LISTED_FAILURES, type FileFailure, type SavedLocation } from '../shared/messages';
import type { ZipArchive } from '../sinks/offscreen-sinks';
import { recordDestination, sinkFactory, type ExportOptions } from './export-conversation';
import { describeFailure } from './labels';
import {
  chatParents,
  moveProject,
  planProjectExport,
  renderProjectMarkdown,
  type ProjectLabels,
  type ProjectNote,
} from './project-export';
import { registry } from './registry';
import { rethrowIfFatal } from './write-conversation';
import { FILE_CONCURRENCY, forEachLimit } from '../util/pool';

/**
 * A Claude Project or a Gemini notebook in a bulk job: its files first, then
 * (with chats) its chats as items of their own, then the note, which links to
 * them. The note waits in the job state until the last chat is done.
 */

export function projectLabels(platform: Platform = 'claude'): ProjectLabels {
  const notebook = platform === 'gemini';
  return {
    untitled: t(notebook ? 'untitledNotebook' : 'untitledProject'),
    untitledChat: t('untitledChat'),
    description: t('mdProjectDescription'),
    instructions: t('mdProjectInstructions'),
    knowledge: t(notebook ? 'mdNotebookSources' : 'mdProjectKnowledge'),
    chats: t('mdProjectChats'),
    noKnowledge: t(notebook ? 'mdNotebookNoSources' : 'mdProjectNoKnowledge'),
    noChats: t('mdProjectNoChats'),
    fileFailed: (reason) => t('mdAttachmentFailed', reason),
    chatFailed: (reason) => t('mdProjectChatFailed', reason),
    // The same notebook opens in NotebookLM, which keeps its sources.
    ...(notebook
      ? {
          filesElsewhere: (note: ProjectNote) =>
            t('mdNotebookSourcesElsewhere', `https://notebooklm.google.com/notebook/${note.id}`),
        }
      : {}),
  };
}

const projectRecordId = (projectId: string) => `project:${projectId}`;

/** Exports a project's knowledge base and queues its chats. Returns where the note goes. */
export async function exportProject(
  job: JobState,
  item: JobItem,
  project: Project,
  archive: ZipArchive | undefined,
): Promise<SavedLocation> {
  const { settings } = job;
  const labels = projectLabels(project.platform);
  let plan = planProjectExport(project, settings, labels.untitled);

  // A project goes through a bulk job: an archive into Downloads, files into a chosen folder.
  const destination = archive ? 'zip' : recordDestination(settings, false);
  const previous = await registry.record(project.platform, projectRecordId(project.id));
  if (
    settings.onFolderExists === 'overwrite' &&
    destination !== 'zip' &&
    previous?.destination === destination
  ) {
    plan = moveProject(plan, previous.folder);
  }
  const sink = sinkFactory(settings, registry, archive)(plan.root);
  if (sink.prepareFolder) plan = moveProject(plan, await sink.prepareFolder(plan.folderPath));

  const note: ProjectNote = {
    platform: project.platform,
    id: project.id,
    name: project.name,
    description: project.description,
    instructions: project.instructions,
    url: project.url,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    knowledge: [],
    chats: project.conversations.map((c) => ({ id: c.id, title: c.title, url: c.url })),
  };
  // A few files at a time; the note lists them in the project's order.
  const knowledge: ProjectNote['knowledge'] = [];
  await forEachLimit(
    plan.knowledge,
    sink.fileConcurrency ?? FILE_CONCURRENCY,
    async (file, index) => {
      const name = file.link.slice(file.link.lastIndexOf('/') + 1);
      // A file the platform keeps without a download (a Gemini notebook's source) is listed only.
      if (!file.attachment.source && file.attachment.note === 'unavailable') {
        knowledge[index] = {
          name,
          info: file.attachment.unavailableReason ?? t('mdFileNotGiven'),
        };
        return;
      }
      // "Save with files" is off: the project's files are listed, as a chat's are.
      if (!settings.saveAttachments) {
        knowledge[index] = { name, info: t('mdFileSkipped') };
        return;
      }
      try {
        if (!file.attachment.source) throw new Error('unavailable');
        await sink.writeFile(file.path, file.attachment.source);
        rethrowIfFatal(null, sink);
        knowledge[index] = { name, link: file.link };
      } catch (error) {
        rethrowIfFatal(error, sink);
        const reason = describeFailure(error);
        knowledge[index] = { name, error: reason };
        log.info('File not saved', project.name, name, reason);
      }
    },
  );
  note.knowledge = knowledge;
  const notSaved = knowledge.filter((k) => k.error !== undefined);
  const failed = notSaved.length;
  const failures: FileFailure[] = notSaved
    .slice(0, MAX_LISTED_FAILURES)
    .map((k) => ({ name: k.name, reason: k.error ?? '' }));

  const progress: ProjectProgress = {
    note,
    root: plan.root,
    folderPath: plan.folderPath,
    markdownPath: plan.markdownPath,
    chatParents: chatParents(plan),
    written: false,
  };
  job.projects = { ...job.projects, [project.id]: progress };
  await registry.remember(project.platform, projectRecordId(project.id), {
    updatedAt: project.updatedAt,
    exportedAt: new Date().toISOString(),
    destination,
    folder: plan.folderPath,
  });

  item.title = project.name || item.title;
  item.path = plan.markdownPath;
  item.savedFiles = note.knowledge.filter((k) => k.link).length;
  item.failedFiles = failed;
  if (failures.length) item.failures = failures;
  item.status = failed ? 'warning' : 'done';

  const chats = item.withChats ? project.conversations : [];
  if (chats.length) {
    const at = job.items.indexOf(item) + 1;
    job.items.splice(
      at,
      0,
      ...chats.map((c) => ({
        kind: 'conversation' as const,
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        projectId: project.id,
        status: 'pending' as const,
      })),
    );
  } else {
    await writeProjectNote(job, project.id, archive);
  }
  return sink.finish(plan.markdownPath);
}

/** Where a project's chat goes and under which registry key. */
export function projectChatOptions(job: JobState, item: JobItem): ExportOptions | undefined {
  const progress = item.projectId ? job.projects?.[item.projectId] : undefined;
  if (!progress) return undefined;
  return { parents: progress.chatParents, recordId: `${item.id}@${item.projectId}` };
}

/** After one of a project's chats: note its link or error; write the note after the last one. */
export async function recordProjectChat(
  job: JobState,
  item: JobItem,
  archive: ZipArchive | undefined,
): Promise<void> {
  const progress = item.projectId ? job.projects?.[item.projectId] : undefined;
  if (!progress || !item.projectId) return;
  const chat = progress.note.chats.find((c) => c.id === item.id);
  if (chat) {
    if (item.path) chat.link = item.path.slice(progress.folderPath.length + 1);
    if (item.status === 'error' && item.message) chat.error = item.message;
  }
  const waiting = job.items.some(
    (i) => i.projectId === item.projectId && (i.status === 'pending' || i.status === 'running'),
  );
  if (!waiting) await writeProjectNote(job, item.projectId, archive);
}

/**
 * Writes the note of every project still waiting for it, e.g. after a cancel:
 * chats that were not reached keep their claude.ai links.
 */
export async function writePendingProjectNotes(
  job: JobState,
  archive: ZipArchive | undefined,
): Promise<void> {
  for (const [id, progress] of Object.entries(job.projects ?? {})) {
    if (!progress.written) await writeProjectNote(job, id, archive);
  }
}

async function writeProjectNote(
  job: JobState,
  projectId: string,
  archive: ZipArchive | undefined,
): Promise<void> {
  const progress = job.projects?.[projectId];
  if (!progress || progress.written) return;
  const text = renderProjectMarkdown(
    progress.note,
    projectLabels(progress.note.platform),
    new Date(),
  );
  const sink = sinkFactory(job.settings, registry, archive)(progress.root);
  await sink.writeText(progress.markdownPath, text);
  progress.written = true;
}
