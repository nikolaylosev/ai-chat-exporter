import { describe, expect, it } from 'vitest';
import type { DownloadRequest } from '../../src/background/downloader';
import { DownloadsSink, type DownloadsSinkDeps } from '../../src/sinks/downloads-sink';

function fakeDeps(options: { saveDialog?: boolean; failDownload?: boolean } = {}) {
  const calls = {
    downloads: [] as DownloadRequest[],
    created: [] as { text: string; mime: string }[],
    revoked: [] as string[],
  };
  const deps: DownloadsSinkDeps = {
    download: (request) => {
      calls.downloads.push(request);
      if (options.failDownload) return Promise.reject(new Error('NETWORK_FAILED'));
      return Promise.resolve({
        finalPath: `/Downloads/${request.filename}`,
        saveDialogSuspected: options.saveDialog ?? false,
      });
    },
    createBlobUrl: (text, mime) => {
      calls.created.push({ text, mime });
      return Promise.resolve(`blob:ext/${calls.created.length}`);
    },
    revokeBlobUrl: (url) => {
      calls.revoked.push(url);
      return Promise.resolve();
    },
  };
  return { deps, calls };
}

describe('DownloadsSink', () => {
  it('writes text through a blob URL under the root and revokes it', async () => {
    const { deps, calls } = fakeDeps();
    const sink = new DownloadsSink(deps, { root: ['AI Chats'], conflictAction: 'uniquify' });

    await sink.writeText('Chat/Chat.md', '# Hello');

    expect(calls.created).toEqual([{ text: '# Hello', mime: 'application/octet-stream' }]);
    expect(calls.downloads).toEqual([
      { url: 'blob:ext/1', filename: 'AI Chats/Chat/Chat.md', conflictAction: 'uniquify' },
    ]);
    expect(calls.revoked).toEqual(['blob:ext/1']);
  });

  it('downloads URL sources directly', async () => {
    const { deps, calls } = fakeDeps();
    const sink = new DownloadsSink(deps, { root: [], conflictAction: 'overwrite' });

    await sink.writeFile('Chat/files/a.pdf', { kind: 'url', url: 'https://claude.ai/files/a' });

    expect(calls.created).toEqual([]);
    expect(calls.downloads).toEqual([
      {
        url: 'https://claude.ai/files/a',
        filename: 'Chat/files/a.pdf',
        conflictAction: 'overwrite',
      },
    ]);
  });

  it('writes every text with a neutral MIME type so Chrome keeps the extension', async () => {
    const { deps, calls } = fakeDeps();
    const sink = new DownloadsSink(deps, { root: [], conflictAction: 'uniquify' });

    await sink.writeFile('app.jsx', { kind: 'text', text: 'x', mime: 'text/plain' });
    await sink.writeFile('a.svg', { kind: 'text', text: '<svg/>', mime: 'image/svg+xml' });

    expect(calls.created.map((c) => c.mime)).toEqual([
      'application/octet-stream',
      'application/octet-stream',
    ]);
  });

  it('revokes the blob URL even when the download fails', async () => {
    const { deps, calls } = fakeDeps({ failDownload: true });
    const sink = new DownloadsSink(deps, { root: [], conflictAction: 'uniquify' });

    await expect(sink.writeText('a.md', 'x')).rejects.toThrow('NETWORK_FAILED');
    expect(calls.revoked).toEqual(['blob:ext/1']);
  });

  it('rejects Blob sources', async () => {
    const { deps } = fakeDeps();
    const sink = new DownloadsSink(deps, { root: [], conflictAction: 'uniquify' });

    await expect(sink.writeFile('a.bin', { kind: 'blob', blob: new Blob(['x']) })).rejects.toThrow(
      /cannot write a Blob/,
    );
  });

  it('remembers a suspected Save As dialog', async () => {
    const { deps } = fakeDeps({ saveDialog: true });
    const sink = new DownloadsSink(deps, { root: [], conflictAction: 'uniquify' });

    expect(sink.saveDialogSuspected).toBe(false);
    await sink.writeText('a.md', 'x');
    expect(sink.saveDialogSuspected).toBe(true);
  });

  it('reserves the conversation folder through the registry', async () => {
    const { deps } = fakeDeps();
    const reserved: [string, boolean][] = [];
    const sink = new DownloadsSink(
      {
        ...deps,
        reserveFolder: (path, reuse) => {
          reserved.push([path, reuse]);
          return Promise.resolve(`${path} (2)`);
        },
      },
      { root: ['AI Chats'], conflictAction: 'uniquify' },
    );
    expect(await sink.prepareFolder('Chat')).toBe('Chat (2)');
    expect(reserved).toEqual([['AI Chats/Chat', false]]);
  });

  it('keeps the folder without a registry', async () => {
    const { deps } = fakeDeps();
    const sink = new DownloadsSink(deps, { root: [], conflictAction: 'overwrite' });
    expect(await sink.prepareFolder('Chat')).toBe('Chat');
  });
});
