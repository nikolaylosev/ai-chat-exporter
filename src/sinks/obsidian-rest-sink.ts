import type { ObsidianRest } from '../obsidian/rest';
import type { SavedLocation } from '../shared/messages';
import type { FetchLike } from '../util/http';
import { sourceBlob } from './source';
import { textMime, type FileSource } from './types';

/**
 * Writes into a vault through the Local REST API plugin, from the service worker:
 * a chat's files are fetched there with the user's cookies (the extension has
 * host permission for the platforms) and sent on as they are.
 */
export class ObsidianRestSink {
  readonly id = 'obsidian';
  /** Obsidian writes each file itself; a few at a time keep it responsive. */
  readonly fileConcurrency = 2;

  constructor(
    private readonly rest: ObsidianRest,
    private readonly fetchFn: FetchLike = (input, init) => fetch(input, init),
  ) {}

  writeText(path: string, content: string): Promise<void> {
    return this.rest.write(path, new Blob([content], { type: textMime(path) }));
  }

  async writeFile(path: string, source: FileSource): Promise<void> {
    await this.rest.write(path, await sourceBlob(source, this.fetchFn));
  }

  removeFile(path: string): Promise<void> {
    return this.rest.remove(path);
  }

  readText(path: string): Promise<string | null> {
    return this.rest.readText(path);
  }

  finish(markdownPath: string): Promise<SavedLocation> {
    return Promise.resolve({ kind: 'obsidian', path: markdownPath });
  }
}
