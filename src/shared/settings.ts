export type NoteFormat = 'markdown' | 'html' | 'json';

/** The note's file extension for each format. */
export const NOTE_EXTENSION: Record<NoteFormat, string> = {
  markdown: 'md',
  html: 'html',
  json: 'json',
};

export interface Settings {
  /** downloads: through chrome.downloads; folder: into the folder the user picked (File System Access). */
  destination: 'downloads' | 'folder';
  /** One ZIP archive per export instead of separate files. */
  saveAsZip: boolean;
  /** Subfolder inside Downloads. Empty string means the Downloads root. Not used for `folder`. */
  rootFolder: string;
  includePlatformInFolderName: boolean;
  /** The note: Markdown, an HTML page (opens anywhere, prints to PDF) or JSON. */
  noteFormat: NoteFormat;
  saveAttachments: boolean;
  saveThinking: boolean;
  saveToolCalls: boolean;
  /** compact: one line per tool call; full: with input and output. */
  toolCallDetail: 'compact' | 'full';
  claudeBranches: 'active' | 'all';
  artifactVersions: 'latest' | 'all';
  onFolderExists: 'copy' | 'overwrite';
  skipUnchanged: boolean;
  delayBetweenChatsMs: number;
  writeReport: 'never' | 'on-errors' | 'always';
  showNotifications: boolean;
  /** A save button in the corner of chat pages. */
  showPageButton: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  destination: 'downloads',
  saveAsZip: false,
  rootFolder: 'AI Chats',
  includePlatformInFolderName: true,
  noteFormat: 'markdown',
  saveAttachments: true,
  saveThinking: false,
  saveToolCalls: true,
  toolCallDetail: 'compact',
  claudeBranches: 'active',
  artifactVersions: 'latest',
  onFolderExists: 'copy',
  skipUnchanged: false,
  delayBetweenChatsMs: 800,
  writeReport: 'on-errors',
  showNotifications: true,
  showPageButton: true,
};

const STORAGE_KEY = 'settings';

const ALLOWED_VALUES: Partial<Record<keyof Settings, readonly unknown[]>> = {
  destination: ['downloads', 'folder'],
  noteFormat: ['markdown', 'html', 'json'],
  toolCallDetail: ['compact', 'full'],
  claudeBranches: ['active', 'all'],
  artifactVersions: ['latest', 'all'],
  onFolderExists: ['copy', 'overwrite'],
  writeReport: ['never', 'on-errors', 'always'],
};

function isValid(key: keyof Settings, value: unknown): boolean {
  if (typeof value !== typeof DEFAULT_SETTINGS[key]) return false;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0;
  const allowed = ALLOWED_VALUES[key];
  return allowed ? allowed.includes(value) : true;
}

/** Fills in defaults for missing or invalid fields, so old stored data never breaks the code. */
export function normalizeSettings(stored: unknown): Settings {
  const result: Settings = { ...DEFAULT_SETTINGS };
  if (typeof stored !== 'object' || stored === null) return result;
  const record = stored as Record<string, unknown>;
  const target = result as unknown as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (isValid(key, record[key])) target[key] = record[key];
  }
  return result;
}

export async function loadSettings(): Promise<Settings> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeSettings(data[STORAGE_KEY]);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = normalizeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

/** Export root relative to the destination: the chosen folder is the root itself. */
export function exportRootFolder(settings: Settings): string {
  return settings.destination === 'folder' ? '' : settings.rootFolder;
}
