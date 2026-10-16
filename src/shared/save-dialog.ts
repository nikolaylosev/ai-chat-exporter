/**
 * Remembers that the last export stopped at a Save As dialog. Chrome has no API to
 * read the "Ask where to save each file" setting, so the popup can only warn before
 * an export if an earlier export ran into the dialog. The flag is cleared by the
 * first export that saves its files without a dialog.
 */
const STORAGE_KEY = 'saveDialogSeen';

export async function isSaveDialogSeen(): Promise<boolean> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] === true;
}

export async function setSaveDialogSeen(seen: boolean): Promise<void> {
  if (seen) await chrome.storage.local.set({ [STORAGE_KEY]: true });
  else await chrome.storage.local.remove(STORAGE_KEY);
}
