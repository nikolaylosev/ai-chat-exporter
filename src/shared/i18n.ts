/** Localized string from `public/_locales`. Falls back to the key, so a missing string is visible. */
export function t(key: string, substitutions?: string | string[]): string {
  return chrome.i18n.getMessage(key, substitutions) || key;
}
