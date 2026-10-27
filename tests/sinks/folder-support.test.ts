import { afterEach, describe, expect, it, vi } from 'vitest';
import { canUseFolders, loadFolderHandle } from '../../src/sinks/folder-handle';

afterEach(() => vi.unstubAllGlobals());

describe('canUseFolders', () => {
  it('needs both the folder picker and the handle class', () => {
    expect(canUseFolders()).toBe(false);
    vi.stubGlobal('showDirectoryPicker', () => undefined);
    expect(canUseFolders()).toBe(false);
    vi.stubGlobal('FileSystemDirectoryHandle', class {});
    expect(canUseFolders()).toBe(true);
  });

  it('has no chosen folder where the browser has no folder access', async () => {
    // Without the API, IndexedDB is not even opened.
    await expect(loadFolderHandle()).resolves.toBeNull();
  });
});
