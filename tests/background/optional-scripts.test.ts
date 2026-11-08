import { afterEach, describe, expect, it, vi } from 'vitest';

type Script = chrome.scripting.RegisteredContentScript;

/** chrome.permissions and chrome.scripting, as far as the registration uses them. */
function stub({ allowed, registered = [] }: { allowed: boolean; registered?: Script[] }) {
  let scripts = registered.map((s) => ({ ...s }));
  const onAdded: ((p: chrome.permissions.Permissions) => void)[] = [];
  const onRemoved: (() => void)[] = [];
  const injected: [number, string][] = [];
  const state = { allowed };
  vi.stubGlobal('chrome', {
    permissions: {
      contains: () => Promise.resolve(state.allowed),
      onAdded: { addListener: (l: (p: chrome.permissions.Permissions) => void) => onAdded.push(l) },
      onRemoved: { addListener: (l: () => void) => onRemoved.push(l) },
    },
    scripting: {
      getRegisteredContentScripts: () => Promise.resolve(scripts.map((s) => ({ ...s }))),
      registerContentScripts: (list: Script[]) => {
        if (list.some((s) => scripts.some((r) => r.id === s.id)))
          return Promise.reject(new Error('Duplicate script ID'));
        scripts.push(...list);
        return Promise.resolve();
      },
      updateContentScripts: (list: Script[]) => {
        scripts = scripts.map((s) => list.find((u) => u.id === s.id) ?? s);
        return Promise.resolve();
      },
      unregisterContentScripts: ({ ids }: { ids: string[] }) => {
        scripts = scripts.filter((s) => !ids.includes(s.id));
        return Promise.resolve();
      },
    },
    tabs: {
      query: ({ url }: { url: string }) =>
        Promise.resolve(url === 'https://chat.deepseek.com/*' ? [{ id: 5 }, { id: 6 }] : []),
    },
  });
  return {
    scripts: () => scripts,
    injected,
    inject: (tabId: number, platform: string) => {
      injected.push([tabId, platform]);
      return Promise.resolve();
    },
    grant: () => {
      state.allowed = true;
      onAdded.forEach((l) => l({ origins: ['https://chat.deepseek.com/*'] }));
    },
    revoke: () => {
      state.allowed = false;
      onRemoved.forEach((l) => l());
    },
  };
}

async function load() {
  vi.resetModules();
  return import('../../src/background/optional-scripts');
}

afterEach(() => vi.unstubAllGlobals());

describe('optional content scripts', () => {
  it('registers nothing before access is given', async () => {
    const chrome = stub({ allowed: false });
    const { syncOptionalScripts } = await load();
    await syncOptionalScripts();
    expect(chrome.scripts()).toEqual([]);
  });

  it('registers the script when access is given and puts it into open tabs', async () => {
    const chrome = stub({ allowed: false });
    const { watchOptionalAccess, syncOptionalScripts } = await load();
    watchOptionalAccess(chrome.inject);
    await syncOptionalScripts();
    chrome.grant();
    await vi.waitFor(() => expect(chrome.injected).toHaveLength(2));
    expect(chrome.scripts()).toEqual([
      {
        id: 'deepseek',
        matches: ['https://chat.deepseek.com/*'],
        js: ['assets/deepseek.ts-loader.js'],
        runAt: 'document_idle',
      },
    ]);
    expect(chrome.injected).toEqual([
      [5, 'deepseek'],
      [6, 'deepseek'],
    ]);
  });

  it('drops the script when access is taken back', async () => {
    const chrome = stub({ allowed: true });
    const { watchOptionalAccess, syncOptionalScripts } = await load();
    watchOptionalAccess(chrome.inject);
    await syncOptionalScripts();
    expect(chrome.scripts()).toHaveLength(1);
    chrome.revoke();
    await syncOptionalScripts();
    expect(chrome.scripts()).toEqual([]);
  });

  it("points a registration left by an earlier version at this version's file", async () => {
    const chrome = stub({
      allowed: true,
      registered: [
        {
          id: 'deepseek',
          matches: ['https://chat.deepseek.com/*'],
          js: ['assets/deepseek.ts-loader-OLD.js'],
          runAt: 'document_idle',
        },
      ],
    });
    const { syncOptionalScripts } = await load();
    await syncOptionalScripts();
    expect(chrome.scripts().map((s) => s.js)).toEqual([['assets/deepseek.ts-loader.js']]);
  });

  it('registers once when the worker start and the grant come together', async () => {
    const chrome = stub({ allowed: true });
    const { syncOptionalScripts } = await load();
    await Promise.all([syncOptionalScripts(), syncOptionalScripts(), syncOptionalScripts()]);
    expect(chrome.scripts()).toHaveLength(1);
  });
});
