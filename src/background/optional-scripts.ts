import deepseekScript from '../content/deepseek.ts?script';
import { log } from '../shared/logger';
import { hasPlatformAccess, OPTIONAL_HOSTS } from '../shared/optional-hosts';
import type { Platform } from '../shared/platform';

const script = (
  file: string,
  id: string,
  match: string,
): chrome.scripting.RegisteredContentScript => ({
  id,
  matches: [match],
  js: [file],
  runAt: 'document_idle',
});

/**
 * Content scripts of the platforms the user allows later (shared/optional-hosts.ts).
 * The manifest cannot list them: its content scripts' sites count as required
 * access. Chrome keeps a registration across restarts; it is checked again
 * whenever the worker starts, since a new version names its files differently.
 */
// The file comes first: crxjs fills in its name only where a comma follows it.
const SCRIPTS: Partial<Record<Platform, chrome.scripting.RegisteredContentScript>> = {
  deepseek: script(deepseekScript, 'deepseek', 'https://chat.deepseek.com/*'),
};

/** The platform's registered script files, when it has one. */
export function optionalScriptFiles(platform: Platform): string[] | undefined {
  return SCRIPTS[platform]?.js;
}

const sameFiles = (a: string[] | undefined, b: string[] | undefined) =>
  (a ?? []).join('\n') === (b ?? []).join('\n');

async function sync(): Promise<void> {
  const registered = new Map(
    (await chrome.scripting.getRegisteredContentScripts()).map((s) => [s.id, s]),
  );
  for (const [platform, script] of Object.entries(SCRIPTS) as [
    Platform,
    chrome.scripting.RegisteredContentScript,
  ][]) {
    const now = registered.get(script.id);
    const allowed = await hasPlatformAccess(platform);
    if (allowed && !now) {
      await chrome.scripting.registerContentScripts([script]);
      log.info('Registered the content script for', platform);
    } else if (allowed && now && !sameFiles(now.js, script.js)) {
      await chrome.scripting.updateContentScripts([script]);
    } else if (!allowed && now) {
      await chrome.scripting.unregisterContentScripts({ ids: [script.id] });
      log.info('Unregistered the content script for', platform);
    }
  }
}

let syncing: Promise<void> = Promise.resolve();

/** Registers the scripts of allowed platforms and drops the others', one run at a time. */
export function syncOptionalScripts(): Promise<void> {
  syncing = syncing
    .then(sync)
    .catch((error: unknown) => log.error('Could not register content scripts', error));
  return syncing;
}

/** Platforms that one of the given sites belongs to. */
function platformsOf(origins: string[] | undefined): Platform[] {
  return (Object.entries(OPTIONAL_HOSTS) as [Platform, readonly string[]][])
    .filter(([, hosts]) => origins?.some((o) => hosts.includes(o)))
    .map(([platform]) => platform);
}

/**
 * Keeps the registrations in step with the access the user gives or takes back
 * (on chrome://extensions too). Tabs of a platform just allowed get the script
 * now, so their page button appears without a reload.
 */
export function watchOptionalAccess(inject: (tabId: number, platform: Platform) => Promise<void>) {
  chrome.permissions.onAdded.addListener(({ origins }) => {
    void syncOptionalScripts().then(async () => {
      for (const platform of platformsOf(origins)) {
        const [match] = SCRIPTS[platform]?.matches ?? [];
        if (!match || !(await hasPlatformAccess(platform))) continue;
        for (const tab of await chrome.tabs.query({ url: match, discarded: false })) {
          if (tab.id !== undefined) await inject(tab.id, platform).catch(() => undefined);
        }
      }
    });
  });
  chrome.permissions.onRemoved.addListener(() => void syncOptionalScripts());
  void syncOptionalScripts();
}
