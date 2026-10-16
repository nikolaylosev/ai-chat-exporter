import {
  DownloadInterruptedError,
  type DownloadRequest,
  type DownloadResult,
} from '../background/downloader';
import { CodedError } from '../shared/errors';
import type { SavedLocation, WriteReply } from '../shared/messages';
import { FileWriteError, type TransferableSource } from './source';
import type { FileSource } from './types';

/** What the service worker asks of the offscreen document (see offscreen-client.ts). */
export interface OffscreenFiles {
  prepareFolder(
    folderPath: string,
    overwrite: boolean,
  ): Promise<{ folder: string; folderPath: string }>;
  writeToFolder(path: string, source: TransferableSource): Promise<WriteReply>;
  removeFromFolder(path: string): Promise<WriteReply>;
  openZip(): Promise<string>;
  addToZip(id: string, path: string, source: TransferableSource): Promise<WriteReply>;
  closeZipToUrl(id: string): Promise<string>;
  closeZipToFolder(
    id: string,
    path: string,
    overwrite: boolean,
  ): Promise<{ folder: string; path: string }>;
  discardZip(id: string): Promise<void>;
  revokeBlobUrl(url: string): Promise<void>;
}

function transferable(source: FileSource): TransferableSource {
  if (source.kind === 'blob') throw new Error('A Blob cannot be sent to the offscreen document');
  return source;
}

function check(reply: WriteReply): void {
  if (!reply.ok) throw new FileWriteError(reply.reason);
}

/** Writes into the folder the user picked. No Save As dialog, whatever Chrome's settings. */
export class FolderSink {
  readonly id = 'folder';
  private folder = '';

  constructor(
    private readonly api: OffscreenFiles,
    private readonly overwrite: boolean,
  ) {}

  async prepareFolder(folderPath: string): Promise<string> {
    const prepared = await this.api.prepareFolder(folderPath, this.overwrite);
    this.folder = prepared.folder;
    return prepared.folderPath;
  }

  writeText(path: string, content: string): Promise<void> {
    return this.writeFile(path, { kind: 'text', text: content, mime: 'text/markdown' });
  }

  async writeFile(path: string, source: FileSource): Promise<void> {
    check(await this.api.writeToFolder(path, transferable(source)));
  }

  async removeFile(path: string): Promise<void> {
    check(await this.api.removeFromFolder(path));
  }

  finish(markdownPath: string): Promise<SavedLocation> {
    return Promise.resolve({ kind: 'folder', folder: this.folder, path: markdownPath });
  }
}

export type ZipTarget =
  | {
      kind: 'downloads';
      /** Export root relative to Downloads. */
      root: readonly string[];
      conflictAction: DownloadRequest['conflictAction'];
      download(request: DownloadRequest): Promise<DownloadResult>;
    }
  | { kind: 'folder'; overwrite: boolean };

/**
 * One ZIP archive built in the offscreen document. Saved with a single download
 * (one Save As dialog at most) or into the chosen folder.
 */
export interface ZipArchiveState {
  /** null between two parts of a split archive. */
  zipId: string | null;
  name: string;
  folders: string[];
}

export class ZipArchive {
  private zipId: string | null = null;
  /** Conversation folders already in the archive (all its parts), lower-cased. */
  private readonly folders = new Set<string>();
  /** Folders reserved since the last takeReserved(): the conversation being exported. */
  private reserved: string[] = [];
  /** Bytes of the open part so far. */
  private bytes = 0;

  constructor(
    private readonly api: OffscreenFiles,
    private readonly target: ZipTarget,
    /** File name, e.g. `Chat - 2026-10-13 (Claude).zip`. */
    public name = '',
    /** An archive a restarted service worker picks up: it lives on in the offscreen document. */
    restored?: ZipArchiveState,
  ) {
    if (restored) {
      this.zipId = restored.zipId;
      this.name = restored.name;
      for (const folder of restored.folders) this.folders.add(folder);
    }
  }

  /** What a restarted service worker needs to go on with this archive. */
  snapshot(): ZipArchiveState {
    return { zipId: this.zipId, name: this.name, folders: [...this.folders] };
  }

  /** Size of the open part, as reported after the last file. */
  get size(): number {
    return this.bytes;
  }

  /** Folders the current conversation took, so they can be given back if its part is lost. */
  takeReserved(): string[] {
    const taken = this.reserved;
    this.reserved = [];
    return taken;
  }

  release(folders: readonly string[]): void {
    for (const folder of folders) this.folders.delete(folder);
  }

  /**
   * Forgets an open part that the offscreen document no longer has. The next
   * file starts a new part under the same name: nothing of the old one was saved.
   */
  reset(): void {
    this.zipId = null;
    this.bytes = 0;
    this.reserved = [];
  }

  get isOpen(): boolean {
    return this.zipId !== null;
  }

  async open(): Promise<void> {
    if (this.zipId === null) this.zipId = await this.api.openZip();
  }

  /** A folder name not used in this archive yet: `Chat`, `Chat (2)`, ... */
  reserveFolder(folderPath: string): string {
    let candidate = folderPath;
    for (let n = 2; this.folders.has(candidate.toLowerCase()); n++) {
      candidate = `${folderPath} (${n})`;
    }
    this.folders.add(candidate.toLowerCase());
    this.reserved.push(candidate.toLowerCase());
    return candidate;
  }

  async add(path: string, source: FileSource): Promise<void> {
    const reply = await this.api.addToZip(this.openId(), path, transferable(source));
    check(reply);
    if (reply.ok && reply.size !== undefined) this.bytes = reply.size;
  }

  async close(): Promise<SavedLocation> {
    const id = this.openId();
    this.zipId = null;
    this.bytes = 0;
    if (this.target.kind === 'folder') {
      const saved = await this.api.closeZipToFolder(id, this.name, this.target.overwrite);
      return { kind: 'folder', folder: saved.folder, path: saved.path };
    }

    const { root, conflictAction } = this.target;
    const url = await this.api.closeZipToUrl(id);
    const filename = [...root, this.name].join('/');
    try {
      const result = await this.target.download({ url, filename, conflictAction });
      // Chrome may add ` (1)`; with a Save As dialog the user may pick another folder.
      if (result.saveDialogSuspected) return { kind: 'absolute', path: result.finalPath };
      const saved = result.finalPath.slice(
        result.finalPath.replace(/\\/g, '/').lastIndexOf('/') + 1,
      );
      return { kind: 'downloads', path: [...root, saved].join('/') };
    } catch (error) {
      if (error instanceof DownloadInterruptedError && error.reason === 'USER_CANCELED') {
        throw new CodedError('save-cancelled', 'The user cancelled saving the archive');
      }
      throw error;
    } finally {
      await this.api.revokeBlobUrl(url);
    }
  }

  async discard(): Promise<void> {
    if (this.zipId === null) return;
    const id = this.zipId;
    this.zipId = null;
    await this.api.discardZip(id);
  }

  private openId(): string {
    if (this.zipId === null) throw new Error('The archive is not open');
    return this.zipId;
  }
}

/**
 * Writes one conversation into a ZIP archive. On its own, the archive is named
 * after the conversation folder and closed when the conversation is done. In a
 * bulk export, many conversations share one archive that the job closes.
 * Entries keep their paths, so unpacking gives the usual folders.
 */
export class ZipSink {
  readonly id = 'zip';
  private readonly archive: ZipArchive;
  private readonly own: boolean;

  constructor(api: OffscreenFiles, target: ZipTarget);
  constructor(archive: ZipArchive);
  constructor(source: OffscreenFiles | ZipArchive, target?: ZipTarget) {
    this.own = !(source instanceof ZipArchive);
    this.archive = source instanceof ZipArchive ? source : new ZipArchive(source, target!);
  }

  async prepareFolder(folderPath: string): Promise<string> {
    if (this.own) this.archive.name = `${folderPath.slice(folderPath.lastIndexOf('/') + 1)}.zip`;
    await this.archive.open();
    return this.own ? folderPath : this.archive.reserveFolder(folderPath);
  }

  writeText(path: string, content: string): Promise<void> {
    return this.writeFile(path, { kind: 'text', text: content, mime: 'text/markdown' });
  }

  writeFile(path: string, source: FileSource): Promise<void> {
    return this.archive.add(path, source);
  }

  finish(markdownPath: string): Promise<SavedLocation> {
    if (this.own) return this.archive.close();
    return Promise.resolve({ kind: 'archive', archive: this.archive.name, path: markdownPath });
  }

  /** Drops the archive only when it belongs to this conversation alone. */
  async abort(): Promise<void> {
    if (this.own) await this.archive.discard();
  }
}
