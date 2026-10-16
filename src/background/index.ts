import { log } from '../shared/logger';
import { handle, sendToTab } from '../shared/messages';
import { keepDownloadNames } from './downloader';
import { copyCurrent, exportCurrent } from './export-current';
import { cancelJob, resumeJob, startJob } from './queue';
import { detectPlatform } from '../shared/platform';
import { registry } from './registry';
import { ensureContentScript, WorkerTab } from './tabs';

export const EXPORT_COMMAND = 'export-current-chat';

handle('background', {
  'export:current': ({ tabId }) => exportCurrent(tabId, 'popup'),
  'export:copy': ({ tabId }) => copyCurrent(tabId),
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
  'project:of-tab': async ({ tabId }) => {
    const platform = detectPlatform((await chrome.tabs.get(tabId)).url);
    if (!platform) return null;
    await ensureContentScript(tabId, platform);
    return sendToTab(tabId, 'project:current', {});
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
});

// A bulk export outlives the service worker: pick it up when the worker starts again.
void resumeJob().catch((error: unknown) => log.error('Could not resume the bulk export', error));
