import type { ConversationList, ConversationSummary } from '../model/conversation';
import type { Platform } from './platform';

/**
 * A platform's chat list as last read, remembered between visits to the export
 * page (Gemini): reading its whole list takes minutes, so the next visit reads
 * only down to chats it has unchanged, and chats that fell past the depth Gemini
 * answers stay listed. Kept in chrome.storage.local, on this computer only. The
 * bulk export forgets chats that are gone and renews titles.
 */

export interface CachedList {
  conversations: ConversationSummary[];
  /** The list as read ended early: older chats may be missing. */
  incomplete?: boolean;
  /** Chats the platform no longer has (the bulk export found out): not shown again. */
  gone?: string[];
}

/** Enough for any account seen so far. */
const MAX_LISTED = 10000;
const MAX_GONE = 2000;

const key = (platform: Platform) => `listed:${platform}`;

function isSummary(value: unknown): value is ConversationSummary {
  const c = value as Partial<ConversationSummary> | null;
  return typeof c?.id === 'string' && typeof c.title === 'string' && typeof c.url === 'string';
}

export async function loadList(platform: Platform): Promise<CachedList | null> {
  try {
    const stored = (await chrome.storage.local.get(key(platform)))[key(platform)] as
      Partial<CachedList> | undefined;
    if (!stored || !Array.isArray(stored.conversations)) return null;
    return {
      conversations: stored.conversations.filter(isSummary),
      ...(stored.incomplete ? { incomplete: true } : {}),
      ...(Array.isArray(stored.gone)
        ? { gone: stored.gone.filter((id) => typeof id === 'string') }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The list now: what was read, then the remembered chats it did not reach. A
 * whole list read to its end replaces the memory, so chats deleted since go.
 */
export function mergeList(read: ConversationList, cached: CachedList | null): CachedList {
  const whole = !read.reachedKnown && !read.incomplete;
  const gone = new Set(cached?.gone);
  const fresh = read.conversations.filter((c) => !gone.has(c.id));
  if (whole || !cached) {
    return {
      conversations: fresh,
      ...(read.incomplete ? { incomplete: true } : {}),
      ...(cached?.gone?.length ? { gone: cached.gone } : {}),
    };
  }
  const seen = new Set(fresh.map((c) => c.id));
  const incomplete =
    read.reachedKnown || read.incomplete?.stopped ? cached.incomplete : Boolean(read.incomplete);
  return {
    conversations: [...fresh, ...cached.conversations.filter((c) => !seen.has(c.id))].slice(
      0,
      MAX_LISTED,
    ),
    ...(incomplete ? { incomplete: true } : {}),
    ...(cached.gone?.length ? { gone: cached.gone } : {}),
  };
}

let writes: Promise<void> = Promise.resolve();

function change(platform: Platform, update: (list: CachedList) => CachedList | null) {
  writes = writes
    .then(async () => {
      const list = await loadList(platform);
      if (!list) return;
      const next = update(list);
      if (next) await chrome.storage.local.set({ [key(platform)]: next });
    })
    .catch(() => undefined);
  return writes;
}

export function saveList(platform: Platform, list: CachedList): Promise<void> {
  writes = writes
    .then(() => chrome.storage.local.set({ [key(platform)]: list }))
    .catch(() => undefined);
  return writes;
}

export function forgetList(platform: Platform): Promise<void> {
  writes = writes.then(() => chrome.storage.local.remove(key(platform))).catch(() => undefined);
  return writes;
}

/**
 * After an export: a chat that is gone from the platform is dropped and not
 * shown again (it may be known from the registry too), and one that was saved
 * gets the title it has now.
 */
export function refreshListed(
  platform: Platform,
  id: string,
  now: { title: string } | 'gone',
): Promise<void> {
  return change(platform, (list) => {
    const at = list.conversations.findIndex((c) => c.id === id);
    const entry = list.conversations[at];
    if (now === 'gone') {
      if (list.gone?.includes(id)) return null;
      return {
        ...list,
        conversations: list.conversations.filter((c) => c.id !== id),
        gone: [...(list.gone ?? []), id].slice(-MAX_GONE),
      };
    }
    if (!entry || !now.title || now.title === entry.title) return null;
    const conversations = [...list.conversations];
    conversations[at] = { ...entry, title: now.title };
    return { ...list, conversations };
  });
}

/** The storage key, for pages that follow changes. */
export const listKey = key;

const takeoutKey = (platform: Platform) => `takeoutUntil:${platform}`;

/**
 * The time of the newest record of a Google Takeout file added (Gemini): chats
 * last updated before it came from Takeout, so reading the whole list again
 * can stop there.
 */
export async function loadTakeoutUntil(platform: Platform): Promise<string | null> {
  try {
    const stored: unknown = (await chrome.storage.local.get(takeoutKey(platform)))[
      takeoutKey(platform)
    ];
    return typeof stored === 'string' ? stored : null;
  } catch {
    return null;
  }
}

/** Keeps the newest of the Takeout files added. */
export function rememberTakeoutUntil(platform: Platform, time: string): Promise<void> {
  writes = writes
    .then(async () => {
      const before = await loadTakeoutUntil(platform);
      if (!before || time > before)
        await chrome.storage.local.set({ [takeoutKey(platform)]: time });
    })
    .catch(() => undefined);
  return writes;
}
