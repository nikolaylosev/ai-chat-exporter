import { CodedError } from '../shared/errors';
import { log } from '../shared/logger';
import { sendToTab } from '../shared/messages';
import type { Platform } from '../shared/platform';

const PLATFORM_ORIGIN: Record<Platform, string> = {
  claude: 'https://claude.ai',
  gemini: 'https://gemini.google.com',
  grok: 'https://grok.com',
  chatgpt: 'https://chatgpt.com',
};

/** Content script files for a platform, as listed in the built manifest. */
function contentScriptFiles(platform: Platform): string[] {
  const host = new URL(PLATFORM_ORIGIN[platform]).host;
  const entry = chrome.runtime
    .getManifest()
    .content_scripts?.find((cs) => cs.matches?.some((m) => m.includes(host)));
  return entry?.js ?? [];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tabs opened before the extension was installed or reloaded have no content
 * script yet; inject it on demand.
 */
export async function ensureContentScript(tabId: number, platform: Platform): Promise<void> {
  try {
    await sendToTab(tabId, 'ping', {});
    return;
  } catch {
    log.info('Injecting content script into tab', tabId);
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: contentScriptFiles(platform) });
  // The injected file is a loader that imports the real script asynchronously, so the
  // handlers appear a moment after executeScript resolves.
  for (let attempt = 0; ; attempt++) {
    try {
      await sendToTab(tabId, 'ping', {});
      return;
    } catch (error) {
      if (attempt >= 15) throw error;
      await sleep(200);
    }
  }
}

/**
 * Waits until a tab the extension just opened can do the work: its content script
 * answers. The script runs once the page is parsed, well before the tab reports
 * `complete`; a heavy web app in a background tab may report that very late or
 * never (seen 2026-10-15). A page that finished loading without the script gets it
 * injected.
 */
async function waitForContentScript(
  tabId: number,
  platform: Platform,
  timeoutMs = 60000,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      await sendToTab(tabId, 'ping', {});
      return;
    } catch {
      // Not there yet.
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new CodedError('tab-not-loaded', 'The platform tab was closed');
    if (tab.status === 'complete') {
      await ensureContentScript(tabId, platform);
      return;
    }
    if (Date.now() >= until) {
      throw new CodedError('tab-not-loaded', `The ${platform} tab did not load`);
    }
    await sleep(500);
  }
}

/** Ids of the tab a job works in, kept in the job state so a restarted worker can reuse it. */
export interface WorkerTabState {
  tabId?: number;
  /** Set when the extension opened the tab, so it closes it at the end. */
  createdTabId?: number;
}

/**
 * A platform tab for work without a chat open: listing conversations and bulk
 * export. The adapter runs in the page, so requests are the web app's own, with
 * the user's cookies. An open tab of the platform is reused; otherwise one is
 * opened in the background and closed when the work is done.
 */
export class WorkerTab {
  constructor(
    private readonly platform: Platform,
    readonly state: WorkerTabState = {},
  ) {}

  async get(): Promise<number> {
    if (this.state.tabId !== undefined && (await this.isUsable(this.state.tabId))) {
      return this.state.tabId;
    }
    const origin = PLATFORM_ORIGIN[this.platform];
    const [open] = await chrome.tabs.query({ url: `${origin}/*`, discarded: false });
    let tabId = open?.id;
    if (tabId === undefined) {
      const tab = await chrome.tabs.create({ url: `${origin}/`, active: false });
      if (tab.id === undefined) throw new Error('Could not open a platform tab');
      tabId = tab.id;
      this.state.createdTabId = tabId;
      try {
        await waitForContentScript(tabId, this.platform);
      } catch (error) {
        // A tab that never became usable is not left behind.
        await this.release();
        throw error;
      }
    }
    await ensureContentScript(tabId, this.platform);
    this.state.tabId = tabId;
    return tabId;
  }

  /** Closes the tab if the extension opened it. */
  async release(): Promise<void> {
    const created = this.state.createdTabId;
    delete this.state.tabId;
    delete this.state.createdTabId;
    if (created !== undefined) await chrome.tabs.remove(created).catch(() => undefined);
  }

  private async isUsable(tabId: number): Promise<boolean> {
    try {
      const tab = await chrome.tabs.get(tabId);
      return !tab.discarded && Boolean(tab.url?.startsWith(PLATFORM_ORIGIN[this.platform]));
    } catch {
      return false;
    }
  }
}
