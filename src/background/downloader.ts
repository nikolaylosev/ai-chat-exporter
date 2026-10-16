import { log } from '../shared/logger';

export interface DownloadRequest {
  url: string;
  /** Path relative to Downloads, with `/` separators. */
  filename: string;
  conflictAction: 'uniquify' | 'overwrite';
}

export interface DownloadResult {
  /** Absolute path where Chrome saved the file. */
  finalPath: string;
  /**
   * The file did not land where we asked, or Chrome waited for the user to pick a
   * location. Both mean "Ask where to save each file" is probably on.
   */
  saveDialogSuspected: boolean;
}

/** How long a download may sit without a target path before we suspect a Save As dialog. */
const DIALOG_TIMEOUT_MS = 5000;

export class DownloadInterruptedError extends Error {
  /** chrome.downloads.InterruptReason, e.g. `NETWORK_FAILED` or `USER_CANCELED`. */
  readonly reason: string;
  /**
   * The user cancelled the download. Our downloads never show UI of their own, so a
   * cancellation almost always means a Save As dialog was shown and dismissed.
   */
  readonly saveDialogSuspected: boolean;

  constructor(
    reason: string,
    /** The interrupted item, to clear before trying again. */
    readonly downloadId?: number,
  ) {
    super(`Download interrupted: ${reason}`);
    this.name = 'DownloadInterruptedError';
    this.reason = reason;
    this.saveDialogSuspected = reason === 'USER_CANCELED';
  }
}

/**
 * Checks that Chrome saved the file at the requested relative path. With
 * `uniquify`, Chrome may append ` (1)` before the extension, which still counts.
 */
export function isExpectedLocation(finalPath: string, requested: string): boolean {
  const normalize = (p: string) => p.normalize('NFC').replace(/\\/g, '/');
  const actual = normalize(finalPath);
  const expected = normalize(requested);
  if (actual.endsWith(`/${expected}`)) return true;

  const slash = expected.lastIndexOf('/');
  const dir = expected.slice(0, slash + 1);
  const name = expected.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const uniquified = new RegExp(`/${escape(dir + base)} \\(\\d+\\)${escape(ext)}$`);
  return uniquified.test(actual);
}

/**
 * Chrome changed only the extension, in the requested folder. It does that when a
 * file comes without Content-Disposition and its type or content says text: a
 * `.xlsx` sniffed as text/plain is saved as `.txt`. That is not a Save As dialog.
 * claude.ai serves files with Content-Disposition, so it should not happen there;
 * an onDeterminingFilename suggestion does not prevent it (checked in Chrome for
 * Testing 1248).
 */
export function isExtensionChangedOnly(finalPath: string, requested: string): boolean {
  const normalize = (p: string) => p.normalize('NFC').replace(/\\/g, '/');
  const stem = (p: string) => {
    const slash = p.lastIndexOf('/');
    const dot = p.lastIndexOf('.');
    return dot > slash + 1 ? p.slice(0, dot) : p;
  };
  const actual = normalize(finalPath);
  const expected = normalize(requested);
  return !actual.endsWith(`/${expected}`) && stem(actual).endsWith(`/${stem(expected)}`);
}

interface StoredTargets {
  byUrl: Record<string, DownloadRequest>;
  byId: Record<string, DownloadRequest>;
}

export interface TargetStore {
  load(): Promise<StoredTargets | undefined>;
  save(data: StoredTargets): Promise<void>;
}

const TARGETS_KEY = 'downloadTargets';

const sessionTargetStore: TargetStore = {
  load: async () => (await chrome.storage.session.get(TARGETS_KEY))[TARGETS_KEY] as StoredTargets,
  save: (data) => chrome.storage.session.set({ [TARGETS_KEY]: data }),
};

/** Entries kept at most; one left behind by a stopped worker must not pile up. */
const MAX_TARGETS = 50;

/**
 * Where each of our downloads should go, by URL until Chrome gives it an id.
 * When Chrome resumes a download after a dropped connection it picks the file
 * name again and forgets the one we asked for (`content`, from the URL; seen in
 * Chrome for Testing 1248), unless an onDeterminingFilename listener names it.
 * The list is mirrored into `chrome.storage.session`, so a worker that Chrome
 * stopped and started again still knows the names of downloads in progress.
 */
export class DownloadTargets {
  private readonly byUrl = new Map<string, DownloadRequest>();
  private readonly byId = new Map<number, DownloadRequest>();
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly store: TargetStore) {}

  starting(request: DownloadRequest): void {
    this.byUrl.set(request.url, request);
    this.persist();
  }

  started(id: number, request: DownloadRequest): void {
    this.byId.set(id, request);
    this.persist();
  }

  finished(url: string, id: number | undefined): void {
    this.byUrl.delete(url);
    if (id !== undefined) this.byId.delete(id);
    this.persist();
  }

  /** The request behind a download, from memory; `ours` when this extension started it. */
  known(id: number, url: string, ours: boolean): DownloadRequest | undefined {
    const request = this.byId.get(id) ?? (ours ? this.byUrl.get(url) : undefined);
    if (request && !this.byId.has(id)) this.started(id, request);
    return request;
  }

  /** The same after a worker restart: memory is empty, the stored copy is not. */
  async recall(id: number, url: string): Promise<DownloadRequest | undefined> {
    await this.writes;
    const stored = await this.store.load().catch(() => undefined);
    const request = stored?.byId[String(id)] ?? stored?.byUrl[url];
    if (request) this.started(id, request);
    return request;
  }

  private persist(): void {
    for (const map of [this.byUrl, this.byId] as Map<unknown, DownloadRequest>[]) {
      while (map.size > MAX_TARGETS) map.delete(map.keys().next().value);
    }
    const data: StoredTargets = {
      byUrl: Object.fromEntries(this.byUrl),
      byId: Object.fromEntries([...this.byId].map(([id, request]) => [String(id), request])),
    };
    this.writes = this.writes.then(() => this.store.save(data)).catch(() => undefined);
  }
}

const targets = new DownloadTargets(sessionTargetStore);

/** Names the file again whenever Chrome asks, for downloads this extension started. */
export function keepDownloadNames(): void {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const ours = item.byExtensionId === chrome.runtime.id;
    const name = (request: DownloadRequest | undefined) =>
      request
        ? suggest({ filename: request.filename, conflictAction: request.conflictAction })
        : suggest();
    const request = targets.known(item.id, item.url, ours);
    if (request || !ours) {
      name(request);
      return;
    }
    // Ours, but this worker did not start it: look in the stored copy, then answer.
    void targets.recall(item.id, item.url).then(name, () => suggest());
    return true;
  });
}

async function findItem(id: number): Promise<chrome.downloads.DownloadItem | undefined> {
  const [item] = await chrome.downloads.search({ id });
  return item;
}

/**
 * Starts a download and resolves when it completes. Rejects with
 * DownloadInterruptedError when Chrome interrupts it (network error, the user
 * cancelled a Save As dialog, and so on).
 *
 * `saveAs: false` does not stop Chrome from showing the dialog when the user has
 * "Ask where to save each file" turned on (checked in Chrome for Testing 1248).
 */
export function downloadAndWait(
  request: DownloadRequest,
  onSaveDialogSuspected?: () => void,
): Promise<DownloadResult> {
  return new Promise((resolve, reject) => {
    let downloadId: number | undefined;
    let dialogSuspected = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error: Error | null, item?: chrome.downloads.DownloadItem) => {
      if (settled) return;
      settled = true;
      targets.finished(request.url, downloadId);
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      if (error || !item) {
        reject(error ?? new Error('Download disappeared'));
        return;
      }
      const renamed = isExtensionChangedOnly(item.filename, request.filename);
      const misplaced = !isExpectedLocation(item.filename, request.filename) && !renamed;
      if (renamed) log.warn('Chrome changed the file extension', item.filename);
      if (misplaced) log.warn('File saved outside the expected path', item.filename);
      resolve({ finalPath: item.filename, saveDialogSuspected: dialogSuspected || misplaced });
    };

    const check = async () => {
      if (downloadId === undefined || settled) return;
      const item = await findItem(downloadId);
      if (!item) return finish(new Error('Download disappeared'));
      if (item.state === 'complete') return finish(null, item);
      if (item.state === 'interrupted') {
        return finish(new DownloadInterruptedError(item.error ?? 'UNKNOWN', item.id));
      }
    };

    function onChanged(delta: chrome.downloads.DownloadDelta) {
      if (delta.id === downloadId && delta.state) void check();
    }

    // Listen before starting, so a very fast download cannot complete unnoticed.
    chrome.downloads.onChanged.addListener(onChanged);
    targets.starting(request);

    chrome.downloads
      .download({
        url: request.url,
        filename: request.filename,
        conflictAction: request.conflictAction,
        saveAs: false,
      })
      .then(async (id) => {
        downloadId = id;
        targets.started(id, request);
        timer = setTimeout(() => {
          void findItem(id).then((item) => {
            // While the Save As dialog is open, the item has no target file name yet.
            if (item?.state === 'in_progress' && item.filename === '') {
              dialogSuspected = true;
              log.warn('Download is waiting for a Save As dialog');
              onSaveDialogSuspected?.();
            }
          });
        }, DIALOG_TIMEOUT_MS);
        await check();
      })
      .catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

/** Interruptions that another try may get past: the connection or the server, not the disk or the user. */
const RETRYABLE_REASON =
  /^(NETWORK_|SERVER_FAILED$|SERVER_NO_RANGE$|SERVER_CONTENT_LENGTH_MISMATCH$)/;

export interface RetryDeps {
  download?: typeof downloadAndWait;
  /** Drops an interrupted item and its partial file, so the next try gets the same name. */
  discard?: (downloadId: number) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  retries?: number;
}

async function discardDownload(downloadId: number): Promise<void> {
  await chrome.downloads.cancel(downloadId).catch(() => undefined);
  await chrome.downloads.erase({ id: downloadId }).catch(() => undefined);
}

/**
 * downloadAndWait, tried again after a network or server interruption (after
 * 1, 2 and 4 s; Chrome has usually resumed it a few times by then). Each
 * interrupted item is cancelled: that deletes its partial file, so the next try
 * keeps the name instead of becoming `name (1)`, and a file that never arrives
 * leaves nothing behind.
 */
export async function downloadWithRetry(
  request: DownloadRequest,
  onSaveDialogSuspected?: () => void,
  {
    download = downloadAndWait,
    discard = discardDownload,
    sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    retries = 3,
  }: RetryDeps = {},
): Promise<DownloadResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await download(request, onSaveDialogSuspected);
    } catch (error) {
      if (!(error instanceof DownloadInterruptedError) || !RETRYABLE_REASON.test(error.reason)) {
        throw error;
      }
      // Also after the last try: Chrome keeps a resumable partial file (`Unconfirmed
      // <n>.crdownload`) in the folder, and the report already lists the file.
      if (error.downloadId !== undefined) await discard(error.downloadId);
      if (attempt >= retries) throw error;
      log.info('Download interrupted, trying again', error.reason);
      await sleep(1000 * 2 ** attempt);
    }
  }
}

/**
 * Deletes the file this extension downloaded to `path` (relative to Downloads),
 * found in Chrome's download history; a file the history no longer knows stays.
 * The history is searched by extension only and names are compared in NFC:
 * macOS may keep a name with "й" or "ё" in another Unicode form.
 */
export async function removeDownloaded(path: string): Promise<void> {
  const nfc = (text: string) => text.normalize('NFC').replace(/\\/g, '/');
  const target = `/${nfc(path)}`;
  const extension = /\.[A-Za-z0-9]{1,10}$/.exec(path)?.[0];
  const items = await chrome.downloads.search({
    ...(extension ? { filenameRegex: `\\${extension}$` } : {}),
    state: 'complete',
    exists: true,
  });
  for (const item of items) {
    if (item.byExtensionId !== chrome.runtime.id || !nfc(item.filename).endsWith(target)) continue;
    await chrome.downloads.removeFile(item.id).catch(() => undefined);
    await chrome.downloads.erase({ id: item.id }).catch(() => undefined);
  }
}
