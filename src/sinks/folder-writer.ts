import { CodedError } from '../shared/errors';
import type { FetchLike } from '../util/http';
import { splitExtension } from '../util/filename';
import { sourceBlob } from './source';
import type { FileSource } from './types';

/**
 * Writes files into the folder the user picked, through the File System Access
 * API. Runs in an extension page (the offscreen document): writing needs a
 * window, and no Save As dialog is ever shown.
 */
export class FolderWriter {
  constructor(
    private readonly root: FileSystemDirectoryHandle,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  get name(): string {
    return this.root.name;
  }

  async exists(path: string): Promise<boolean> {
    const segments = path.split('/');
    const name = segments.pop() ?? '';
    const dir = await this.directory(segments, false).catch(ignoreNotFound);
    if (!dir) return false;
    try {
      await dir.getFileHandle(name);
      return true;
    } catch (error) {
      // A folder with that name.
      if (error instanceof DOMException && error.name === 'TypeMismatchError') return true;
      return ignoreNotFound(error) ?? false;
    }
  }

  /**
   * The path itself when nothing is there yet, else the first free `name (2)`,
   * `name (3)`, ... A folder keeps dots in its name; a file keeps its extension.
   */
  async freePath(path: string, kind: 'file' | 'folder'): Promise<string> {
    if (!(await this.exists(path))) return path;
    const slash = path.lastIndexOf('/');
    const dir = path.slice(0, slash + 1);
    const name = path.slice(slash + 1);
    const { base, ext } = kind === 'file' ? splitExtension(name) : { base: name, ext: '' };
    for (let n = 2; ; n++) {
      const candidate = `${dir}${base} (${n})${ext}`;
      if (!(await this.exists(candidate))) return candidate;
    }
  }

  async write(path: string, source: FileSource): Promise<void> {
    const blob = await sourceBlob(source, this.fetchFn);
    const segments = path.split('/');
    const name = segments.pop() ?? '';
    const dir = await this.directory(segments, true);
    const file = await dir.getFileHandle(name, { create: true });
    // A new writable starts empty, so an existing file is replaced, not appended to.
    const writable = await file.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
  }

  /** Deletes a file; one that is not there is fine. */
  async remove(path: string): Promise<void> {
    const segments = path.split('/');
    const name = segments.pop() ?? '';
    const dir = await this.directory(segments, false).catch(ignoreNotFound);
    await dir?.removeEntry(name).catch(ignoreNotFound);
  }

  private async directory(segments: string[], create: boolean) {
    let dir = this.root;
    for (const segment of segments) {
      if (segment) dir = await dir.getDirectoryHandle(segment, { create });
    }
    return dir;
  }
}

function ignoreNotFound(error: unknown): undefined {
  if (error instanceof DOMException && error.name === 'NotFoundError') return undefined;
  throw error;
}

/**
 * Problems with the whole folder rather than one file: write access was taken
 * away, or the folder was deleted or moved. They stop the export.
 */
export async function checkFolder(root: FileSystemDirectoryHandle): Promise<void> {
  const access = await root.queryPermission({ mode: 'readwrite' });
  if (access !== 'granted') {
    throw new CodedError('folder-permission', `No write access to ${root.name}: ${access}`);
  }
  try {
    await root.keys().next();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      throw new CodedError('folder-missing', `Folder ${root.name} is not available`);
    }
    throw error;
  }
}
