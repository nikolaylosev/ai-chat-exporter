import type { ProjectNote } from '../background/project-export';
import type { ErrorCode } from './errors';
import type { FileFailure, SavedLocation } from './messages';
import type { Platform } from './platform';
import type { Settings } from './settings';

/**
 * State of a bulk export, kept in chrome.storage.session under JOB_KEY. The
 * service worker writes it after every conversation, so a restarted worker
 * resumes the job, and the export page follows it through storage.onChanged.
 */
export const JOB_KEY = 'job';

export type JobItemStatus = 'pending' | 'running' | 'done' | 'warning' | 'error' | 'skipped';

export interface JobItem {
  /** A conversation (the default) or a Claude Project. */
  kind?: 'conversation' | 'project';
  id: string;
  title: string;
  /** A project item: export its chats too, into the project's `chats/`. */
  withChats?: boolean;
  /** A chat exported as part of this project (the project's id). */
  projectId?: string;
  updatedAt: string | null;
  status: JobItemStatus;
  savedFiles?: number;
  failedFiles?: number;
  /** Names of the files that were not saved, with the reason (at most MAX_LISTED_FAILURES). */
  failures?: FileFailure[];
  /** Why the conversation failed, in the UI language. */
  message?: string;
  /** The Markdown file relative to the export root (or inside the archive). */
  path?: string;
}

/**
 * running → finished, or cancelling → cancelled when the user cancels, or
 * stopped when something makes going on pointless (signed out, no folder access).
 */
export type JobStatus = 'running' | 'cancelling' | 'finished' | 'cancelled' | 'stopped';

export interface JobState {
  id: string;
  platform: Platform;
  status: JobStatus;
  items: JobItem[];
  /** Settings when the job started; a resumed job keeps them. */
  settings: Settings;
  startedAt: string;
  finishedAt?: string;
  /** Where the export went: the archive, or the export root. */
  location?: SavedLocation;
  /** The report, relative to the export root or inside the archive. */
  reportPath?: string;
  stopReason?: { code: ErrorCode; message: string };
  tab: { tabId?: number; createdTabId?: number };
  archive?: { zipId: string | null; name: string; folders: string[] };
  /** The archive's file name, chosen when the job starts. */
  archiveName?: string;
  /** Earlier parts of a split archive, already saved. */
  parts?: SavedLocation[];
  /** Items in the open part and the folders they took there, by itemKey(). */
  archiveMembers?: Record<string, string[]>;
  /** How many times a lost archive part was started again. */
  recoveries?: number;
  /** Projects whose note is still to be written, by project id. */
  projects?: Record<string, ProjectProgress>;
}

/** A project between its knowledge files and its last chat. */
export interface ProjectProgress {
  note: ProjectNote;
  root: string[];
  folderPath: string;
  markdownPath: string;
  /** Folders (relative to the export root) where its chats go. */
  chatParents: string[];
  written: boolean;
}

export interface JobCounts {
  total: number;
  done: number;
  warning: number;
  error: number;
  skipped: number;
  pending: number;
}

export function jobCounts(job: Pick<JobState, 'items'>): JobCounts {
  const counts: JobCounts = { total: 0, done: 0, warning: 0, error: 0, skipped: 0, pending: 0 };
  for (const item of job.items) {
    counts.total++;
    if (item.status === 'pending' || item.status === 'running') counts.pending++;
    else counts[item.status]++;
  }
  return counts;
}

/** Identifies an item: the same chat can be in a job on its own and inside a project. */
export function itemKey(item: Pick<JobItem, 'id' | 'projectId'>): string {
  return `${item.projectId ?? ''}/${item.id}`;
}

export function isJobActive(job: JobState | null | undefined): job is JobState {
  return job?.status === 'running' || job?.status === 'cancelling';
}
