import { CodedError } from '../shared/errors';
import { ZipBuilder } from '../sinks/zip-builder';

/** Closed archives kept for a repeated close; a few parts at most are in flight. */
const KEEP_CLOSED = 4;

/**
 * Archives being built in the offscreen document, by id.
 *
 * Closing is safe to repeat. The service worker waits for the archive and then
 * downloads it; if Chrome stops the worker in between, the restarted worker
 * closes the same archive again. Answering "no archive" then made the queue
 * export the whole part again (seen on 2026-10-15 at the end of a Grok export),
 * so a closed archive is kept and a repeated close gets the same file.
 *
 * An archive that is neither open nor recently closed is gone (the document was
 * closed and created again: the extension was reloaded, or its process ran out
 * of memory): `archive-lost`, and the queue starts a new part.
 */
export class ArchiveStore {
  private readonly open = new Map<string, ZipBuilder>();
  private readonly closed = new Map<string, Promise<Blob>>();

  constructor(
    private readonly create: () => ZipBuilder = () => new ZipBuilder(),
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  openArchive(): string {
    const id = this.newId();
    this.open.set(id, this.create());
    return id;
  }

  get(id: string): ZipBuilder {
    const zip = this.open.get(id);
    if (!zip) throw new CodedError('archive-lost', `No archive ${id}`);
    return zip;
  }

  /** The finished archive; a repeated close gets the same one. */
  close(id: string): Promise<Blob> {
    const done = this.closed.get(id);
    if (done) return done;
    const zip = this.get(id);
    this.open.delete(id);
    const blob = zip.finish();
    this.closed.set(id, blob);
    // A failed close is not kept: the next try finds no archive, as before.
    blob.catch(() => this.closed.delete(id));
    while (this.closed.size > KEEP_CLOSED) {
      const oldest = this.closed.keys().next().value;
      if (oldest === undefined) break;
      this.closed.delete(oldest);
    }
    return blob;
  }

  discard(id: string): void {
    this.open.get(id)?.abort();
    this.open.delete(id);
    this.closed.delete(id);
  }
}
