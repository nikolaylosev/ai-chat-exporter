import type { Platform } from '../shared/platform';
import { titleFromFolder } from '../util/filename';

/**
 * The extension cannot read the Downloads folder, so it remembers what it has
 * exported (docs/ARCHITECTURE.md, "Export registry"): one record per conversation and
 * every folder name it has issued in Downloads. Kept in chrome.storage.local.
 */

/** Where the recorded folder lives. A ZIP export keeps no folder to overwrite. */
export type RecordDestination = 'downloads' | 'folder' | 'zip';

export interface ExportRecord {
  /** The conversation's `updatedAt` when it was exported. */
  updatedAt: string | null;
  exportedAt: string;
  destination: RecordDestination;
  /** Conversation folder relative to the export root. */
  folder: string;
  /** Files that failed to download in that export; the chat is then not "unchanged". */
  missingFiles?: number;
  /** Files written (paths from the export root), so the next overwrite can drop stale ones. */
  files?: string[];
}

export interface RegistryData {
  records: Record<string, ExportRecord>;
  /** Folder paths relative to Downloads, lower-cased: file systems may ignore case. */
  issued: string[];
}

export interface RegistryStore {
  load(): Promise<unknown>;
  save(data: RegistryData): Promise<void>;
}

const STORAGE_KEY = 'registry';

export const chromeRegistryStore: RegistryStore = {
  load: async () => (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY],
  save: (data) => chrome.storage.local.set({ [STORAGE_KEY]: data }),
};

function isRecord(value: unknown): value is ExportRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    (typeof r.updatedAt === 'string' || r.updatedAt === null) &&
    typeof r.exportedAt === 'string' &&
    (r.destination === 'downloads' || r.destination === 'folder' || r.destination === 'zip') &&
    typeof r.folder === 'string'
  );
}

/** Drops anything malformed, so old or damaged stored data never breaks an export. */
export function normalizeRegistry(stored: unknown): RegistryData {
  const data: RegistryData = { records: {}, issued: [] };
  if (typeof stored !== 'object' || stored === null) return data;
  const { records, issued } = stored as Record<string, unknown>;
  if (typeof records === 'object' && records !== null) {
    for (const [key, value] of Object.entries(records)) {
      if (isRecord(value)) data.records[key] = value;
    }
  }
  if (Array.isArray(issued)) {
    data.issued = issued.filter((p): p is string => typeof p === 'string');
  }
  return data;
}

const recordKey = (platform: Platform, id: string) => `${platform}:${id}`;

export class Registry {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: RegistryStore = chromeRegistryStore) {}

  /** Runs read-modify-write steps one at a time: a bulk job and a shortcut export may overlap. */
  private mutate<T>(change: (data: RegistryData) => T): Promise<T> {
    const next = this.queue.then(async () => {
      const data = normalizeRegistry(await this.store.load());
      const result = change(data);
      await this.store.save(data);
      return result;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<RegistryData> {
    await this.queue;
    return normalizeRegistry(await this.store.load());
  }

  async record(platform: Platform, id: string): Promise<ExportRecord | undefined> {
    return (await this.read()).records[recordKey(platform, id)];
  }

  /**
   * The conversation was exported before, completely, and has not changed since.
   * An export that missed files does not count: the next one may get them.
   */
  async isUnchanged(platform: Platform, id: string, updatedAt: string | null): Promise<boolean> {
    const record = await this.record(platform, id);
    return Boolean(record && updatedAt && record.updatedAt === updatedAt && !record.missingFiles);
  }

  /**
   * Picks the first folder path (relative to Downloads) that the extension has not
   * issued yet: `Chat`, then `Chat (2)`, `Chat (3)`, and marks it as issued. With
   * `reuse`, the path is marked and returned as it is.
   */
  reserveFolder(path: string, reuse = false): Promise<string> {
    return this.mutate((data) => {
      const issued = new Set(data.issued);
      let candidate = path;
      for (let n = 2; !reuse && issued.has(candidate.toLowerCase()); n++) {
        candidate = `${path} (${n})`;
      }
      if (!issued.has(candidate.toLowerCase())) data.issued.push(candidate.toLowerCase());
      return candidate;
    });
  }

  remember(platform: Platform, id: string, record: ExportRecord): Promise<void> {
    return this.mutate((data) => {
      data.records[recordKey(platform, id)] = record;
    });
  }

  /**
   * The platform's chats exported before, saved alone or in a project (`<chat>@<project>`),
   * the latest export of each, with the title its folder was named after.
   */
  async chats(
    platform: Platform,
  ): Promise<{ id: string; title: string; updatedAt: string | null }[]> {
    const latest = new Map<string, ExportRecord>();
    for (const [key, record] of Object.entries((await this.read()).records)) {
      if (!key.startsWith(`${platform}:`)) continue;
      const id = key.slice(platform.length + 1).split('@')[0] ?? '';
      if (!id || id.startsWith('project:')) continue;
      const before = latest.get(id);
      if (!before || before.exportedAt < record.exportedAt) latest.set(id, record);
    }
    return [...latest].map(([id, r]) => ({
      id,
      title: titleFromFolder(r.folder),
      updatedAt: r.updatedAt,
    }));
  }

  async size(): Promise<number> {
    return Object.keys((await this.read()).records).length;
  }

  clear(): Promise<void> {
    return this.mutate((data) => {
      data.records = {};
      data.issued = [];
    });
  }
}

/** The registry the service worker uses. */
export const registry = new Registry();
