// With its extension: src/manifest.ts imports this file, and Vite loads that one outside the bundler.
import type { Platform } from './platform.ts';

/**
 * Platforms whose sites the extension reads only after the user allows it
 * (`optional_host_permissions`). A platform added after the first release goes
 * here: a new required host would make Chrome turn the extension off for
 * everyone who has it until they accept the new access. Each has every host it
 * reads, its file hosts included.
 */
export const OPTIONAL_HOSTS: Partial<Record<Platform, readonly string[]>> = {
  deepseek: ['https://chat.deepseek.com/*', 'https://files.deepseeksvc.com/*'],
};

/** Hosts the user may still have to allow for the platform; empty when it needs none. */
export function optionalHosts(platform: Platform): readonly string[] {
  return OPTIONAL_HOSTS[platform] ?? [];
}

/** Whether the extension may read the platform's sites. */
export async function hasPlatformAccess(platform: Platform): Promise<boolean> {
  const origins = optionalHosts(platform);
  if (origins.length === 0) return true;
  return chrome.permissions.contains({ origins: [...origins] });
}

/**
 * Asks the user for the platform's sites. Chrome shows its dialog only from a
 * click on an extension page; the service worker cannot ask.
 */
export async function requestPlatformAccess(platform: Platform): Promise<boolean> {
  const origins = optionalHosts(platform);
  if (origins.length === 0) return true;
  return chrome.permissions.request({ origins: [...origins] });
}
