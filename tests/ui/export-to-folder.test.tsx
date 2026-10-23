// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportPage } from '../../src/ui/export-page/page';
import { stubChrome } from './fake-chrome';

// The folder is kept in IndexedDB, which the test page does not have.
const saved: unknown[] = [];
vi.mock('../../src/sinks/folder-handle', () => ({
  loadFolderHandle: () => Promise.resolve(null),
  requestFolderAccess: () => Promise.resolve('granted'),
  folderAccess: () => Promise.resolve('granted'),
  saveFolderHandle: (handle: unknown) => {
    saved.push(handle);
    return Promise.resolve();
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  saved.length = 0;
});

function page(pick: () => Promise<unknown>) {
  history.replaceState(null, '', '?');
  vi.stubGlobal('showDirectoryPicker', pick);
  const started: unknown[] = [];
  stubChrome({
    background: (type, payload) => {
      if (type === 'platform:tab') return { tabId: 7, opened: false };
      if (type === 'job:start') started.push(payload);
      return null;
    },
    tab: (type) =>
      type === 'conversations:list'
        ? {
            conversations: [
              {
                id: 'c1',
                platform: 'claude',
                title: 'Chat c1',
                createdAt: '2026-10-01T10:00:00Z',
                updatedAt: '2026-10-02T10:00:00Z',
                url: 'https://claude.ai/chat/c1',
              },
            ],
          }
        : null,
  });
  render(<ExportPage />);
  return started;
}

describe('export page: To a folder…', () => {
  it('asks for a folder, keeps it, and saves the selected chats into it', async () => {
    const handle = { name: 'Chats' };
    const started = page(() => Promise.resolve(handle));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Chat c1' }));
    fireEvent.click(screen.getByRole('button', { name: 'exportToFolder' }));
    await waitFor(() => expect(started).toHaveLength(1));
    expect(saved).toEqual([handle]);
    expect(started[0]).toMatchObject({ platform: 'claude', toFolder: true, items: [{ id: 'c1' }] });
  });

  it('starts nothing when the picker is closed', async () => {
    const started = page(() => Promise.reject(new DOMException('closed', 'AbortError')));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Chat c1' }));
    fireEvent.click(screen.getByRole('button', { name: 'exportToFolder' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toEqual([]);
    expect(saved).toEqual([]);
  });
});
