import { log } from '../shared/logger';
import { handle, sendToTab } from '../shared/messages';
import { keepDownloadNames } from './downloader';
import { copyCurrent, exportCurrent } from './export-current';
import { writeClipboard } from './offscreen-client';
import { cancelJob, resumeJob, startJob } from './queue';
import { detectPlatform } from '../shared/platform';
import { registry } from './registry';
import { ensureContentScript, WorkerTab } from './tabs';

export const EXPORT_COMMAND = 'export-current-chat';

/** The tab a page's content script talks from. */
function senderTab(sender: chrome.runtime.MessageSender): number {
  const tabId = sender.tab?.id;
  if (tabId === undefined) throw new Error('The message must come from a tab');
  return tabId;
}

handle('background', {
  'export:current': ({ tabId, zip }) =>
    exportCurrent(tabId, 'popup', zip ? { saveAsZip: true } : {}),
  'export:copy': ({ tabId }) => copyCurrent(tabId),
  'export:this-tab': ({ withFiles, zip }, sender) =>
    exportCurrent(senderTab(sender), 'command', {
      ...(withFiles === undefined ? {} : { saveAttachments: withFiles }),
      ...(zip ? { saveAsZip: true } : {}),
    }),
  'folder:pick': async ({ tabId, withFiles }, sender) => {
    const query = new URLSearchParams({ tab: String(tabId ?? senderTab(sender)) });
    if (withFiles !== undefined) query.set('files', withFiles ? '1' : '0');
    await chrome.windows.create({
      url: chrome.runtime.getURL(`src/ui/pick-folder/index.html?${query.toString()}`),
      type: 'popup',
      width: 420,
      height: 240,
      focused: true,
    });
    return null;
  },
  'export:to-folder': ({ tabId, withFiles }) =>
    exportCurrent(tabId, 'command', {
      destination: 'folder',
      ...(withFiles === undefined ? {} : { saveAttachments: withFiles }),
    }),
  'copy:this-tab': async (_payload, sender) => {
    const copied = await copyCurrent(senderTab(sender));
    if (copied.ok) await writeClipboard(copied.markdown);
    return copied;
  },
  'platform:tab': async ({ platform }) => {
    const tab = new WorkerTab(platform);
    const tabId = await tab.get();
    return { tabId, opened: tab.state.createdTabId === tabId };
  },
  'platform:tab-done': async ({ tabId, opened }) => {
    if (opened) await chrome.tabs.remove(tabId).catch(() => undefined);
    return null;
  },
  'projects:list': async ({ platform }) => {
    const tab = new WorkerTab(platform);
    try {
      return await sendToTab(await tab.get(), 'projects:list', {});
    } finally {
      await tab.release();
    }
  },
  // An extra line in the popup: a tab that cannot answer (reloading, an old copy of
  // the script) just has no project shown.
  'project:of-tab': async ({ tabId }) => {
    try {
      const platform = detectPlatform((await chrome.tabs.get(tabId)).url);
      if (!platform) return null;
      await ensureContentScript(tabId, platform);
      return await sendToTab(tabId, 'project:current', {});
    } catch (error) {
      log.info('No project for the tab', error);
      return null;
    }
  },
  'job:start': async ({ platform, items }) => {
    await startJob(platform, items);
    return null;
  },
  'job:cancel': async () => {
    await cancelJob();
    return null;
  },
  'registry:count': async () => ({ count: await registry.size() }),
  'registry:clear': async () => {
    await registry.clear();
    return null;
  },
  'open:options': async () => {
    await chrome.runtime.openOptionsPage();
    return null;
  },
  'open:download-settings': async () => {
    await chrome.tabs.create({ url: 'chrome://settings/downloads' });
    return null;
  },
});

keepDownloadNames();

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== EXPORT_COMMAND) return;
  void (async () => {
    const tabId =
      tab?.id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (tabId === undefined) return;
    await exportCurrent(tabId, 'command');
  })();
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  log.info(`Installed (${reason}), version ${chrome.runtime.getManifest().version}`);
  // Up to 0.2.16 the popup kept warning about a past Save As dialog; the flag is gone.
  void chrome.storage.local.remove('saveDialogSeen').catch(() => undefined);
});

// A bulk export outlives the service worker: pick it up when the worker starts again.
void resumeJob().catch((error: unknown) => log.error('Could not resume the bulk export', error));
