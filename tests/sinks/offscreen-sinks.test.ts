import { describe, expect, it } from 'vitest';
import { DownloadInterruptedError, type DownloadRequest } from '../../src/background/downloader';
import {
  FolderSink,
  ZipArchive,
  ZipSink,
  type OffscreenFiles,
} from '../../src/sinks/offscreen-sinks';
import { FileWriteError } from '../../src/sinks/source';

function fakeApi(overrides: Partial<OffscreenFiles> = {}) {
  const calls: string[] = [];
  const api: OffscreenFiles = {
    prepareFolder: (folderPath, overwrite) => {
      calls.push(`prepare ${folderPath} ${overwrite}`);
      return Promise.resolve({ folder: 'AI Chats', folderPath: `${folderPath} (2)` });
    },
    writeToFolder: (path) => {
      calls.push(`write ${path}`);
      return Promise.resolve(
        path.endsWith('bad.png') ? { ok: false, reason: 'HTTP_404' } : { ok: true },
      );
    },
    removeFromFolder: (path) => {
      calls.push(`remove ${path}`);
      return Promise.resolve({ ok: true });
    },
    openZip: () => {
      calls.push('open');
      return Promise.resolve('z1');
    },
    addToZip: (id, path) => {
      calls.push(`add ${id} ${path}`);
      return Promise.resolve({ ok: true });
    },
    closeZipToUrl: (id) => {
      calls.push(`close-url ${id}`);
      return Promise.resolve('blob:zip');
    },
    closeZipToFolder: (id, path, overwrite) => {
      calls.push(`close-folder ${id} ${path} ${overwrite}`);
      return Promise.resolve({ folder: 'AI Chats', path: 'Chat (2).zip' });
    },
    discardZip: (id) => {
      calls.push(`discard ${id}`);
      return Promise.resolve();
    },
    revokeBlobUrl: (url) => {
      calls.push(`revoke ${url}`);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { api, calls };
}

const text = { kind: 'text' as const, text: 'x', mime: 'text/plain' };

describe('FolderSink', () => {
  it('prepares the folder, writes, and reports the chosen folder', async () => {
    const { api, calls } = fakeApi();
    const sink = new FolderSink(api, false);
    expect(await sink.prepareFolder('Chat')).toBe('Chat (2)');
    await sink.writeText('Chat (2)/Chat.md', '# Chat');
    expect(await sink.finish('Chat (2)/Chat.md')).toEqual({
      kind: 'folder',
      folder: 'AI Chats',
      path: 'Chat (2)/Chat.md',
    });
    expect(calls).toEqual(['prepare Chat false', 'write Chat (2)/Chat.md']);
  });

  it('turns a failed file into FileWriteError with its reason', async () => {
    const { api } = fakeApi();
    await expect(new FolderSink(api, false).writeFile('f/bad.png', text)).rejects.toEqual(
      new FileWriteError('HTTP_404'),
    );
  });
});

describe('ZipSink', () => {
  const downloadTarget = (download: (r: DownloadRequest) => Promise<string>) => ({
    kind: 'downloads' as const,
    root: ['AI Chats'],
    conflictAction: 'uniquify' as const,
    download: async (request: DownloadRequest) => ({
      finalPath: await download(request),
      saveDialogSuspected: false,
    }),
  });

  it('downloads one archive named after the conversation folder', async () => {
    const { api, calls } = fakeApi();
    const requests: DownloadRequest[] = [];
    const sink = new ZipSink(
      api,
      downloadTarget((request) => {
        requests.push(request);
        return Promise.resolve('/Users/me/Downloads/AI Chats/Chat (1).zip');
      }),
    );
    expect(await sink.prepareFolder('chats/Chat')).toBe('chats/Chat');
    await sink.writeFile('chats/Chat/files/a.txt', text);
    expect(await sink.finish('x.md')).toEqual({ kind: 'downloads', path: 'AI Chats/Chat (1).zip' });
    expect(requests).toEqual([
      { url: 'blob:zip', filename: 'AI Chats/Chat.zip', conflictAction: 'uniquify' },
    ]);
    expect(calls).toEqual([
      'open',
      'add z1 chats/Chat/files/a.txt',
      'close-url z1',
      'revoke blob:zip',
    ]);
  });

  it('shows the full path when the user picked a place in a Save As dialog', async () => {
    const { api } = fakeApi();
    const sink = new ZipSink(api, {
      ...downloadTarget(() => Promise.resolve('')),
      download: () => Promise.resolve({ finalPath: '/tmp/Chat.zip', saveDialogSuspected: true }),
    });
    await sink.prepareFolder('Chat');
    expect(await sink.finish('x.md')).toEqual({ kind: 'absolute', path: '/tmp/Chat.zip' });
  });

  it('reports a cancelled Save As dialog and still revokes the URL', async () => {
    const { api, calls } = fakeApi();
    const sink = new ZipSink(
      api,
      downloadTarget(() => Promise.reject(new DownloadInterruptedError('USER_CANCELED'))),
    );
    await sink.prepareFolder('Chat');
    await expect(sink.finish('x.md')).rejects.toMatchObject({ code: 'save-cancelled' });
    expect(calls).toContain('revoke blob:zip');
  });

  it('saves into the chosen folder', async () => {
    const { api, calls } = fakeApi();
    const sink = new ZipSink(api, { kind: 'folder', overwrite: false });
    await sink.prepareFolder('Chat');
    expect(await sink.finish('x.md')).toEqual({
      kind: 'folder',
      folder: 'AI Chats',
      path: 'Chat (2).zip',
    });
    expect(calls).toContain('close-folder z1 Chat.zip false');
  });

  it('discards an open archive on abort, once', async () => {
    const { api, calls } = fakeApi();
    const sink = new ZipSink(api, { kind: 'folder', overwrite: false });
    await sink.abort();
    await sink.prepareFolder('Chat');
    await sink.abort();
    await sink.abort();
    expect(calls.filter((c) => c.startsWith('discard'))).toEqual(['discard z1']);
  });
});

describe('ZipSink in a shared archive', () => {
  it('gives each conversation its own folder and leaves the archive open', async () => {
    const { api, calls } = fakeApi();
    const archive = new ZipArchive(api, { kind: 'folder', overwrite: false }, 'Claude.zip');
    const first = new ZipSink(archive);
    const second = new ZipSink(archive);
    expect(await first.prepareFolder('Chat')).toBe('Chat');
    expect(await second.prepareFolder('Chat')).toBe('Chat (2)');
    await second.writeText('Chat (2)/Chat (2).md', '#');
    expect(await second.finish('Chat (2)/Chat (2).md')).toEqual({
      kind: 'archive',
      archive: 'Claude.zip',
      path: 'Chat (2)/Chat (2).md',
    });
    await second.abort();
    expect(calls).toEqual(['open', 'add z1 Chat (2)/Chat (2).md']);
    expect(archive.snapshot()).toEqual({
      zipId: 'z1',
      name: 'Claude.zip',
      folders: ['chat', 'chat (2)'],
    });
  });

  it('picks up an archive a restarted worker left open', async () => {
    const { api, calls } = fakeApi();
    const archive = new ZipArchive(api, { kind: 'folder', overwrite: false }, '', {
      zipId: 'z9',
      name: 'Claude.zip',
      folders: ['chat'],
    });
    expect(archive.reserveFolder('Chat')).toBe('Chat (2)');
    await archive.close();
    expect(calls).toEqual(['close-folder z9 Claude.zip false']);
  });
});
