import { useEffect, useState } from 'preact/hooks';
import { codeText, errorText } from '../shared/error-text';
import type { ErrorCode } from '../shared/errors';
import { t } from '../shared/i18n';
import { JOB_KEY, type JobState } from '../shared/job';
import { locationLabel } from '../shared/location';
import { send, type ExportResult, type FileFailure, type JobStartItem } from '../shared/messages';
import type { Platform } from '../shared/platform';
import { loadSettings, saveSettings, type Settings } from '../shared/settings';
import { loadFolderHandle, requestFolderAccess } from '../sinks/folder-handle';

export const EXPORT_COMMAND = 'export-current-chat';

export function openShortcutSettings(): void {
  void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
}

/** Current key binding of the export command; '' when the user removed it, undefined while loading. */
export function useShortcut(): string | undefined {
  const [shortcut, setShortcut] = useState<string | undefined>(undefined);
  useEffect(() => {
    const load = () =>
      void chrome.commands
        .getAll()
        .then((commands) =>
          setShortcut(commands.find((c) => c.name === EXPORT_COMMAND)?.shortcut ?? ''),
        );
    load();
    // The user changes the binding in chrome://extensions/shortcuts and comes back.
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);
  return shortcut;
}

export const EXPORT_PAGE = 'src/ui/export-page/index.html';

/** Opens the export page; `projects` opens that tab. */
export function openExportPage(options: { projects?: boolean; platform?: Platform } = {}): void {
  const query = new URLSearchParams();
  if (options.platform && options.platform !== 'claude') query.set('platform', options.platform);
  if (options.projects) query.set('tab', 'projects');
  const search = query.size ? `?${query.toString()}` : '';
  void chrome.tabs.create({ url: chrome.runtime.getURL(`${EXPORT_PAGE}${search}`) });
}

/** Starts a job after asking for folder access where needed; returns an error message or null. */
export async function startExportJob(
  settings: Settings,
  items: JobStartItem[],
  platform: Platform = 'claude',
): Promise<string | null> {
  if (settings.destination === 'folder') {
    const code = await ensureFolderAccess();
    if (code) return codeText(code);
  }
  try {
    await send('background', 'job:start', { platform, items });
    return null;
  } catch (error) {
    return errorText(error);
  }
}

export { errorText };

/** Settings plus a setter that saves a change and updates the view. */
export function useSettings(): [Settings | null, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    void loadSettings().then(setSettings);
  }, []);
  const update = (patch: Partial<Settings>) => {
    void saveSettings(patch).then(setSettings);
  };
  return [settings, update];
}

/** The bulk export job, kept up to date from chrome.storage.session. */
export function useJob(): JobState | null | undefined {
  const [job, setJob] = useState<JobState | null | undefined>(undefined);
  useEffect(() => {
    void chrome.storage.session
      .get(JOB_KEY)
      .then((data) => setJob((data[JOB_KEY] as JobState | undefined) ?? null));
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && JOB_KEY in changes) {
        setJob((changes[JOB_KEY]?.newValue as JobState | undefined) ?? null);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);
  return job;
}

/**
 * Write access to the chosen folder must be granted from a click, so pages ask
 * here before an export starts; the service worker cannot ask.
 */
export async function ensureFolderAccess(): Promise<ErrorCode | null> {
  let access;
  try {
    access = await requestFolderAccess(await loadFolderHandle());
  } catch {
    access = 'prompt';
  }
  if (access === 'granted') return null;
  return access === 'not-chosen' ? 'folder-not-chosen' : 'folder-permission';
}

/** Stops that are the user's own doing (a cancelled dialog or download): shown in grey. */
const QUIET = new Set<string>(['save-cancelled', 'save-dialog', 'download-cancelled']);

/** One chat's export result: what was saved and where, or why not. */
export function ExportResultView({ result }: { result: ExportResult }) {
  return (
    <>
      {result.ok ? (
        <p class={`result ${result.failedAttachmentCount ? 'warn' : 'ok'}`}>
          {result.failedAttachmentCount
            ? t('popupDonePartial', [
                String(result.messageCount),
                String(result.attachmentCount),
                String(result.failedAttachmentCount),
              ])
            : t('popupDone', [String(result.messageCount), String(result.attachmentCount)])}{' '}
          {locationLabel(result.location)}
          <br />
          <span class="path">{result.location.path}</span>
        </p>
      ) : (
        <p class={`${QUIET.has(result.code) ? 'muted' : 'error'} result`}>{result.message}</p>
      )}
      {result.ok && <FailedFiles failures={result.failures} total={result.failedAttachmentCount} />}
    </>
  );
}

/** Files of a chat that were not saved: name and reason; `total` counts any left out. */
export function FailedFiles({
  failures,
  total,
}: {
  failures?: FileFailure[] | undefined;
  total?: number | undefined;
}) {
  if (!failures?.length) return null;
  const more = (total ?? failures.length) - failures.length;
  return (
    <ul class="failures">
      {failures.map((f, i) => (
        <li key={i}>
          <code>{f.name}</code>
          {f.reason ? ` — ${f.reason}` : ''}
        </li>
      ))}
      {more > 0 && <li>{t('failedFilesMore', String(more))}</li>}
    </ul>
  );
}

/** The ZIP choice: shown where an export starts, remembered for the next one and the shortcut. */
/** "Save with files": off, only the note is written, its files listed by name. */
export function FilesCheckbox({
  settings,
  update,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}) {
  return (
    <label class="check zip">
      <input
        type="checkbox"
        checked={settings.saveAttachments}
        onChange={(e) => update({ saveAttachments: e.currentTarget.checked })}
      />
      <span>{t('saveWithFiles')}</span>
    </label>
  );
}
