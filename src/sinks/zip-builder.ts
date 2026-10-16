import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { splitExtension } from '../util/filename';

/** Formats that are already compressed: stored as they are, which is faster and no larger. */
const STORED = new Set([
  ...['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.heic'],
  ...['.mp3', '.m4a', '.mp4', '.mov', '.webm', '.ogg'],
  ...['.zip', '.gz', '.tgz', '.7z', '.rar', '.bz2', '.xz'],
  ...['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.epub', '.pdf', '.woff', '.woff2'],
]);

export function shouldCompress(path: string): boolean {
  return !STORED.has(splitExtension(path.slice(path.lastIndexOf('/') + 1)).ext.toLowerCase());
}

/**
 * Builds a ZIP archive as files arrive. Output chunks become Blobs right away,
 * so Chrome can keep a large archive on disk instead of in memory. File names are
 * stored as UTF-8 with the flag set, so non-Latin names open correctly.
 */
export class ZipBuilder {
  private readonly parts: Blob[] = [];
  private readonly zip: Zip;
  private readonly result: Promise<Blob>;
  private queue: Promise<void> = Promise.resolve();
  /** Bytes of archive output so far. */
  size = 0;

  constructor() {
    let resolve!: (blob: Blob) => void;
    let reject!: (error: Error) => void;
    this.result = new Promise<Blob>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // The archive is only read once finish() is called; avoid an unhandled rejection before that.
    this.result.catch(() => undefined);
    this.zip = new Zip((error, chunk, final) => {
      if (error) return reject(error);
      this.parts.push(new Blob([chunk]));
      this.size += chunk.length;
      if (final) resolve(new Blob(this.parts, { type: 'application/zip' }));
    });
  }

  /** Adds a file. Calls are queued, so entries keep the order they were added in. */
  add(path: string, data: Blob): Promise<void> {
    const next = this.queue.then(async () => {
      const bytes = new Uint8Array(await data.arrayBuffer());
      const entry = shouldCompress(path)
        ? new ZipDeflate(path, { level: 6 })
        : new ZipPassThrough(path);
      this.zip.add(entry);
      entry.push(bytes, true);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async finish(): Promise<Blob> {
    await this.queue;
    this.zip.end();
    return this.result;
  }

  abort(): void {
    this.zip.terminate();
  }
}
