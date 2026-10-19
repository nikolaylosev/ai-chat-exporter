/**
 * The mark on the extension's icon: working, done, done with warnings (yellow,
 * the icon's own colour, so it does not read as an error), failed.
 */
const BADGE = {
  working: { text: '…', color: '#2563eb', textColor: '#ffffff' },
  done: { text: '✓', color: '#15803d', textColor: '#ffffff' },
  partial: { text: '!', color: '#ffb000', textColor: '#14161f' },
  failed: { text: '!', color: '#b91c1c', textColor: '#ffffff' },
} as const;

export type BadgeState = keyof typeof BADGE;

/**
 * Shows a state on the icon of one tab, or of every tab without `tabId`; a final
 * state goes away after `clearAfterMs`. Never throws: the mark is a hint only.
 */
export async function setBadge(
  state: BadgeState | null,
  { tabId, clearAfterMs }: { tabId?: number; clearAfterMs: number },
): Promise<void> {
  const where = tabId === undefined ? {} : { tabId };
  try {
    if (!state) {
      await chrome.action.setBadgeText({ ...where, text: '' });
      return;
    }
    const badge = BADGE[state];
    await chrome.action.setBadgeBackgroundColor({ ...where, color: badge.color });
    await chrome.action.setBadgeTextColor({ ...where, color: badge.textColor });
    await chrome.action.setBadgeText({ ...where, text: badge.text });
    if (state !== 'working') {
      setTimeout(() => void setBadge(null, { ...where, clearAfterMs }), clearAfterMs);
    }
  } catch {
    // The tab may have been closed.
  }
}
