import { parseVaultRules, type VaultRules } from '../obsidian/vault';
import { ObsidianRest } from '../obsidian/rest';
import type { Settings } from '../shared/settings';
import { loadVaultRules } from './offscreen-client';

/** The Local REST API plugin at the address and with the key from the settings. */
export function obsidianRest(
  settings: Pick<Settings, 'obsidianUrl' | 'obsidianKey'>,
): ObsidianRest {
  return new ObsidianRest(settings.obsidianUrl, settings.obsidianKey);
}

/**
 * The vault's rules for an export in Obsidian mode: from `.obsidian/app.json` in
 * the chosen folder, or through the plugin, which by default refuses that folder;
 * then the attachment folder and link style typed in the settings stand in.
 */
export async function vaultRules(settings: Settings): Promise<VaultRules> {
  if (settings.destination !== 'obsidian') return loadVaultRules();
  const config = await obsidianRest(settings).readConfig();
  return parseVaultRules(
    '',
    config ??
      JSON.stringify({
        attachmentFolderPath: settings.obsidianAttachments,
        useMarkdownLinks: settings.obsidianMarkdownLinks,
      }),
  );
}
