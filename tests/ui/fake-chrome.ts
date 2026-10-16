import { vi } from 'vitest';

type Handler = (type: string, payload: unknown, tabId?: number) => unknown;
type Listener = (message: unknown, sender: unknown, reply: (r: unknown) => void) => unknown;
type StorageListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  area: string,
) => void;

/**
 * Just enough of the extension APIs for the extension pages: messages to the
 * worker and to tabs go to the given handlers (as `send`/`sendToTab` expect),
 * storage is in memory and reports changes, and `t()` returns the key with its
 * substitutions, `key(a,b)`, so tests can look for it.
 */
export function stubChrome({
  background = () => null,
  tab = () => null,
  activeTab,
}: { background?: Handler; tab?: Handler; activeTab?: { id: number; url: string } } = {}) {
  const listeners = new Set<Listener>();
  const storageListeners = new Set<StorageListener>();
  const area = (name: string) => {
    const data: Record<string, unknown> = {};
    const notify = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) =>
      storageListeners.forEach((l) => l(changes, name));
    return {
      data,
      get: (key?: string | null) =>
        Promise.resolve(key ? { [key]: structuredClone(data[key]) } : structuredClone(data)),
      set: (items: Record<string, unknown>) => {
        const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
        for (const [k, v] of Object.entries(items)) {
          changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
          data[k] = structuredClone(v);
        }
        notify(changes);
        return Promise.resolve();
      },
      remove: (key: string) => {
        const changes = { [key]: { oldValue: data[key] } };
        delete data[key];
        notify(changes);
        return Promise.resolve();
      },
    };
  };
  const reply = async (run: () => unknown) => {
    try {
      return { ok: true, value: await run() };
    } catch (error) {
      const e = error as { message?: string; code?: string };
      return { ok: false, error: e.message ?? String(error), ...(e.code ? { code: e.code } : {}) };
    }
  };
  const local = area('local');
  const session = area('session');
  const sentToTabs: { tabId: number; type: string; payload: unknown }[] = [];
  const chrome = {
    i18n: {
      getMessage: (key: string, subs?: string | string[]) =>
        subs === undefined ? key : `${key}(${([] as string[]).concat(subs).join(',')})`,
    },
    runtime: {
      id: 'test-extension',
      onMessage: {
        addListener: (l: Listener) => listeners.add(l),
        removeListener: (l: Listener) => listeners.delete(l),
      },
      sendMessage: (m: { type: string; payload: unknown }) =>
        reply(() => background(m.type, m.payload)),
      getURL: (path: string) => `chrome-extension://test-extension/${path}`,
      openOptionsPage: vi.fn(),
    },
    tabs: {
      sendMessage: (tabId: number, m: { type: string; payload: unknown }) => {
        sentToTabs.push({ tabId, type: m.type, payload: m.payload });
        return reply(() => tab(m.type, m.payload, tabId));
      },
      query: () => Promise.resolve(activeTab ? [activeTab] : []),
      create: vi.fn(() => Promise.resolve({})),
    },
    storage: {
      local,
      session,
      onChanged: {
        addListener: (l: StorageListener) => storageListeners.add(l),
        removeListener: (l: StorageListener) => storageListeners.delete(l),
      },
    },
    commands: { getAll: () => Promise.resolve([]) },
  };
  vi.stubGlobal('chrome', chrome);
  return {
    local: local.data,
    sentToTabs,
    /** A message to extension pages, as a content script sends `ui` progress. */
    toPages: (type: string, payload: unknown) =>
      listeners.forEach((l) => l({ target: 'ui', type, payload }, {}, () => undefined)),
  };
}
