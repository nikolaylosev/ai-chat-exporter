import type { ProjectSummary } from '../../model/project';
import type { ConversationSummary } from '../../model/conversation';

export type SortKey = 'title' | 'createdAt' | 'updatedAt' | 'project';

/** A chat against the export registry: never saved, saved as it is now, or changed since. */
export type SavedStatus = 'new' | 'saved' | 'changed';

/**
 * Where a chat in the table came from (Gemini): its list, its search, Google
 * Takeout, or only the registry of chats saved before.
 */
export type ChatSource = 'list' | 'search' | 'takeout' | 'saved';

export function chatSource(c: ConversationSummary): ChatSource {
  if (c.fromTakeout) return 'takeout';
  if (c.foundBySearch) return 'search';
  if (c.savedBefore) return 'saved';
  return 'list';
}

/** The projects (Gems) of a list with how many chats each has, by name; '' for none. */
export function projectCounts(list: readonly ConversationSummary[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const c of list) counts.set(c.project ?? '', (counts.get(c.project ?? '') ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
}

/** What the registry holds for a chat: its latest export (`registry:chats`). */
export interface SavedRecord {
  updatedAt: string | null;
  missingFiles?: number;
}

export interface ListFilter {
  query: string;
  /** YYYY-MM-DD, inclusive; empty for no limit. Compared with the creation date, or the last update where there is none. */
  from: string;
  to: string;
  status: 'all' | SavedStatus;
  source: 'all' | ChatSource;
  /** A project (Gem on Gemini) by name, '' for chats without one, null for any. */
  project: string | null;
  sort: SortKey;
  descending: boolean;
}

export const DEFAULT_FILTER: ListFilter = {
  query: '',
  from: '',
  to: '',
  status: 'all',
  source: 'all',
  project: null,
  sort: 'updatedAt',
  descending: true,
};

/**
 * As "skip unchanged chats" decides: saved when the latest export has the
 * chat's update time and every file; an export that missed files, or an older
 * version, counts as changed.
 */
export function savedStatus(c: ConversationSummary, record: SavedRecord | undefined): SavedStatus {
  if (!record) return 'new';
  return c.updatedAt && record.updatedAt === c.updatedAt && !record.missingFiles
    ? 'saved'
    : 'changed';
}

/** Local calendar date of an ISO timestamp, to compare with date inputs. */
function day(iso: string | null, timeZone?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('sv-SE', timeZone ? { timeZone } : {});
}

/** Conversations matching the search, date range, saved status, source and project, sorted. */
export function filterConversations(
  list: readonly ConversationSummary[],
  filter: ListFilter,
  timeZone?: string,
  saved: ReadonlyMap<string, SavedRecord> = new Map(),
): ConversationSummary[] {
  const words = filter.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = list.filter((c) => {
    const text = `${c.title} ${c.project ?? ''}`.toLocaleLowerCase();
    if (!words.every((w) => text.includes(w))) return false;
    // A platform without creation dates in its list (Gemini) is filtered by the last update.
    const created = day(c.createdAt ?? c.updatedAt, timeZone);
    if (filter.from && (!created || created < filter.from)) return false;
    if (filter.to && (!created || created > filter.to)) return false;
    if (filter.status !== 'all' && savedStatus(c, saved.get(c.id)) !== filter.status) return false;
    if (filter.source !== 'all' && chatSource(c) !== filter.source) return false;
    if (filter.project !== null && (c.project ?? '') !== filter.project) return false;
    return true;
  });
  const value = (c: ConversationSummary) =>
    filter.sort === 'title'
      ? c.title
      : filter.sort === 'project'
        ? (c.project ?? '')
        : (c[filter.sort] ?? '');
  const direction = filter.descending ? -1 : 1;
  return [...matches].sort((a, b) => value(a).localeCompare(value(b)) * direction);
}

export type ProjectSortKey = 'name' | 'updatedAt' | 'knowledgeCount';

export interface ProjectFilter {
  query: string;
  sort: ProjectSortKey;
  descending: boolean;
}

export const DEFAULT_PROJECT_FILTER: ProjectFilter = {
  query: '',
  sort: 'updatedAt',
  descending: true,
};

/** Projects matching the search (name and description), sorted. */
export function filterProjects(
  list: readonly ProjectSummary[],
  filter: ProjectFilter,
): ProjectSummary[] {
  const words = filter.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = list.filter((p) => {
    const text = `${p.name} ${p.description}`.toLocaleLowerCase();
    return words.every((w) => text.includes(w));
  });
  const direction = filter.descending ? -1 : 1;
  return [...matches].sort((a, b) => {
    if (filter.sort === 'knowledgeCount') {
      return ((a.knowledgeCount ?? -1) - (b.knowledgeCount ?? -1)) * direction;
    }
    const x = filter.sort === 'name' ? a.name : (a.updatedAt ?? '');
    const y = filter.sort === 'name' ? b.name : (b.updatedAt ?? '');
    return x.localeCompare(y) * direction;
  });
}
