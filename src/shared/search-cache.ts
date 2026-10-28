import type { SweepState } from '../adapters/gemini/search';
import type { ConversationSummary } from '../model/conversation';
import type { Platform } from './platform';

/**
 * Chats found through a platform's search (Gemini), and those added from Google
 * Takeout, remembered between visits to the export page: the search takes
 * minutes, and a reload would lose them.
 * Kept in chrome.storage.local, on this computer only. The export page adds to
 * it; the bulk export forgets chats that are gone and renews titles.
 */

/** Enough for any account seen so far; the oldest go first past it. */
const MAX_FOUND = 5000;

const key = (platform: Platform) => `searchFound:${platform}`;
/** Where the last search stopped, so the next one goes on from there. */
const stateKey = (platform: Platform) => `searchState:${platform}`;

function isSummary(value: unknown): value is ConversationSummary {
  const c = value as Partial<ConversationSummary> | null;
  return typeof c?.id === 'string' && typeof c.title === 'string' && typeof c.url === 'string';
}

/** `previous` with `more` added; a chat found again replaces its older entry. */
export function mergeFound(
  previous: readonly ConversationSummary[],
  more: readonly ConversationSummary[],
): ConversationSummary[] {
  const byId = new Map(previous.map((c) => [c.id, c]));
  for (const c of more) {
    byId.delete(c.id);
    byId.set(c.id, c);
  }
  return [...byId.values()].slice(-MAX_FOUND);
}

export async function loadFound(platform: Platform): Promise<ConversationSummary[]> {
  try {
    const stored: unknown = (await chrome.storage.local.get(key(platform)))[key(platform)];
    return Array.isArray(stored) ? stored.filter(isSummary) : [];
  } catch {
    return [];
  }
}

let writes: Promise<void> = Promise.resolve();

/** Adds chats to the remembered ones; writes run one after another. */
export function rememberFound(platform: Platform, more: ConversationSummary[]): Promise<void> {
  if (!more.length) return writes;
  writes = writes
    .then(async () => {
      const merged = mergeFound(await loadFound(platform), more);
      await chrome.storage.local.set({ [key(platform)]: merged });
    })
    .catch(() => undefined);
  return writes;
}

/** Forgets the chats found and where the search stopped: the next search starts over. */
export function forgetFound(platform: Platform): Promise<void> {
  writes = writes
    .then(() => chrome.storage.local.remove([key(platform), stateKey(platform)]))
    .catch(() => undefined);
  return writes;
}

function isState(value: unknown): value is SweepState {
  const s = value as Partial<SweepState> | null;
  return Array.isArray(s?.asked) && Array.isArray(s.words) && Array.isArray(s.seen);
}

export async function loadSearchState(platform: Platform): Promise<SweepState | null> {
  try {
    const stored: unknown = (await chrome.storage.local.get(stateKey(platform)))[
      stateKey(platform)
    ];
    return isState(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function saveSearchState(platform: Platform, state: SweepState): Promise<void> {
  writes = writes
    .then(() => chrome.storage.local.set({ [stateKey(platform)]: state }))
    .catch(() => undefined);
  return writes;
}

/**
 * After an export: a chat that is gone from the platform is forgotten, and one
 * that was saved gets the title it has now. Chats not remembered are left alone.
 */
export function refreshFound(
  platform: Platform,
  id: string,
  now: { title: string } | 'gone',
): Promise<void> {
  writes = writes
    .then(async () => {
      const found = await loadFound(platform);
      const at = found.findIndex((c) => c.id === id);
      const entry = found[at];
      if (!entry) return;
      if (now === 'gone') found.splice(at, 1);
      else if (now.title && now.title !== entry.title) found[at] = { ...entry, title: now.title };
      else return;
      await chrome.storage.local.set({ [key(platform)]: found });
    })
    .catch(() => undefined);
  return writes;
}

/** The storage key, for pages that follow changes. */
export const foundKey = key;
