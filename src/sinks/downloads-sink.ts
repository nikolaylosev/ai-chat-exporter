import type { DownloadRequest, DownloadResult } from '../background/downloader';
import type { SavedLocation } from '../shared/messages';
import { textMime, type ExportSink, type FileSource } from './types';

export interface DownloadsSinkDeps {
  download(request: DownloadRequest): Promise<DownloadResult>;
  createBlobUrl(text: string, mime: string): Promise<string>;
  revokeBlobUrl(url: string): Promise<void>;
  /**
   * Picks a conversation folder (relative to Downloads) the extension has not issued
   * yet, from the export registry; with `reuse`, keeps the path as it is.
   */
  reserveFolder?(path: string, reuse: boolean): Promise<string>;
  /** Deletes a file this extension downloaded to `path` (relative to Downloads). */
  removeDownloaded?(path: string): Promise<void>;
}

export interface DownloadsSinkOptions {
  /** Export root as sanitized segments relative to Downloads; empty means the Downloads root. */
  root: readonly string[];
  conflictAction: DownloadRequest['conflictAction'];
}

/**
 * Version 1.0 sink: writes through chrome.downloads into the Downloads folder.
 * Runs in the service worker. Generated text goes through a blob URL made by the
 * offscreen document, because the service worker cannot create blob URLs.
 */
export class DownloadsSink implements ExportSink {
  readonly id = 'downloads';
  /** Set when any write looked like it hit a Save As dialog. */
  saveDialogSuspected = false;
  /** Where the last file went when Chrome asked and the user chose another place. */
  private movedTo: string | null = null;

  constructor(
    private readonly deps: DownloadsSinkDeps,
    private readonly options: DownloadsSinkOptions,
  ) {}

  /** Path relative to Downloads for a path relative to the export root. */
  resolve(path: string): string {
    return [...this.options.root, path].join('/');
  }

  async removeFile(path: string): Promise<void> {
    await this.deps.removeDownloaded?.(this.resolve(path));
  }

  /** `Chat (2)` when `Chat` was issued before: Chrome would otherwise rename files, not the folder. */
  async prepareFolder(folderPath: string): Promise<string> {
    if (!this.deps.reserveFolder) return folderPath;
    const prefix = this.options.root.length ? `${this.options.root.join('/')}/` : '';
    const reuse = this.options.conflictAction === 'overwrite';
    const reserved = await this.deps.reserveFolder(prefix + folderPath, reuse);
    return reserved.slice(prefix.length);
  }

  writeText(path: string, content: string): Promise<void> {
    return this.writeFile(path, { kind: 'text', text: content, mime: textMime(path) });
  }

  async writeFile(path: string, source: FileSource): Promise<void> {
    switch (source.kind) {
      case 'url':
        return this.download(path, source.url);
      case 'text': {
        // Chrome changes a file's extension to match a known MIME type (a .jsx served as
        // text/plain is saved as .txt). A neutral type keeps the name we chose.
        const url = await this.deps.createBlobUrl(source.text, NEUTRAL_MIME);
        try {
          return await this.download(path, url);
        } finally {
          await this.deps.revokeBlobUrl(url);
        }
      }
      case 'blob':
        throw new Error('DownloadsSink cannot write a Blob: pass a URL or text instead');
    }
  }

  finish(markdownPath: string): Promise<SavedLocation> {
    return Promise.resolve(
      this.movedTo
        ? { kind: 'absolute', path: this.movedTo }
        : { kind: 'downloads', path: this.resolve(markdownPath) },
    );
  }

  private async download(path: string, url: string): Promise<void> {
    const result = await this.deps.download({
      url,
      filename: this.resolve(path),
      conflictAction: this.options.conflictAction,
    });
    this.movedTo = result.saveDialogSuspected ? result.finalPath : null;
    if (result.saveDialogSuspected) this.saveDialogSuspected = true;
  }
}

const NEUTRAL_MIME = 'application/octet-stream';
