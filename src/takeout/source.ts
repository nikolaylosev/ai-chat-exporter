import { Unzip, UnzipInflate } from 'fflate';

/**
 * Reading Google Takeout as the user gives it: the .zip (a large one comes in
 * several parts, each a .zip of its own), the activity JSON alone, or the
 * unpacked folder. Only the entries under Gemini Apps are read, as the archive
 * is read, so a gigabyte archive is never held in memory. Nothing is sent.
 */

export type TakeoutSource =
  { kind: 'files'; files: readonly File[] } | { kind: 'folder'; handle: FileSystemDirectoryHandle };

/** Under Gemini Apps, whatever the folders are called in the account's language. */
const inGemini = (path: string) => /gemini/i.test(path);
/** The Gemini Apps activity: one record per prompt, with its chat's link. */
export const isGeminiActivity = (path: string) => /\.json$/i.test(path) && inGemini(path);

/** The file name of a path in the archive. */
export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

async function isZip(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b;
}

/** Unpacks the entries `want` picks as the .zip is read; `onEntry` gets each one whole. */
export async function readZip(
  file: Blob,
  want: (path: string) => boolean,
  onEntry: (path: string, bytes: Uint8Array) => void | Promise<void>,
): Promise<void> {
  const pending: Promise<void>[] = [];
  const unzip = new Unzip((entry) => {
    if (!want(entry.name)) return;
    pending.push(
      new Promise((resolve, reject) => {
        const parts: Uint8Array[] = [];
        entry.ondata = (error, data, final) => {
          if (error) return reject(error);
          parts.push(data);
          if (final) Promise.resolve(onEntry(entry.name, join(parts))).then(resolve, reject);
        };
        entry.start();
      }),
    );
  });
  unzip.register(UnzipInflate);
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    unzip.push(value);
  }
  unzip.push(new Uint8Array(0), true);
  await Promise.all(pending);
}

function join(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return all;
}

/** Every file of an unpacked folder, with its path from the folder. */
async function* walk(
  dir: FileSystemDirectoryHandle,
  prefix = '',
): AsyncGenerator<{ path: string; handle: FileSystemFileHandle }> {
  for await (const entry of dir.values()) {
    if (entry.name.startsWith('.')) continue;
    const path = `${prefix}${entry.name}`;
    if (entry.kind === 'directory') yield* walk(entry, `${path}/`);
    else yield { path, handle: entry };
  }
}

/** Reads the entries `want` picks from every part of the source. */
export async function readTakeoutEntries(
  source: TakeoutSource,
  want: (path: string) => boolean,
  onEntry: (path: string, bytes: Uint8Array) => void | Promise<void>,
): Promise<void> {
  if (source.kind === 'folder') {
    // From the folder's own name: it may be Gemini Apps itself.
    for await (const { path, handle } of walk(source.handle, `${source.handle.name}/`)) {
      if (!want(path)) continue;
      await onEntry(path, new Uint8Array(await (await handle.getFile()).arrayBuffer()));
    }
    return;
  }
  for (const file of source.files) {
    if (await isZip(file)) await readZip(file, want, onEntry);
    // The activity file picked on its own.
    else if (want(`Gemini/${file.name}`)) {
      await onEntry(file.name, new Uint8Array(await file.arrayBuffer()));
    }
  }
}

/** The parsed activity files of the source; anything that is not JSON is left out. */
export async function readActivity(source: TakeoutSource): Promise<unknown[]> {
  const found: unknown[] = [];
  await readTakeoutEntries(source, isGeminiActivity, (_path, bytes) => {
    try {
      found.push(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      // Not an activity file.
    }
  });
  return found;
}

/** The files Takeout keeps beside the activity, by name: `name` picks which. */
export function readTakeoutFiles(
  source: TakeoutSource,
  want: (name: string) => boolean,
  onFile: (name: string, bytes: Uint8Array) => void | Promise<void>,
): Promise<void> {
  return readTakeoutEntries(
    source,
    (path) => inGemini(path) && !isGeminiActivity(path) && want(baseName(path)),
    (path, bytes) => onFile(baseName(path), bytes),
  );
}
