import { describe, expect, it } from 'vitest';
import { checkFolder, FolderWriter } from '../../src/sinks/folder-writer';
import { HttpError } from '../../src/util/http';
import { FakeDirectory } from './fake-fs';

const text = (value: string) => ({ kind: 'text' as const, text: value, mime: 'text/plain' });

describe('FolderWriter', () => {
  it('creates nested folders and writes text', async () => {
    const root = new FakeDirectory('AI Chats');
    const writer = new FolderWriter(root.asHandle());
    await writer.write('Chat/files/a.txt', text('hello'));
    expect(await root.read('Chat/files/a.txt')).toBe('hello');
    expect(writer.name).toBe('AI Chats');
  });

  it('replaces an existing file', async () => {
    const root = new FakeDirectory('r');
    const writer = new FolderWriter(root.asHandle());
    await writer.write('a.md', text('old and longer'));
    await writer.write('a.md', text('new'));
    expect(await root.read('a.md')).toBe('new');
  });

  it('downloads a URL with cookies', async () => {
    const root = new FakeDirectory('r');
    const requests: [string, RequestInit | undefined][] = [];
    const writer = new FolderWriter(root.asHandle(), (url, init) => {
      requests.push([url, init]);
      return Promise.resolve(new Response('bytes'));
    });
    await writer.write('f/x.bin', { kind: 'url', url: 'https://claude.ai/files/1' });
    expect(await root.read('f/x.bin')).toBe('bytes');
    expect(requests).toEqual([['https://claude.ai/files/1', { credentials: 'include' }]]);
  });

  it('fails on an HTTP error without creating the file', async () => {
    const root = new FakeDirectory('r');
    const writer = new FolderWriter(root.asHandle(), () =>
      Promise.resolve(new Response('no', { status: 404 })),
    );
    await expect(writer.write('x.bin', { kind: 'url', url: 'u' })).rejects.toBeInstanceOf(
      HttpError,
    );
    expect(root.files.size).toBe(0);
  });

  it('finds free names for folders and files', async () => {
    const root = new FakeDirectory('r');
    const writer = new FolderWriter(root.asHandle());
    expect(await writer.freePath('Chat v1.2', 'folder')).toBe('Chat v1.2');
    await writer.write('Chat v1.2/Chat.md', text(''));
    await writer.write('Chat v1.2 (2)/Chat.md', text(''));
    expect(await writer.freePath('Chat v1.2', 'folder')).toBe('Chat v1.2 (3)');

    await writer.write('sub/Chat.zip', text(''));
    expect(await writer.freePath('sub/Chat.zip', 'file')).toBe('sub/Chat (2).zip');
    expect(await writer.freePath('other/Chat.zip', 'file')).toBe('other/Chat.zip');
  });
});

describe('checkFolder', () => {
  it('passes for an available folder with access', async () => {
    await expect(checkFolder(new FakeDirectory('r').asHandle())).resolves.toBeUndefined();
  });

  it.each([['prompt'], ['denied']] as const)('reports missing access (%s)', async (permission) => {
    const root = new FakeDirectory('r');
    root.permission = permission;
    await expect(checkFolder(root.asHandle())).rejects.toMatchObject({ code: 'folder-permission' });
  });

  it('reports a folder that is gone', async () => {
    const root = new FakeDirectory('r');
    root.gone = true;
    await expect(checkFolder(root.asHandle())).rejects.toMatchObject({ code: 'folder-missing' });
  });
});
