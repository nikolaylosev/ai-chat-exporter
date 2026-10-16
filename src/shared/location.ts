import { t } from './i18n';
import type { SavedLocation } from './messages';

/** "Saved to Downloads:", "Saved to the folder “AI Chats”:" and so on. */
export function locationLabel(location: SavedLocation): string {
  switch (location.kind) {
    case 'downloads':
      return t('savedToDownloads');
    case 'folder':
      return t('savedToFolder', location.folder);
    case 'archive':
      return t('savedToArchive', location.archive);
    case 'absolute':
      return t('savedTo');
  }
}
