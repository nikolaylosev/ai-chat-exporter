import { describe, expect, it } from 'vitest';
import { reusedFolder } from '../../src/background/export-conversation';
import type { ExportRecord } from '../../src/background/registry';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';

const record = (extra: Partial<ExportRecord> = {}): ExportRecord => ({
  updatedAt: '2026-10-13T09:00:00Z',
  exportedAt: '2026-10-13T10:00:00Z',
  destination: 'downloads',
  folder: 'AI Chats/Chat - 2026-10-13 (Gemini)',
  ...extra,
});
const copy = { ...DEFAULT_SETTINGS, onFolderExists: 'copy' as const };
const overwrite = { ...DEFAULT_SETTINGS, onFolderExists: 'overwrite' as const };

describe('reusedFolder', () => {
  it('makes a copy of a complete export unless overwriting', () => {
    expect(reusedFolder(copy, 'downloads', record())).toBeNull();
    expect(reusedFolder(overwrite, 'downloads', record())).toBe(record().folder);
  });

  it('completes the earlier folder of an export that missed files', () => {
    expect(reusedFolder(copy, 'downloads', record({ missingFiles: 2 }))).toBe(record().folder);
    expect(reusedFolder(copy, 'folder', record({ destination: 'folder', missingFiles: 1 }))).toBe(
      record().folder,
    );
  });

  it('never reuses across destinations, for a ZIP, or without a record', () => {
    expect(reusedFolder(copy, 'folder', record({ missingFiles: 2 }))).toBeNull();
    expect(reusedFolder(overwrite, 'zip', record({ destination: 'zip' }))).toBeNull();
    expect(reusedFolder(overwrite, 'downloads', undefined)).toBeNull();
  });
});
