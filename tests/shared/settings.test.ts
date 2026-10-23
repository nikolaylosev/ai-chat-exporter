import { describe, expect, it } from 'vitest';
import { userMessage } from '../../src/shared/errors';
import {
  DEFAULT_SETTINGS,
  exportRootFolder,
  exportsAsZip,
  normalizeSettings,
} from '../../src/shared/settings';

describe('normalizeSettings', () => {
  it.each([[undefined], [null], ['string'], [42]])('returns defaults for %j', (stored) => {
    expect(normalizeSettings(stored)).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid stored values', () => {
    const stored = { rootFolder: '', saveThinking: true, delayBetweenChatsMs: 0 };
    expect(normalizeSettings(stored)).toEqual({ ...DEFAULT_SETTINGS, ...stored });
  });

  it('replaces values of the wrong type', () => {
    const result = normalizeSettings({ rootFolder: 5, saveAttachments: 'yes' });
    expect(result.rootFolder).toBe(DEFAULT_SETTINGS.rootFolder);
    expect(result.saveAttachments).toBe(DEFAULT_SETTINGS.saveAttachments);
  });

  it('validates the destination', () => {
    expect(normalizeSettings({ destination: 'folder' }).destination).toBe('folder');
    expect(normalizeSettings({ destination: 'cloud' }).destination).toBe('downloads');
    // A setting the extension no longer has is dropped.
    expect('saveAsZip' in normalizeSettings({ saveAsZip: true })).toBe(false);
  });

  it('uses the chosen folder itself as the export root', () => {
    expect(exportRootFolder({ ...DEFAULT_SETTINGS, rootFolder: 'X' })).toBe('X');
    expect(exportRootFolder({ ...DEFAULT_SETTINGS, rootFolder: 'X', destination: 'folder' })).toBe(
      '',
    );
  });

  it('rejects unknown enum values', () => {
    expect(normalizeSettings({ onFolderExists: 'delete' }).onFolderExists).toBe('copy');
    expect(normalizeSettings({ claudeBranches: 'all' }).claudeBranches).toBe('all');
  });

  it('rejects negative or non-finite numbers', () => {
    expect(normalizeSettings({ delayBetweenChatsMs: -1 }).delayBetweenChatsMs).toBe(800);
    expect(normalizeSettings({ delayBetweenChatsMs: Infinity }).delayBetweenChatsMs).toBe(800);
  });

  it('drops unknown keys', () => {
    expect(normalizeSettings({ legacy: true })).not.toHaveProperty('legacy');
  });
});

describe('userMessage', () => {
  it('drops request URLs', () => {
    expect(userMessage(new Error('HTTP 500 for https://claude.ai/api/x?y=1'))).toBe('HTTP 500');
    expect(userMessage('plain')).toBe('plain');
  });
});

describe('exportsAsZip', () => {
  const downloads = { destination: 'downloads' as const, saveAttachments: true };
  it('makes one .zip into Downloads for a bulk export or a chat with files', () => {
    expect(exportsAsZip(downloads, { bulk: true, hasFiles: false })).toBe(true);
    expect(exportsAsZip(downloads, { bulk: false, hasFiles: true })).toBe(true);
  });
  it('saves a note alone as one file, and separate files into a chosen folder', () => {
    expect(exportsAsZip(downloads, { bulk: false, hasFiles: false })).toBe(false);
    expect(
      exportsAsZip({ ...downloads, saveAttachments: false }, { bulk: false, hasFiles: true }),
    ).toBe(false);
    expect(
      exportsAsZip({ ...downloads, destination: 'folder' }, { bulk: true, hasFiles: true }),
    ).toBe(false);
  });
});
