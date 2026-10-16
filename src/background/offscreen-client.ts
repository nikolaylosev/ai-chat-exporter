import { log } from '../shared/logger';
import { send } from '../shared/messages';
import type { OffscreenFiles } from '../sinks/offscreen-sinks';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

let creating: Promise<void> | null = null;

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

/** Chrome allows one offscreen document per extension; concurrent callers share one creation. */
async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  // Logged because an archive in progress does not survive a new document.
  if (!creating) log.info('Creating the offscreen document');
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification:
        'Create blob URLs for generated files and ZIP archives so they can be downloaded, and write exports into the folder the user picked.',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

export async function createBlobUrl(text: string, mime: string): Promise<string> {
  await ensureOffscreenDocument();
  const { url } = await send('offscreen', 'blob:create', { text, mime });
  return url;
}

export async function revokeBlobUrl(url: string): Promise<void> {
  if (!(await hasOffscreenDocument())) return;
  await send('offscreen', 'blob:revoke', { url });
}

/** The image type of the file at a URL, read in the offscreen document as files for a ZIP are. */
export async function sniffImageType(url: string, keep = false): Promise<string | null> {
  await ensureOffscreenDocument();
  return (await send('offscreen', 'file:sniff', { url, keep })).mime;
}

async function call<R>(action: () => Promise<R>): Promise<R> {
  await ensureOffscreenDocument();
  return action();
}

/** File operations that need a window: the chosen folder and ZIP archives. */
export const offscreenFiles: OffscreenFiles = {
  prepareFolder: (folderPath, overwrite) =>
    call(() => send('offscreen', 'folder:prepare', { folderPath, overwrite })),
  writeToFolder: (path, source) => call(() => send('offscreen', 'folder:write', { path, source })),
  removeFromFolder: (path) => call(() => send('offscreen', 'folder:remove', { path })),
  openZip: async () => (await call(() => send('offscreen', 'zip:open', {}))).id,
  addToZip: (id, path, source) => call(() => send('offscreen', 'zip:add', { id, path, source })),
  closeZipToUrl: async (id) =>
    (await call(() => send('offscreen', 'zip:close-to-url', { id }))).url,
  closeZipToFolder: (id, path, overwrite) =>
    call(() => send('offscreen', 'zip:close-to-folder', { id, path, overwrite })),
  discardZip: async (id) => {
    if (await hasOffscreenDocument()) await send('offscreen', 'zip:discard', { id });
  },
  revokeBlobUrl,
};
