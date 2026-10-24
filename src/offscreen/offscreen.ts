import { CodedError } from '../shared/errors';
import { handle, type WriteReply } from '../shared/messages';
import { loadFolderHandle } from '../sinks/folder-handle';
import { checkFolder, FolderWriter } from '../sinks/folder-writer';
import {
  failureReason,
  keepPrefetched,
  sourceBlob,
  type TransferableSource,
} from '../sinks/source';
import { imageTypeOf } from '../util/image-type';
import { ArchiveStore } from './archive-store';
import { docxBlob, forWrite } from './word-notes';

// The service worker has no URL.createObjectURL and no File System Access, so this
// document creates blob URLs for chrome.downloads, writes into the folder the user
// picked, and builds ZIP archives.

/** The chosen folder, opened when an export starts and reused for its files. */
let writer: FolderWriter | null = null;
const archives = new ArchiveStore();
const folderCloses = new Map<string, Promise<{ folder: string; path: string }>>();

async function openFolder(): Promise<FolderWriter> {
  const root = await loadFolderHandle();
  if (!root) throw new CodedError('folder-not-chosen', 'No folder chosen');
  await checkFolder(root);
  writer = new FolderWriter(root);
  return writer;
}

async function folder(): Promise<FolderWriter> {
  return writer ?? openFolder();
}

/** Runs one file's write; problems with this file come back as a reason, not an exception. */
async function attempt(action: () => Promise<void>): Promise<WriteReply> {
  try {
    await action();
    return { ok: true };
  } catch (error) {
    if (error instanceof CodedError) throw error;
    return { ok: false, reason: failureReason(error) };
  }
}

/**
 * The image type of the file at `url`. With `keep`, the whole file is downloaded
 * and kept for the write that follows (into a folder or a ZIP, both from here), so
 * it is fetched once; otherwise only its first bytes are read and the rest dropped.
 */
async function sniff(url: string, keep: boolean): Promise<string | null> {
  try {
    if (keep) {
      const blob = await sourceBlob({ kind: 'url', url });
      keepPrefetched(url, blob);
      return imageTypeOf(new Uint8Array(await blob.slice(0, 16).arrayBuffer()))?.mime ?? null;
    }
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    const head = new Uint8Array(16);
    let length = 0;
    while (length < head.length) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = value.subarray(0, head.length - length);
      head.set(take, length);
      length += take.length;
    }
    await reader.cancel().catch(() => undefined);
    return imageTypeOf(head.subarray(0, length))?.mime ?? null;
  } catch {
    return null;
  }
}

handle('offscreen', {
  'file:sniff': async ({ url, keep }) => ({ mime: await sniff(url, keep) }),
  'blob:create': ({ text, mime }) => ({
    url: URL.createObjectURL(new Blob([text], { type: mime })),
  }),
  // navigator.clipboard needs a focused page; the offscreen document never has focus.
  'clipboard:write': ({ text }) => {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (!copied) throw new Error('The clipboard refused the text');
    return null;
  },
  // A Word note alone (no files) for chrome.downloads.
  'docx:create': async ({ markdown, title }) => ({
    url: URL.createObjectURL(await docxBlob(null, { markdown, title })),
  }),
  'blob:revoke': ({ url }) => {
    URL.revokeObjectURL(url);
    return null;
  },

  'folder:prepare': async ({ folderPath, overwrite }) => {
    const target = await openFolder();
    return {
      folder: target.name,
      folderPath: overwrite ? folderPath : await target.freePath(folderPath, 'folder'),
    };
  },
  'folder:write': async ({ path, source }) => {
    const target = await folder();
    return attempt(async () => target.write(path, await forWrite(path, source)));
  },
  'folder:remove': async ({ path }) => {
    const target = await folder();
    return attempt(() => target.remove(path));
  },

  'zip:open': () => ({ id: archives.openArchive() }),
  'zip:add': async ({
    id,
    path,
    source,
  }: {
    id: string;
    path: string;
    source: TransferableSource;
  }) => {
    const zip = archives.get(id);
    const reply = await attempt(async () =>
      zip.add(path, await sourceBlob(await forWrite(path, source))),
    );
    return reply.ok ? { ok: true as const, size: zip.size } : reply;
  },
  // The same blob URL for a repeated close: the worker may have missed the first answer.
  // A new URL for each close: the worker revokes one after downloading it.
  'zip:close-to-url': async ({ id }) => ({ url: URL.createObjectURL(await archives.close(id)) }),
  'zip:close-to-folder': ({ id, path, overwrite }) => {
    // Written once: a repeated close gets the same file, not `name (2).zip`.
    let written = folderCloses.get(id);
    if (!written) {
      written = (async () => {
        const blob = await archives.close(id);
        const target = await openFolder();
        const free = overwrite ? path : await target.freePath(path, 'file');
        await target.write(free, { kind: 'blob', blob });
        return { folder: target.name, path: free };
      })();
      folderCloses.set(id, written);
      written.catch(() => folderCloses.delete(id));
    }
    return written;
  },
  'zip:discard': ({ id }) => {
    archives.discard(id);
    return null;
  },
});
